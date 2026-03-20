# Infrastructure – AWS CDK (TypeScript)

Migration POC – AWS infrastructure-as-code with AWS CDK.

---

## Repository layout

```
infrastructure/
├── bin/
│   └── app.ts                         # CDK app entry point – instantiates all stacks
├── config/
│   ├── config.ts                      # Shared TypeScript interfaces & helpers
│   └── poc-config.ts                  # POC-specific values (CIDR, region, project name…)
├── constructs/                        # Reusable constructs (portable across projects)
│   ├── index.ts                       # Barrel export
│   ├── vpc/
│   │   └── vpc-construct.ts           # VPC, subnets, route tables, IGW, SGs, flow logs
│   ├── networking/
│   │   ├── nat-gateway-construct.ts   # NAT Gateway + private route table wiring
│   │   └── alb-construct.ts           # Application Load Balancer + listeners
│   └── compute/
│       └── ecs-cluster-construct.ts   # ECS Fargate cluster, IAM roles, log group
├── stacks/                            # The three IaC files
│   ├── environment-stack.ts           # Stack 1 – VPC, networking foundation
│   ├── client-infra-stack.ts          # Stack 2 – NAT GW + ALB (client-managed)
│   └── ecs-stack.ts                   # Stack 3 – ECS cluster (team-managed)
├── templates/
│   └── app-service-stack.ts           # Per-service template (copied to app repos)
├── .github/workflows/
│   ├── cdk-deploy-reusable.yml        # Reusable CDK deploy/destroy workflow
│   ├── deploy-environment.yml         # Triggers Stack 1
│   ├── deploy-client-infra.yml        # Triggers Stack 2
│   ├── deploy-ecs.yml                 # Triggers Stack 3
│   ├── deploy-all.yml                 # Full pipeline (1 → 2 → 3)
│   └── deploy-service.yml             # Template for app repos (build → deploy → verify)
├── package.json
├── tsconfig.json
└── cdk.json
```

---

## Architecture overview

```
Internet
   │
   ▼  port 80/443
┌──────────────────────────────────────────────────────┐
│  VPC  10.0.0.0/16                                    │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Public Subnet /24   (AZ-a)                     │ │
│  │  ┌──────────┐   ┌──────────────────────────┐    │ │
│  │  │ NAT GW   │   │ Application Load Balancer│    │ │
│  │  │ (EIP)    │   │ (internet-facing)        │    │ │
│  │  └──────────┘   └──────────────────────────┘    │ │
│  └──────────────────────────┬──────────────────────┘ │
│            ▲                │ forward rules          │
│   outbound │                ▼                        │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Private Subnet 1 /24  (NAT → ECS services)     │ │
│  │  ┌──────────────────────────────────────────┐   │ │
│  │  │  ECS Fargate Tasks  (min 2, auto-scale)  │   │ │
│  │  └──────────────────────────────────────────┘   │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Private Subnet 2 /24  (NAT → future workloads) │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

---

## Configuration

All deployment variables live in **`config/poc-config.ts`**.  
Adjust this file (or create `config/staging-config.ts`, etc.) for other environments without touching stack code.

### POC defaults

| Parameter             | Value         |
|-----------------------|---------------|
| VPC CIDR              | 10.0.0.0/16   |
| Public subnets        | 1 per AZ      |
| Private subnets       | 2 per AZ      |
| Subnet mask           | /24           |
| Max AZs               | 2             |
| Min tasks per service | 2             |
| Max tasks (default)   | 8             |
| Scale-out CPU         | > 80 %        |
| Scale-in CPU          | < 20 %        |

---

## Stack dependency & SSM data flow

```
EnvironmentStack ──→ SSM /migration-poc/poc/environment/*
                          │
                          ▼
                   ClientInfraStack ──→ SSM /migration-poc/poc/client-infra/*
                                              │
                                              ▼
                                       EcsStack ──→ SSM /migration-poc/poc/ecs/*
                                                          │
                                                          ▼
                                                  AppServiceStack(s)
                                                  (per-app repo)
```

---

## Quick start

### Prerequisites

- Node.js 20+
- AWS CLI configured with credentials
- AWS CDK bootstrapped: `cdk bootstrap aws://ACCOUNT/REGION`

### Install & build

```bash
npm install
npm run build
```

### Synthesise (validate templates without deploying)

```bash
npx cdk synth --all \
  --context account=123456789012 \
  --context region=us-east-1
```

### Deploy individually

```bash
# Stack 1
npx cdk deploy EnvironmentStack --context account=... --context region=...

# Stack 2 (after Stack 1)
npx cdk deploy ClientInfraStack --context account=... --context region=...

# Stack 3 (after Stack 2)
npx cdk deploy EcsStack --context account=... --context region=...
```

### Deploy all at once

```bash
npx cdk deploy --all --require-approval never \
  --context account=123456789012 \
  --context region=us-east-1
```

---

## GitHub Actions setup

### 1. IAM role for OIDC

Create an IAM role in AWS that trusts the GitHub OIDC provider:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
      },
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      }
    }
  }]
}
```

Attach `AdministratorAccess` (POC) or a scoped CDK deployment policy for production.

### 2. Repository secrets & variables

| Name                   | Type     | Description                            |
|------------------------|----------|----------------------------------------|
| `AWS_ROLE_ARN`         | Secret   | ARN of the OIDC role above             |
| `AWS_ACCOUNT_ID`       | Variable | 12-digit AWS account ID                |
| `DEFAULT_AWS_REGION`   | Variable | e.g. `us-east-1`                       |
| `DEFAULT_ENVIRONMENT`  | Variable | e.g. `poc`                             |
| `ACM_CERTIFICATE_ARN`  | Variable | Optional – enables HTTPS on the ALB    |

### 3. Trigger the full pipeline

Go to **Actions → Deploy › Full Pipeline (All Stacks) → Run workflow**, choose region and environment.

---

## Deploying an application service

Each application lives in its own repository.  Copy the following files into it:

```
my-app-repo/
├── infrastructure/
│   ├── templates/app-service-stack.ts   # copied from this repo
│   ├── bin/app.ts                        # creates AppServiceStack
│   ├── package.json
│   └── tsconfig.json
├── .github/workflows/
│   └── deploy-service.yml               # copied from this repo
└── Dockerfile
```

Customise the `env:` block at the top of `deploy-service.yml`:

```yaml
env:
  APP_NAME:          "users"
  ECR_REPO_NAME:     "migration-poc-users"
  CONTAINER_PORT:    "8080"
  PATH_PATTERN:      "/api/users*"
  MAX_CAPACITY:      "12"
```

The workflow will:
1. Build the Docker image and push to ECR
2. Deploy `AppServiceStack` via CDK (creates task definition, ECS service, target group, ALB rule, auto-scaling)
3. Wait for ECS tasks to stabilise
4. Smoke-test via the ALB

---

## Auto-scaling logic

| Metric        | Threshold | Action                      | Cooldown |
|---------------|-----------|-----------------------------|----------|
| CPU Utilisation | ≥ 80 %  | +1 task                     | 60 s     |
| CPU Utilisation | ≤ 20 %  | −1 task                     | 300 s    |
| Minimum tasks | —         | Always 2 per region running | —        |
| Maximum tasks | —         | Configurable per app        | —        |

---

## Construct reusability

All constructs under `constructs/` are self-contained and can be published as an
npm package or vendored into other CDK projects.  Import via the barrel:

```typescript
import {
  VpcConstruct,
  NatGatewayConstruct,
  AlbConstruct,
  EcsClusterConstruct,
} from './constructs';
```
