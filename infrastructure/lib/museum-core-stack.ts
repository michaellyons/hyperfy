import * as cdk           from 'aws-cdk-lib';
import * as ec2            from 'aws-cdk-lib/aws-ec2';
import * as ecs            from 'aws-cdk-lib/aws-ecs';
import * as ecr            from 'aws-cdk-lib/aws-ecr';
import * as rds            from 'aws-cdk-lib/aws-rds';
import * as s3             from 'aws-cdk-lib/aws-s3';
import * as iam            from 'aws-cdk-lib/aws-iam';
import * as elbv2          from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm            from 'aws-cdk-lib/aws-certificatemanager';
import * as route53        from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as logs           from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct }       from 'constructs';

export interface MuseumCoreProps extends cdk.StackProps {
  /** e.g. "museum.mcmaster.example.com"  — must exist in Route53 */
  domainName?: string;
}

export class MuseumCoreStack extends cdk.Stack {
  // Exported resources consumed by child stacks
  readonly vpc:           ec2.Vpc;
  readonly cluster:       ecs.Cluster;
  readonly repository:    ecr.Repository;
  readonly assetsBucket:  s3.Bucket;
  readonly dbSecret:      secretsmanager.ISecret;
  readonly assetsSecret:  secretsmanager.ISecret;
  readonly taskRole:      iam.Role;
  readonly executionRole: iam.Role;
  readonly alb:           elbv2.ApplicationLoadBalancer;
  readonly httpsListener: elbv2.ApplicationListener;
  readonly hostedZone:    route53.IHostedZone | undefined;
  readonly certificate:   acm.ICertificate    | undefined;
  readonly domainName:    string;
  readonly privateSubnets: ec2.SubnetSelection;
  readonly worldTaskSg:   ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: MuseumCoreProps = {}) {
    super(scope, id, props);

    this.domainName = props.domainName ?? 'museum.example.com';

    // ── VPC ────────────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs:      2,
      natGateways: 1,           // single NAT to save cost
      subnetConfiguration: [
        { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,              cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'db',      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,    cidrMask: 28 },
      ],
    });

    this.privateSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    // ── ECR ────────────────────────────────────────────────────────────────────
    this.repository = new ecr.Repository(this, 'WorldServerRepo', {
      repositoryName:       'mcmaster-museum/world-server',
      removalPolicy:        cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{
        maxImageCount: 10,
        description:  'Keep last 10 images',
      }],
    });

    // ── S3 assets ──────────────────────────────────────────────────────────────
    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName:         `mcmaster-museum-assets-${this.account}`,
      removalPolicy:      cdk.RemovalPolicy.RETAIN,
      blockPublicAccess:  s3.BlockPublicAccess.BLOCK_ALL,
      encryption:         s3.BucketEncryption.S3_MANAGED,
      versioned:          true,
      cors: [{
        allowedOrigins: ['*'],
        allowedMethods: [s3.HttpMethods.GET],
        maxAge:         3600,
      }],
    });

    // ── ECS cluster ────────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'WorldCluster', {
      vpc:               this.vpc,
      containerInsights: true,
      clusterName:       'mcmaster-museum-worlds',
    });

    // ── RDS Aurora Serverless v2 (Postgres 15) ─────────────────────────────────
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc:         this.vpc,
      description: 'RDS Aurora — world data',
    });

    const dbCluster = new rds.DatabaseCluster(this, 'WorldsDb', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_4,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 8,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: [
        rds.ClusterInstance.serverlessV2('reader', { scaleWithWriter: true }),
      ],
      vpc:          this.vpc,
      vpcSubnets:   { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      defaultDatabaseName:   'museum',
      storageEncrypted:      true,
      backup:                { retention: cdk.Duration.days(7) },
      removalPolicy:         cdk.RemovalPolicy.SNAPSHOT,
      deletionProtection:    true,
    });
    this.dbSecret = dbCluster.secret!;

    // ── Secrets ────────────────────────────────────────────────────────────────
    this.assetsSecret = new secretsmanager.Secret(this, 'AssetsConfig', {
      description:     'S3 bucket name + region for world server assets',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          bucket:  this.assetsBucket.bucketName,
          region:  this.region,
        }),
        generateStringKey: '_unused',
      },
    });

    // ── Task IAM roles ─────────────────────────────────────────────────────────
    this.executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy:   new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['secretsmanager:GetSecretValue'],
      resources: [this.dbSecret.secretArn, this.assetsSecret.secretArn],
    }));

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.assetsBucket.grantReadWrite(this.taskRole);
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      actions:   ['cloudwatch:PutMetricData', 'logs:CreateLogGroup',
                  'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    // ── Security group for world tasks ─────────────────────────────────────────
    this.worldTaskSg = new ec2.SecurityGroup(this, 'WorldTaskSg', {
      vpc:         this.vpc,
      description: 'World server ECS tasks',
    });
    dbSg.addIngressRule(this.worldTaskSg, ec2.Port.tcp(5432), 'World tasks → Postgres');

    // ── Application Load Balancer ──────────────────────────────────────────────
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc:         this.vpc,
      description: 'ALB inbound',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80),  'HTTP');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    this.worldTaskSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'ALB → world task');

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc:           this.vpc,
      internetFacing: true,
      securityGroup:  albSg,
    });

    // HTTP → HTTPS redirect
    this.alb.addListener('HttpRedirect', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS', port: '443', permanent: true,
      }),
    });

    // ── DNS + TLS (optional — only if domainName is provided) ─────────────────
    if (props.domainName) {
      const zone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: props.domainName.split('.').slice(-2).join('.'),
      });
      this.hostedZone = zone;

      // Wildcard cert covers *.museum.example.com AND museum.example.com
      const cert = new acm.Certificate(this, 'WildcardCert', {
        domainName:             `*.${this.domainName}`,
        subjectAlternativeNames: [this.domainName],
        validation: acm.CertificateValidation.fromDns(zone),
      });
      this.certificate = cert;

      // Point apex to ALB
      new route53.ARecord(this, 'ApexAlias', {
        zone,
        recordName: this.domainName,
        target:     route53.RecordTarget.fromAlias(
          new route53targets.LoadBalancerTarget(this.alb),
        ),
      });

      this.httpsListener = this.alb.addListener('Https', {
        port:         443,
        protocol:     elbv2.ApplicationProtocol.HTTPS,
        certificates: [cert],
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          messageBody: 'World not found',
        }),
      });
    } else {
      // Local / no-DNS fallback: plain HTTP listener
      this.hostedZone  = undefined;
      this.certificate = undefined;
      this.httpsListener = this.alb.addListener('Http443', {
        port:    443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          messageBody: 'World not found',
        }),
      });
    }

    // ── Outputs ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDns',    { value: this.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'EcrUri',    { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, 'BucketName',{ value: this.assetsBucket.bucketName });
  }
}
