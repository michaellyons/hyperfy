#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MuseumCoreStack }        from '../lib/museum-core-stack';
import { MuseumWorldsStack }      from '../lib/museum-worlds-stack';
import { MuseumWorldManagerStack } from '../lib/museum-world-manager-stack';

const app = new cdk.App();

// ── Target account / region ──────────────────────────────────────────────────
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// ── 1. Core shared infra (VPC, RDS, S3, ECR, ECS cluster) ───────────────────
const core = new MuseumCoreStack(app, 'MuseumCore', {
  env,
  description: 'Shared VPC, RDS Aurora, S3 assets bucket, ECR, ECS cluster',
});

// ── 2. Always-on worlds (global + demo) ─────────────────────────────────────
const worlds = new MuseumWorldsStack(app, 'MuseumWorlds', {
  env,
  description: 'Always-on world ECS services (global world, demo world)',
  cluster:        core.cluster,
  taskRole:       core.taskRole,
  executionRole:  core.executionRole,
  repository:     core.repository,
  assetsSecret:   core.assetsSecret,
  dbSecret:       core.dbSecret,
  assetsBucket:   core.assetsBucket,
  albListener:    core.httpsListener,
  hostedZone:     core.hostedZone,
  certificate:    core.certificate,
  domainName:     core.domainName,
});
worlds.addDependency(core);

// ── 3. World Manager API (spawn / list / stop user worlds on demand) ─────────
const worldMgr = new MuseumWorldManagerStack(app, 'MuseumWorldManager', {
  env,
  description: 'Lambda API for on-demand per-user world lifecycle management',
  cluster:        core.cluster,
  taskDefinition: worlds.userWorldTaskDef,
  worldsTable:    worlds.worldsTable,
  assetsBucket:   core.assetsBucket,
  dbSecret:       core.dbSecret,
  subnets:        core.privateSubnets,
  securityGroup:  core.worldTaskSg,
  albListener:    core.httpsListener,
  hostedZone:     core.hostedZone,
  domainName:     core.domainName,
});
worldMgr.addDependency(worlds);

app.synth();
