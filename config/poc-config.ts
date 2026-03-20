// ─────────────────────────────────────────────────────────────────────────────
// config/poc-config.ts  –  POC-specific configuration values
//
// Adjust this file (or create env-specific variants) to change deployment
// parameters without touching construct or stack code.
// ─────────────────────────────────────────────────────────────────────────────

import {
  EnvironmentStackConfig,
  ClientInfraStackConfig,
  EcsStackConfig,
  DEFAULT_SCALING,
} from './config';

export const PROJECT_NAME = 'migration-poc';
export const ENVIRONMENT  = 'poc';

// ── SSM prefix conventions ───────────────────────────────────────────────────

export const ENVIRONMENT_SSM_PREFIX  = `/${PROJECT_NAME}/${ENVIRONMENT}/environment`;
export const CLIENT_INFRA_SSM_PREFIX = `/${PROJECT_NAME}/${ENVIRONMENT}/client-infra`;
export const ECS_SSM_PREFIX          = `/${PROJECT_NAME}/${ENVIRONMENT}/ecs`;

// ── Stack 1 – Environment ────────────────────────────────────────────────────
// Deploys: VPC, subnets, route tables, IGW, security groups
//
// POC topology (single AZ for simplicity – set maxAzs: 2 for HA):
//   • 1 × Public  subnet  /24  →  10.0.0.0/24
//   • 2 × Private subnets /24  →  10.0.1.0/24 | 10.0.2.0/24
//
// NOTE: For a production deployment use maxAzs ≥ 2.  The ALB also requires
//       subnets in at least 2 AZs; set maxAzs: 2 and numPublicSubnets: 1
//       (CDK will replicate across both AZs automatically).
// ─────────────────────────────────────────────────────────────────────────────
export const ENVIRONMENT_CONFIG: EnvironmentStackConfig = {
  projectName: PROJECT_NAME,
  environment: ENVIRONMENT,
  vpc: {
    vpcName: `${PROJECT_NAME}-${ENVIRONMENT}-vpc`,
    cidr: '10.0.0.0/16',
    // Use maxAzs: 1 for a lean single-AZ POC;
    // bump to 2 for HA (ALB, ECS multi-AZ).
    maxAzs: 2,
    numPublicSubnets: 1,   // 1 public subnet config  → 1 subnet per AZ
    numPrivateSubnets: 2,  // 2 private subnet configs → 2 subnets per AZ
    publicSubnetCidrMask: 24,
    privateSubnetCidrMask: 24,
  },
};

// ── Stack 2 – Client Infrastructure ─────────────────────────────────────────
// Deploys: NAT Gateway (in public subnet), Application Load Balancer
// ─────────────────────────────────────────────────────────────────────────────
export const CLIENT_INFRA_CONFIG: ClientInfraStackConfig = {
  projectName: PROJECT_NAME,
  environment: ENVIRONMENT,
  environmentSsmPrefix: ENVIRONMENT_SSM_PREFIX,
};

// ── Stack 3 – ECS / Fargate cluster ─────────────────────────────────────────
// Deploys: ECS Cluster, IAM roles, CloudWatch log group, capacity providers
// ─────────────────────────────────────────────────────────────────────────────
export const ECS_CONFIG: EcsStackConfig = {
  projectName: PROJECT_NAME,
  environment: ENVIRONMENT,
  environmentSsmPrefix: ENVIRONMENT_SSM_PREFIX,
  clientInfraSsmPrefix: CLIENT_INFRA_SSM_PREFIX,
};

// ── Default scaling (overridable per app-service stack) ──────────────────────
export const SCALING_CONFIG = {
  ...DEFAULT_SCALING,
  maxCapacity: 8,
};
