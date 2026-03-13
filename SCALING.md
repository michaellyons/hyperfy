# McMaster Museum — World Scaling Architecture

## Overview

Every "world" is one Hyperfy process (one ECS Fargate task).  
Worlds share a single Aurora Postgres cluster and S3 bucket; isolation is achieved  
via **Postgres schema-per-world** (`world_<id>`) and **S3 prefix-per-world** (`worlds/<id>/`).

```
Browser ──► CloudFront (static client) 
        ──► ALB ──► global.museum.com  → ECS Service  (min 1, max 6)
                ──► demo.museum.com    → ECS Service  (min 1, max 2)
                ──► *.museum.com       → World Gateway (nginx reverse proxy)
                                                ↕  DynamoDB registry
                                          ECS RunTask (on-demand)
```

---

## World Types

| Type         | Who owns it | Lifecycle            | AWS resource        |
|--------------|-------------|----------------------|---------------------|
| **global**   | Everyone    | Always on            | ECS Service, min 1  |
| **demo**     | System      | Always on            | ECS Service, min 1  |
| **user world** | A user    | On-demand, idle stops after 60 min | ECS RunTask |

---

## Scaling Tiers

### Tier 0 — Local dev

```bash
# Start the global world
WORLD=worlds/global npm run dev

# Start a user world on a different port
WORLD=worlds/alice PORT=3001 PUBLIC_WS_URL=ws://localhost:3001/ws \
  PUBLIC_API_URL=http://localhost:3001/api npm run dev
```

### Tier 1 — Single server (< 50 concurrent users)

Single EC2 t4g.medium or ECS Fargate task running the `global` world.  
Cost: ~$25/month.

### Tier 2 — Multi-world (< 500 concurrent users)

ECS cluster with:
- 1–6 tasks for `global` world (auto-scales on CPU ≥ 60%)
- 1–2 tasks for `demo` world
- On-demand tasks for user worlds (spun up in < 90 seconds)

Aurora Serverless v2: scales from 0.5 ACU to 8 ACU automatically.  
Cost: ~$150–400/month depending on usage.

### Tier 3 — Production scale (> 500 concurrent users)

Same CDK stacks, just raise limits:
```typescript
maxCount: 20           // per world
serverlessV2MaxCapacity: 32   // RDS ACUs
```

Add [LiveKit](https://livekit.io) for spatial voice:  
```
LIVEKIT_WS_URL=wss://livekit.your-domain.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

---

## Per-user World Lifecycle

```
Client                  WorldManager API            ECS / DynamoDB
  │                           │                          │
  ├─ POST /worlds ────────────►│                          │
  │   { worldId: "alice",     │                          │
  │     ownerId: "user123" }  │                          │
  │                           ├─ DDB: world STARTING ───►│
  │                           ├─ ECS RunTask ───────────►│
  │◄── 202 { status: STARTING │                          │
  │           wsUrl: wss://.. }│                         │
  │                           │              (task boots ~60s)
  ├─ GET /worlds/alice ───────►│                          │
  │◄── 200 { status: RUNNING  │◄─ DescribeTasks ─────────┤
  │           wsUrl: wss://.. }│                         │
  │                           │                          │
  ├─ WS connect ─────────────────────────────────────────►│
  │                           │                          │
  │  ... 60 min idle ...      │                          │
  │                           │◄─ EventBridge every 10m ─┤
  │                           ├─ ECS StopTask ──────────►│
  │                           ├─ DDB: world STOPPED ────►│
```

World **data** (blueprints, entities, uploaded assets) is **always preserved**  
in Postgres and S3 — stopping the task doesn't lose anything.

---

## Deployment

### Prerequisites

```bash
# AWS CLI + CDK
npm install -g aws-cdk

# Authenticate
aws configure       # or use AWS SSO: aws sso login

# Set your domain (must exist in Route53)
export DOMAIN=museum.example.com
```

### First deploy

```bash
# 1. Build and push the Docker image
aws ecr get-login-password | docker login --username AWS \
  --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

docker build -t mcmaster-museum/world-server .
docker tag mcmaster-museum/world-server \
  <account>.dkr.ecr.us-east-1.amazonaws.com/mcmaster-museum/world-server:latest
docker push \
  <account>.dkr.ecr.us-east-1.amazonaws.com/mcmaster-museum/world-server:latest

# 2. Deploy infrastructure
cd infrastructure
npm install
cdk bootstrap
cdk deploy --all --context domainName=$DOMAIN
```

### Update worlds (zero-downtime rolling deploy)

```bash
# Rebuild and push
docker build -t mcmaster-museum/world-server . && docker push ...

# Force ECS to redeploy (rolling, preserves world state in RDS)
aws ecs update-service \
  --cluster mcmaster-museum-worlds \
  --service global \
  --force-new-deployment
```

---

## Environment Variables per World

| Variable         | Global world          | User world            |
|------------------|-----------------------|-----------------------|
| `WORLD`          | `worlds/global`       | `worlds/<userId>`     |
| `DB_SCHEMA`      | `world_global`        | `world_<userId>`      |
| `JWT_SECRET`     | (unique, in Secrets)  | auto-generated        |
| `ASSETS_S3_URI`  | `s3://bucket/worlds/global/assets` | `s3://bucket/worlds/<id>/assets` |
| `PUBLIC_WS_URL`  | `wss://global.museum.com/ws` | `wss://<id>.museum.com/ws` |

---

## Cost Estimates (us-east-1, 2026 pricing)

| Component            | Spec                    | Monthly   |
|----------------------|-------------------------|-----------|
| ECS Fargate (global) | 0.5 vCPU, 1GB, 730h     | ~$18      |
| ECS Fargate (user worlds) | avg 5 active × 2h/day | ~$3  |
| Aurora Serverless v2 | 0.5–2 ACU avg           | ~$50      |
| S3 + CloudFront      | ~10 GB assets           | ~$5       |
| ALB                  | 1 LCU avg               | ~$20      |
| API Gateway + Lambda | < 1M req/mo             | ~$3       |
| **Total**            |                         | **~$100** |
