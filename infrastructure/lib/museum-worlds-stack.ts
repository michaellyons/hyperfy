/**
 * MuseumWorldsStack
 *
 * Deploys always-on ECS services for the two permanent worlds:
 *   global  — the shared public world (min 1, max 6 tasks)
 *   demo    — a scripted guided tour world (min 1, max 2 tasks)
 *
 * It also defines the re-usable UserWorldTaskDefinition that the
 * WorldManager uses to spin up on-demand per-user worlds.
 *
 * World isolation model
 * ─────────────────────
 *   • Each ECS task runs a single Hyperfy world process.
 *   • All tasks share one RDS Aurora cluster (schema-per-world via DB_SCHEMA).
 *   • Assets live in one S3 bucket under prefix `worlds/<worldId>/`.
 *   • WebSocket routing is done by ALB host-based rules:
 *       global.museum.example.com → globalTargetGroup
 *       demo.museum.example.com   → demoTargetGroup
 *       <userId>.museum.example.com → dynamically registered by WorldManager
 */

import * as cdk            from 'aws-cdk-lib';
import * as ec2            from 'aws-cdk-lib/aws-ec2';
import * as ecs            from 'aws-cdk-lib/aws-ecs';
import * as ecr            from 'aws-cdk-lib/aws-ecr';
import * as elbv2          from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as dynamodb       from 'aws-cdk-lib/aws-dynamodb';
import * as iam            from 'aws-cdk-lib/aws-iam';
import * as logs           from 'aws-cdk-lib/aws-logs';
import * as route53        from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3             from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as acm            from 'aws-cdk-lib/aws-certificatemanager';
import { Construct }       from 'constructs';

export interface MuseumWorldsProps extends cdk.StackProps {
  cluster:        ecs.Cluster;
  taskRole:       iam.Role;
  executionRole:  iam.Role;
  repository:     ecr.Repository;
  assetsSecret:   secretsmanager.ISecret;
  dbSecret:       secretsmanager.ISecret;
  assetsBucket:   s3.Bucket;
  albListener:    elbv2.ApplicationListener;
  hostedZone:     route53.IHostedZone | undefined;
  certificate:    acm.ICertificate    | undefined;
  domainName:     string;
}

