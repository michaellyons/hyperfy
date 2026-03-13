/**
 * MuseumWorldManagerStack
 *
 * Deploys the HTTP API + Lambda that lets clients create, query, and stop
 * on-demand per-user worlds.
 *
 * Endpoints (all return JSON):
 *   POST   /worlds            → spawn a user world (or wake a stopped one)
 *   GET    /worlds?ownerId=x  → list worlds for an owner
 *   GET    /worlds/:worldId   → get status + wsUrl
 *   DELETE /worlds/:worldId   → stop a running world
 *   POST   /worlds/:worldId/heartbeat → world server keepalive
 *
 * Inactivity auto-stop (EventBridge + Lambda)
 * ──────────────────────────────────────────
 * A scheduled Lambda runs every 10 minutes and stops any world whose
 * lastActiveAt is older than IDLE_TIMEOUT_MINUTES (default 60).
 */

import * as cdk        from 'aws-cdk-lib';
import * as ec2        from 'aws-cdk-lib/aws-ec2';
import * as ecs        from 'aws-cdk-lib/aws-ecs';
import * as iam        from 'aws-cdk-lib/aws-iam';
import * as lambda     from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb   from 'aws-cdk-lib/aws-dynamodb';
import * as events     from 'aws-cdk-lib/aws-events';
import * as targets    from 'aws-cdk-lib/aws-events-targets';
import * as logs       from 'aws-cdk-lib/aws-logs';
import * as s3         from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as elbv2      from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53    from 'aws-cdk-lib/aws-route53';
import { Construct }   from 'constructs';

export interface WorldManagerProps extends cdk.StackProps {
  cluster:        ecs.Cluster;
  taskDefinition: ecs.FargateTaskDefinition;
  worldsTable:    dynamodb.Table;
  assetsBucket:   s3.Bucket;
  dbSecret:       secretsmanager.ISecret;
  subnets:        ec2.SubnetSelection;
  securityGroup:  ec2.SecurityGroup;
  albListener:    elbv2.ApplicationListener;
  hostedZone:     route53.IHostedZone | undefined;
  domainName:     string;
}

export class MuseumWorldManagerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorldManagerProps) {
    super(scope, id, props);

    const {
      cluster, taskDefinition, worldsTable, assetsBucket,
      dbSecret, subnets, securityGroup, domainName,
    } = props;

    // ── Lambda role ────────────────────────────────────────────────────────────
    const fnRole = new iam.Role(this, 'WorldManagerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    fnRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks',
        'iam:PassRole',
      ],
      resources: [
        cluster.clusterArn,
        taskDefinition.taskDefinitionArn,
        taskDefinition.taskRole.roleArn,
        taskDefinition.executionRole!.roleArn,
      ],
    }));
    worldsTable.grantReadWriteData(fnRole);
    assetsBucket.grantReadWrite(fnRole);

    // ── World Manager Lambda ───────────────────────────────────────────────────
    const worldManagerFn = new lambda.Function(this, 'WorldManagerFn', {
      runtime:      lambda.Runtime.NODEJS_20_X,
      handler:      'world-manager.handler',
      code:         lambda.Code.fromAsset('../infrastructure/lambda'),
      timeout:      cdk.Duration.seconds(30),
      memorySize:   512,
      role:         fnRole,
      environment: {
        WORLDS_TABLE:        worldsTable.tableName,
        CLUSTER_ARN:         cluster.clusterArn,
        TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
        SUBNETS:             cluster.vpc
          .selectSubnets(subnets).subnetIds.join(','),
        SECURITY_GROUP:      securityGroup.securityGroupId,
        DOMAIN:              domainName,
        ASSETS_BUCKET:       assetsBucket.bucketName,
        DB_SECRET_ARN:       dbSecret.secretArn,
        IDLE_TIMEOUT_MINUTES: '60',
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    dbSecret.grantRead(fnRole);

    // ── HTTP API Gateway (v2) ──────────────────────────────────────────────────
    const api = new apigateway.HttpApi(this, 'WorldManagerApi', {
      apiName:     'museum-world-manager',
      description: 'On-demand world lifecycle API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const integration = new integrations.HttpLambdaIntegration(
      'WorldManagerIntegration', worldManagerFn,
    );

    api.addRoutes({ path: '/worlds',              methods: [apigateway.HttpMethod.POST, apigateway.HttpMethod.GET], integration });
    api.addRoutes({ path: '/worlds/{worldId}',    methods: [apigateway.HttpMethod.GET,  apigateway.HttpMethod.DELETE], integration });
    api.addRoutes({ path: '/worlds/{worldId}/heartbeat', methods: [apigateway.HttpMethod.POST], integration });

    // ── Idle world reaper (EventBridge every 10 min) ───────────────────────────
    const reaperFn = new lambda.Function(this, 'IdleWorldReaper', {
      runtime:     lambda.Runtime.NODEJS_20_X,
      handler:     'index.handler',
      code:        lambda.Code.fromInline(`
        const { ECSClient, StopTaskCommand } = require('@aws-sdk/client-ecs');
        const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
        const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

        exports.handler = async () => {
          const ecs = new ECSClient({});
          const ddb = new DynamoDBClient({});
          const idleMs = (parseInt(process.env.IDLE_TIMEOUT_MINUTES) || 60) * 60000;
          const threshold = new Date(Date.now() - idleMs).toISOString();

          const { Items = [] } = await ddb.send(new ScanCommand({
            TableName:        process.env.WORLDS_TABLE,
            FilterExpression: '#s = :r AND lastActiveAt < :t AND worldId <> :g AND worldId <> :d',
            ExpressionAttributeNames:  { '#s': 'status' },
            ExpressionAttributeValues: marshall({
              ':r': 'RUNNING', ':t': threshold, ':g': 'global', ':d': 'demo',
            }),
          }));

          for (const item of Items) {
            const { worldId, taskArn } = unmarshall(item);
            try {
              if (taskArn) {
                await ecs.send(new StopTaskCommand({
                  cluster: process.env.CLUSTER_ARN,
                  task:    taskArn,
                  reason:  'Idle timeout',
                }));
              }
              await ddb.send(new UpdateItemCommand({
                TableName: process.env.WORLDS_TABLE,
                Key:       marshall({ worldId }),
                UpdateExpression:         'SET #s = :s',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: marshall({ ':s': 'STOPPED' }),
              }));
              console.log('Stopped idle world:', worldId);
            } catch (e) {
              console.error('Failed to stop world', worldId, e);
            }
          }
        };
      `),
      timeout:     cdk.Duration.seconds(60),
      memorySize:  256,
      role:        fnRole,
      environment: {
        WORLDS_TABLE:         worldsTable.tableName,
        CLUSTER_ARN:          cluster.clusterArn,
        IDLE_TIMEOUT_MINUTES: '60',
      },
    });

    new events.Rule(this, 'ReaperSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(10)),
      targets:  [new targets.LambdaFunction(reaperFn)],
    });

    // ── Outputs ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WorldManagerApiUrl', {
      value:       api.apiEndpoint,
      description: 'REST endpoint for world lifecycle management',
    });
  }
}
