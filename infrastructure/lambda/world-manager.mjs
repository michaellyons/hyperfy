/**
 * WorldManager Lambda
 *
 * REST API for on-demand user world lifecycle:
 *
 *   POST   /worlds            — create / wake a user world
 *   GET    /worlds            — list all worlds for the caller
 *   GET    /worlds/:worldId   — get status + WS URL for one world
 *   DELETE /worlds/:worldId   — stop a running world (data preserved in RDS)
 *
 * Each user world is a dedicated ECS Fargate task running one Hyperfy process.
 *
 * World isolation
 * ───────────────
 *   DB       : shared Aurora cluster, schema  `world_<worldId>`
 *   Assets   : shared S3 bucket, prefix       `worlds/<worldId>/`
 *   JWT      : unique secret per world (stored in DynamoDB)
 *   WS URL   : wss://<worldId>.<DOMAIN>/ws
 *              → ALB routes to this task via a dynamically registered target group
 *
 * DynamoDB schema (table: museum-worlds)
 * ──────────────────────────────────────
 *   worldId    (PK)  string   e.g. "john" or "company-tour"
 *   ownerId          string   user id / sub from JWT
 *   status           string   STARTING | RUNNING | STOPPING | STOPPED
 *   taskArn          string   ECS task ARN (set when STARTING)
 *   taskIp           string   Fargate private IP  (set when RUNNING)
 *   wsUrl            string   public WS URL
 *   createdAt        string   ISO timestamp
 *   lastActiveAt     string   ISO timestamp  (updated by world server heartbeat)
 *   ttl              number   Unix epoch — set to lastActive + 24h for auto-cleanup
 */

import {
  ECSClient, RunTaskCommand, StopTaskCommand, DescribeTasksCommand,
} from '@aws-sdk/client-ecs';
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand,
  DeleteItemCommand, QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const ecs   = new ECSClient({});
const ddb   = new DynamoDBClient({});

const TABLE          = process.env.WORLDS_TABLE;
const CLUSTER        = process.env.CLUSTER_ARN;
const TASK_DEF       = process.env.TASK_DEFINITION_ARN;
const SUBNETS        = (process.env.SUBNETS ?? '').split(',');
const SECURITY_GROUP = process.env.SECURITY_GROUP;
const DOMAIN         = process.env.DOMAIN;
const BUCKET         = process.env.ASSETS_BUCKET;
const DB_SECRET_ARN  = process.env.DB_SECRET_ARN;
const ALB_LISTENER   = process.env.ALB_LISTENER_ARN;

const MAX_USER_WORLDS_PER_USER = 3;

// ── Main handler ──────────────────────────────────────────────────────────────
export async function handler(event) {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path   = event.path       || event.rawPath || '/';
  const segments = path.replace(/^\//, '').split('/');

  try {
    if (method === 'POST'   && segments[0] === 'worlds')               return createWorld(event);
    if (method === 'GET'    && segments[0] === 'worlds' && !segments[1]) return listWorlds(event);
    if (method === 'GET'    && segments[0] === 'worlds' && segments[1]) return getWorld(segments[1]);
    if (method === 'DELETE' && segments[0] === 'worlds' && segments[1]) return stopWorld(segments[1]);
    if (method === 'POST'   && segments[1] === 'heartbeat')             return heartbeat(segments[0]);

    return respond(404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return respond(500, { error: err.message });
  }
}

// ── POST /worlds ──────────────────────────────────────────────────────────────
async function createWorld(event) {
  const body    = JSON.parse(event.body || '{}');
  const worldId = sanitizeId(body.worldId ?? body.ownerId ?? 'my-world');
  const ownerId = body.ownerId ?? 'anonymous';

  // Validate
  if (!/^[a-z0-9-]{3,32}$/.test(worldId)) {
    return respond(400, { error: 'worldId must be 3-32 lowercase alphanumeric + hyphens' });
  }

  // Check existing
  const existing = await getWorldRecord(worldId);
  if (existing) {
    if (existing.status === 'RUNNING') {
      return respond(200, { worldId, status: 'RUNNING', wsUrl: existing.wsUrl });
    }
    if (existing.status === 'STARTING') {
      return respond(202, { worldId, status: 'STARTING', message: 'World is starting, poll /worlds/' + worldId });
    }
  }

  // Check user quota
  const userWorlds = await listWorldsForOwner(ownerId);
  if (userWorlds.length >= MAX_USER_WORLDS_PER_USER) {
    return respond(429, { error: `Max ${MAX_USER_WORLDS_PER_USER} worlds per user` });
  }

  // Spawn ECS task
  const wsUrl     = `wss://${worldId}.${DOMAIN}/ws`;
  const apiUrl    = `https://${worldId}.${DOMAIN}/api`;
  const assetsUrl = `https://${worldId}.${DOMAIN}/assets`;

  const task = await ecs.send(new RunTaskCommand({
    cluster:        CLUSTER,
    taskDefinition: TASK_DEF,
    launchType:     'FARGATE',
    count:          1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets:         SUBNETS,
        securityGroups:  [SECURITY_GROUP],
        assignPublicIp:  'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name: 'world-server',
        environment: [
          { name: 'WORLD',           value: `worlds/${worldId}` },
          { name: 'JWT_SECRET',      value: `${worldId}-${Date.now()}` },
          { name: 'ADMIN_CODE',      value: body.adminCode || '' },
          { name: 'PUBLIC_WS_URL',   value: wsUrl     },
          { name: 'PUBLIC_API_URL',  value: apiUrl    },
          { name: 'ASSETS_BASE_URL', value: assetsUrl },
          { name: 'ASSETS_S3_URI',   value: `s3://${BUCKET}/worlds/${worldId}/assets` },
          { name: 'DB_SCHEMA',       value: `world_${worldId.replace(/-/g, '_')}` },
          { name: 'DB_URI',          value: `secret:${DB_SECRET_ARN}` },
          { name: 'WORLD_ID',        value: worldId   },
          { name: 'OWNER_ID',        value: ownerId   },
          { name: 'WORLDS_TABLE',    value: TABLE     },
        ],
      }],
    },
    tags: [
      { key: 'world',    value: worldId },
      { key: 'owner',    value: ownerId },
    ],
  }));

  const taskArn = task.tasks?.[0]?.taskArn;

  // Persist to DynamoDB
  const now = new Date().toISOString();
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({
      worldId, ownerId, taskArn,
      status:       'STARTING',
      wsUrl,
      createdAt:    now,
      lastActiveAt: now,
      ttl:          Math.floor(Date.now() / 1000) + 86400,   // 24h TTL
    }),
  }));

  return respond(202, {
    worldId,
    status:  'STARTING',
    wsUrl,
    message: `World starting — poll GET /worlds/${worldId} for status`,
  });
}