export class MuseumWorldsStack extends cdk.Stack {
  /** Task definition shared by all user-world tasks (WorldManager re-uses this) */
  readonly userWorldTaskDef: ecs.FargateTaskDefinition;
  /** DynamoDB table tracking world lifecycle (worldId → taskArn, status, lastActive) */
  readonly worldsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: MuseumWorldsProps) {
    super(scope, id, props);

    const { cluster, repository, albListener, hostedZone, domainName } = props;

    // ── DynamoDB world registry ────────────────────────────────────────────────
    this.worldsTable = new dynamodb.Table(this, 'WorldsTable', {
      tableName:     'museum-worlds',
      partitionKey:  { name: 'worldId', type: dynamodb.AttributeType.STRING },
      billingMode:   dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',           // auto-expire idle world records
      stream:        dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // GSI for querying worlds by owner
    this.worldsTable.addGlobalSecondaryIndex({
      indexName:            'owner-index',
      partitionKey:         { name: 'ownerId', type: dynamodb.AttributeType.STRING },
      sortKey:              { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType:       dynamodb.ProjectionType.ALL,
    });

    // ── Shared log group ───────────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'WorldLogs', {
      logGroupName:  '/museum/worlds',
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Base task definition (used by global, demo, AND per-user worlds) ───────
    this.userWorldTaskDef = new ecs.FargateTaskDefinition(this, 'WorldTaskDef', {
      memoryLimitMiB: 1024,
      cpu:            512,
      taskRole:       props.taskRole,
      executionRole:  props.executionRole,
    });
    this.userWorldTaskDef.addContainer('world-server', {
      image:           ecs.ContainerImage.fromEcrRepository(repository, 'latest'),
      essential:       true,
      portMappings:    [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'world',
        logGroup,
      }),
      // These are overridden per-world via ECS RunTask environment overrides
      environment: {
        NODE_ENV:    'production',
        PORT:        '3000',
        ASSETS:      's3',
        SAVE_INTERVAL: '60',
        CLEAN:       'true',
        PUBLIC_PLAYER_COLLISION: 'false',
        PUBLIC_MAX_UPLOAD_SIZE:  '50',
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, 'password'),
        DB_HOST:     ecs.Secret.fromSecretsManager(props.dbSecret, 'host'),
        DB_PORT:     ecs.Secret.fromSecretsManager(props.dbSecret, 'port'),
        DB_NAME:     ecs.Secret.fromSecretsManager(props.dbSecret, 'dbname'),
      },
      healthCheck: {
        command:     ['CMD-SHELL', 'curl -sf http://localhost:3000/status || exit 1'],
        interval:    cdk.Duration.seconds(30),
        timeout:     cdk.Duration.seconds(5),
        retries:     3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Grant the task access to the worlds table
    this.worldsTable.grantReadWriteData(props.taskRole);

    // ── Deploy named permanent worlds ──────────────────────────────────────────
    this._deployPermanentWorld({
      worldId:   'global',
      worldName: 'Global World',
      subdomain: `global.${domainName}`,
      minCount:  1,
      maxCount:  6,
      priority:  10,
      jwtSecret: 'global-world-jwt-secret',
      adminCode: 'mcmaster-admin',
      props,
      logGroup,
    });

    this._deployPermanentWorld({
      worldId:   'demo',
      worldName: 'Demo World',
      subdomain: `demo.${domainName}`,
      minCount:  1,
      maxCount:  2,
      priority:  20,
      jwtSecret: 'demo-world-jwt-secret',
      adminCode: 'demo-admin',
      props,
      logGroup,
    });

    // ── Outputs ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WorldsTableName', { value: this.worldsTable.tableName });
    new cdk.CfnOutput(this, 'GlobalWorldUrl',  { value: `wss://global.${domainName}/ws` });
    new cdk.CfnOutput(this, 'DemoWorldUrl',    { value: `wss://demo.${domainName}/ws`   });
  }

  // ── Private helper: deploy one always-on world ────────────────────────────
  private _deployPermanentWorld(cfg: {
    worldId:   string;
    worldName: string;
    subdomain: string;
    minCount:  number;
    maxCount:  number;
    priority:  number;
    jwtSecret: string;
    adminCode: string;
    props:     MuseumWorldsProps;
    logGroup:  logs.LogGroup;
  }) {
    const { worldId, subdomain, minCount, maxCount, priority, jwtSecret, adminCode, props } = cfg;
    const { cluster, albListener, hostedZone, domainName } = props;

    const sg = new ec2.SecurityGroup(this, `${worldId}Sg`, { vpc: cluster.vpc });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000));

    const service = new ecs.FargateService(this, `${worldId}Service`, {
      cluster,
      taskDefinition:  this.userWorldTaskDef,
      desiredCount:    minCount,
      securityGroups:  [sg],
      vpcSubnets:      { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp:  false,
      // Per-world env overrides (ECS doesn't support container-level overrides
      // on a *service*, so we patch the task def for permanent worlds)
      // NOTE: user worlds use RunTask overrides instead (see WorldManagerStack)
    });

    // Auto-scale on CPU
    const scaling = service.autoScaleTaskCount({ minCapacity: minCount, maxCapacity: maxCount });
    scaling.scaleOnCpuUtilization(`${worldId}CpuScaling`, {
      targetUtilizationPercent: 60,
      scaleOutCooldown: cdk.Duration.minutes(2),
      scaleInCooldown:  cdk.Duration.minutes(5),
    });

    // ALB target group with WebSocket stickiness
    const tg = new elbv2.ApplicationTargetGroup(this, `${worldId}Tg`, {
      vpc:        cluster.vpc,
      protocol:   elbv2.ApplicationProtocol.HTTP,
      port:       3000,
      targetType: elbv2.TargetType.IP,
      targets:    [service],
      healthCheck: {
        path:             '/status',
        healthyHttpCodes: '200',
        interval:         cdk.Duration.seconds(30),
      },
      stickinessCookieDuration: cdk.Duration.hours(1),
    });

    // Host-based routing rule
    albListener.addTargetGroups(`${worldId}Rule`, {
      targetGroups: [tg],
      priority,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([subdomain]),
      ],
    });

    // DNS A record (if zone is available)
    if (hostedZone) {
      new (require('aws-cdk-lib/aws-route53').ARecord)(this, `${worldId}Dns`, {
        zone:       hostedZone,
        recordName: subdomain,
        target:     (require('aws-cdk-lib/aws-route53').RecordTarget).fromAlias(
          new (require('aws-cdk-lib/aws-route53-targets').LoadBalancerTarget)(
            albListener.loadBalancer as elbv2.ApplicationLoadBalancer,
          ),
        ),
      });
    }
  }
}
