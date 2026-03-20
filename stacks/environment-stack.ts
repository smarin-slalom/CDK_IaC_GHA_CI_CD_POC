// ─────────────────────────────────────────────────────────────────────────────
// stacks/environment-stack.ts  –  Stack 1: Environment
//
// Responsibility: Set up the networking foundation.
//   • VPC with public and private subnets
//   • Internet Gateway (managed inside VpcConstruct)
//   • Route tables and security groups
//   • VPC Flow Logs
//
// Outputs (written to SSM Parameter Store):
//   All parameters are stored under /{projectName}/{environment}/environment/
//   and consumed by ClientInfraStack and EcsStack.
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { VpcConstruct } from '../constructs';
import { EnvironmentStackConfig } from '../config/config';

export interface EnvironmentStackProps extends cdk.StackProps {
  config: EnvironmentStackConfig;
}

// ── SSM parameter name constants ─────────────────────────────────────────────
// Centralised here so ClientInfraStack/EcsStack reference the same paths.
export const ENV_SSM = {
  VPC_ID:                    'vpcId',
  VPC_CIDR:                  'vpcCidr',
  PUBLIC_SUBNET_IDS:         'publicSubnetIds',
  PRIVATE_SUBNET_IDS:        'privateSubnetIds',
  PRIVATE_ROUTE_TABLE_IDS:   'privateRouteTableIds',
  INTERNAL_SG_ID:            'internalSecurityGroupId',
  PUBLIC_SG_ID:              'publicSecurityGroupId',
  PRIVATE_SG_ID:             'privateSecurityGroupId',
  PUBLIC_SUBNET_COUNT:       'publicSubnetCount',
  PRIVATE_SUBNET_COUNT:      'privateSubnetCount',
} as const;

export class EnvironmentStack extends cdk.Stack {
  /** Expose the construct for potential same-account in-code references */
  public readonly vpcConstruct: VpcConstruct;

  constructor(scope: Construct, id: string, props: EnvironmentStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { vpc: vpcCfg, projectName, environment } = config;
    const ssmPrefix = `/${projectName}/${environment}/environment`;

    // ── VPC construct ─────────────────────────────────────────────────────
    this.vpcConstruct = new VpcConstruct(this, 'Vpc', {
      vpcName:               vpcCfg.vpcName,
      cidr:                  vpcCfg.cidr,
      maxAzs:                vpcCfg.maxAzs,
      numPublicSubnets:      vpcCfg.numPublicSubnets,
      numPrivateSubnets:     vpcCfg.numPrivateSubnets,
      publicSubnetCidrMask:  vpcCfg.publicSubnetCidrMask,
      privateSubnetCidrMask: vpcCfg.privateSubnetCidrMask,
    });

    const v = this.vpcConstruct;

    // ── SSM Parameters ────────────────────────────────────────────────────
    // Use SSM so downstream stacks can read values at deploy time even when
    // they run in separate pipeline stages or different CDK apps.

    this.putSsm(ssmPrefix, ENV_SSM.VPC_ID,    v.vpcId,          'VPC ID');
    this.putSsm(ssmPrefix, ENV_SSM.VPC_CIDR,  v.vpcCidrBlock,   'VPC CIDR block');

    // Subnet IDs stored as comma-separated strings
    this.putSsm(
      ssmPrefix, ENV_SSM.PUBLIC_SUBNET_IDS,
      v.publicSubnetIds.join(','),
      'Public subnet IDs (comma-separated)',
    );
    this.putSsm(
      ssmPrefix, ENV_SSM.PRIVATE_SUBNET_IDS,
      v.privateSubnetIds.join(','),
      'Private subnet IDs (comma-separated)',
    );
    this.putSsm(
      ssmPrefix, ENV_SSM.PRIVATE_ROUTE_TABLE_IDS,
      v.privateRouteTableIds.join(','),
      'Private route table IDs (comma-separated) – needed for NAT routes',
    );
    this.putSsm(
      ssmPrefix, ENV_SSM.PUBLIC_SUBNET_COUNT,
      String(v.publicSubnetIds.length),
      'Number of public subnets deployed',
    );
    this.putSsm(
      ssmPrefix, ENV_SSM.PRIVATE_SUBNET_COUNT,
      String(v.privateSubnetIds.length),
      'Number of private subnets deployed',
    );

    // Security group IDs
    this.putSsm(
      ssmPrefix, ENV_SSM.INTERNAL_SG_ID,
      v.internalSecurityGroup.securityGroupId,
      'Internal (VPC-wide) security group ID',
    );
    this.putSsm(
      ssmPrefix, ENV_SSM.PUBLIC_SG_ID,
      v.publicSecurityGroup.securityGroupId,
      'Public security group ID',
    );
    this.putSsm(
      ssmPrefix, ENV_SSM.PRIVATE_SG_ID,
      v.privateSecurityGroup.securityGroupId,
      'Private security group ID',
    );

    // ── CloudFormation Outputs ────────────────────────────────────────────
    new cdk.CfnOutput(this, 'VpcId', {
      value: v.vpcId,
      description: 'VPC ID',
      exportName: `${projectName}-${environment}-vpc-id`,
    });
    new cdk.CfnOutput(this, 'VpcCidr', {
      value: v.vpcCidrBlock,
      description: 'VPC CIDR block',
    });
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: v.publicSubnetIds.join(','),
      description: 'Public subnet IDs',
      exportName: `${projectName}-${environment}-public-subnet-ids`,
    });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: v.privateSubnetIds.join(','),
      description: 'Private subnet IDs',
      exportName: `${projectName}-${environment}-private-subnet-ids`,
    });
    new cdk.CfnOutput(this, 'PrivateRouteTableIds', {
      value: v.privateRouteTableIds.join(','),
      description: 'Private route table IDs (needed by ClientInfraStack)',
      exportName: `${projectName}-${environment}-private-rt-ids`,
    });
    new cdk.CfnOutput(this, 'InternalSgId', {
      value: v.internalSecurityGroup.securityGroupId,
      description: 'Internal security group ID',
      exportName: `${projectName}-${environment}-internal-sg-id`,
    });
    new cdk.CfnOutput(this, 'PublicSgId', {
      value: v.publicSecurityGroup.securityGroupId,
      description: 'Public security group ID',
      exportName: `${projectName}-${environment}-public-sg-id`,
    });
    new cdk.CfnOutput(this, 'PrivateSgId', {
      value: v.privateSecurityGroup.securityGroupId,
      description: 'Private security group ID',
      exportName: `${projectName}-${environment}-private-sg-id`,
    });
  }

  // ── Helper: write an SSM String parameter ────────────────────────────────
  private putSsm(prefix: string, name: string, value: string, description: string): void {
    new ssm.StringParameter(this, `Ssm${name.replace(/[^a-zA-Z0-9]/g, '')}`, {
      parameterName: `${prefix}/${name}`,
      stringValue: value,
      description,
      tier: ssm.ParameterTier.STANDARD,
    });
  }
}