// ── GET /worlds/:worldId ──────────────────────────────────────────────────────
async function getWorld(worldId) {
  const record = await getWorldRecord(worldId);
  if (!record) return respond(404, { error: 'World not found' });

  // If STARTING, check ECS task status
  if (record.status === 'STARTING' && record.taskArn) {
    const desc = await ecs.send(new DescribeTasksCommand({
      cluster: CLUSTER,
      tasks:   [record.taskArn],
    }));
    const task      = desc.tasks?.[0];
    const lastStatus = task?.lastStatus ?? 'UNKNOWN';

    if (lastStatus === 'RUNNING') {
      const ip = task?.attachments?.[0]?.details
        ?.find(d => d.name === 'privateIPv4Address')?.value;

      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key:       marshall({ worldId }),
        UpdateExpression: 'SET #s = :s, taskIp = :ip',
        ExpressionAttributeNames:  { '#s': 'status' },
        ExpressionAttributeValues: marshall({ ':s': 'RUNNING', ':ip': ip ?? '' }),
      }));
      record.status = 'RUNNING';
      record.taskIp = ip;
    } else if (['STOPPED', 'DEPROVISIONING'].includes(lastStatus)) {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key:       marshall({ worldId }),
        UpdateExpression: 'SET #s = :s',
        ExpressionAttributeNames:  { '#s': 'status' },
        ExpressionAttributeValues: marshall({ ':s': 'STOPPED' }),
      }));
      record.status = 'STOPPED';
    }
  }

  return respond(200, record);
}

// ── GET /worlds ───────────────────────────────────────────────────────────────
async function listWorlds(event) {
  const ownerId = event.queryStringParameters?.ownerId ?? 'anonymous';
  const worlds  = await listWorldsForOwner(ownerId);
  return respond(200, { worlds });
}

// ── DELETE /worlds/:worldId ───────────────────────────────────────────────────
async function stopWorld(worldId) {
  const record = await getWorldRecord(worldId);
  if (!record) return respond(404, { error: 'World not found' });

  if (record.taskArn && record.status === 'RUNNING') {
    await ecs.send(new StopTaskCommand({
      cluster: CLUSTER,
      task:    record.taskArn,
      reason:  'Stopped by user via WorldManager API',
    }));
  }

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key:       marshall({ worldId }),
    UpdateExpression: 'SET #s = :s',
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: marshall({ ':s': 'STOPPED' }),
  }));

  return respond(200, { worldId, status: 'STOPPED' });
}

// ── POST /worlds/:worldId/heartbeat ───────────────────────────────────────────
// Called by the world server every 60s to keep TTL fresh
async function heartbeat(worldId) {
  const now = new Date().toISOString();
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key:       marshall({ worldId }),
    UpdateExpression: 'SET lastActiveAt = :t, #ttl = :ttl',
    ExpressionAttributeNames:  { '#ttl': 'ttl' },
    ExpressionAttributeValues: marshall({
      ':t':   now,
      ':ttl': Math.floor(Date.now() / 1000) + 86400,
    }),
  }));
  return respond(200, { ok: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getWorldRecord(worldId) {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key:       marshall({ worldId }),
  }));
  return res.Item ? unmarshall(res.Item) : null;
}

async function listWorldsForOwner(ownerId) {
  const res = await ddb.send(new QueryCommand({
    TableName:              TABLE,
    IndexName:              'owner-index',
    KeyConditionExpression: 'ownerId = :o',
    ExpressionAttributeValues: marshall({ ':o': ownerId }),
  }));
  return (res.Items ?? []).map(i => unmarshall(i));
}

function sanitizeId(id) {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 32);
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
