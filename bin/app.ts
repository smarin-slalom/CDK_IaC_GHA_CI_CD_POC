#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// bin/app.ts  –  CDK application entry point
//
// Instantiates all three stacks with the POC configuration.
// For other environments, create a new config file under config/ and
// pass it here (or wire it through CDK context / environment variables).
// ─────────────────────────────────────────────────────────────────────────────

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

import { EnvironmentStack }  from '../stacks/environment-stack';
import { ClientInfraStack }  from '../stacks/client-infra-stack';
import { EcsStack }          from '../stacks/ecs-stack';

import {
  ENVIRONMENT_CONFIG,
  CLIENT_INFRA_CONFIG,
  ECS_CONFIG,
  PROJECT_NAME,
  ENVIRONMENT,
} from '../config/poc-config';

const app = new cdk.App();

// ── Account / region resolution ───────────────────────────────────────────────
// These can be overridden by:
//   cdk deploy --context account=123456789012 --context region=us-east-1
// or by setting CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION environment variables.
const account = app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT;
const region  = app.node.tryGetContext('region')  ?? process.env.CDK_DEFAULT_REGION;

const env: cdk.Environment = { account, region };

// ── Common tags applied to every resource ────────────────────────────────────
const commonTags: Record<string, string> = {
  Project:     PROJECT_NAME,
  Environment: ENVIRONMENT,
  ManagedBy:   'CDK',
  Repository:  'infrastructure',
};

// ── Stack 1: Environment (VPC, subnets, route tables, security groups) ────────
const environmentStack = new EnvironmentStack(app, 'EnvironmentStack', {
  stackName: `${PROJECT_NAME}-${ENVIRONMENT}-environment`,
  description: 'Networking foundation: VPC, subnets, route tables, security groups',
  env,
  config: ENVIRONMENT_CONFIG,
  tags: commonTags,
});

// ── Stack 2: Client Infrastructure (NAT GW, ALB) ─────────────────────────────
const clientInfraStack = new ClientInfraStack(app, 'ClientInfraStack', {
  stackName: `${PROJECT_NAME}-${ENVIRONMENT}-client-infra`,
  description: 'Client-managed resources: NAT Gateway and Application Load Balancer',
  env,
  config: CLIENT_INFRA_CONFIG,
  // Uncomment to enable HTTPS:
  // certificateArn: 'arn:aws:acm:REGION:ACCOUNT:certificate/CERT-ID',
  tags: commonTags,
});

// ClientInfraStack reads from SSM – no hard CDK dependency needed,
// but make intent explicit for local `cdk deploy --all`
clientInfraStack.addDependency(environmentStack);

// ── Stack 3: ECS Cluster ──────────────────────────────────────────────────────
const ecsStack = new EcsStack(app, 'EcsStack', {
  stackName: `${PROJECT_NAME}-${ENVIRONMENT}-ecs`,
  description: 'ECS Fargate cluster, IAM roles, log group and task security group',
  env,
  config: ECS_CONFIG,
  tags: commonTags,
});

ecsStack.addDependency(clientInfraStack);

app.synth();
