// ─────────────────────────────────────────────────────────────────────────────
// stacks/client-infra-stack.ts  –  Stack 2: Client Infrastructure
//
// Responsibility: Resources owned and managed by the client.
//   • NAT Gateway  (placed in public subnet, routes private subnets outbound)
//   • Application Load Balancer (internet-facing, public subnets)
//   • ALB HTTP/HTTPS listeners
//
// Reads networking state from SSM (written by EnvironmentStack).
// Writes its own outputs to SSM for EcsStack to consume.
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk  from 'aws-cdk-lib';
import * as ec2  from 'aws-cdk-lib/aws-ec2';
import * as ssm  from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { NatGatewayConstruct, AlbConstruct } from '../constructs';
import { ClientInfraStackConfig } from '../config/config';
import { ENV_SSM } from './environment-stack';

export interface ClientInfraStackProps extends cdk.StackProps {
  config: ClientInfraStackConfig;
  /** Optional ACM certificate ARN for HTTPS */
  certificateArn?: string;
}

// ── SSM parameter name constants for this stack ───────────────────────────────
export const CLIENT_INFRA_SSM = {
  NAT_GW_ID:            'natGatewayId',
  ALB_ARN:              'albArn',
  ALB_DNS_NAME:         'albDnsName',
  ALB_SG_ID:            'albSecurityGroupId',
  HTTP_LISTENER_ARN:    'httpListenerArn',
  HTTPS_LISTENER_ARN:   'httpsListenerArn',
} as const;

export class ClientInfraStack extends cdk.Stack {
  public readonly natGatewayConstruct: NatGatewayConstruct;
  public readonly albConstruct: AlbConstruct;

  constructor(scope: Construct, id: string, props: ClientInfraStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { projectName, environment, environmentSsmPrefix } = config;
    const ssmPrefix = `/${projectName}/${environment}/client-infra`;

    // ── Read environment outputs from SSM ─────────────────────────────────
    const vpcId = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.VPC_ID}`,
    );
    const vpcCidr = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.VPC_CIDR}`,
    );
    const publicSubnetIdsRaw = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.PUBLIC_SUBNET_IDS}`,
    );
    const privateRouteTableIdsRaw = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.PRIVATE_ROUTE_TABLE_IDS}`,
    );
    const publicSgId = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.PUBLIC_SG_ID}`,
    );

    // ── Reconstruct L2 VPC / subnet objects for CDK constructs ───────────
    // We use fromVpcAttributes + fromSubnetId to avoid a VPC lookup
    // (which would require `--context` or a bootstrap lookup role).
    //
    // The subnet IDs SSM value is a comma-separated token.  CDK resolves
    // it at CloudFormation deployment time, so we use Fn.split here.
    const publicSubnetIdTokens = cdk.Fn.split(',', publicSubnetIdsRaw);
    const privateRtIdTokens    = cdk.Fn.split(',', privateRouteTableIdsRaw);

    // We need concrete subnet counts to build the arrays.
    // These are stored as plain strings in SSM – read them as strings
    // and parse to numbers.  For the POC we hard-code based on config;
    // in a dynamic multi-region setup, read from SSM as well.
    const numPublicSubnets  = cdk.Token.isUnresolved(publicSubnetIdsRaw)
      ? 2   // fallback – will be overridden by actual SSM value at runtime
      : publicSubnetIdsRaw.split(',').length;

    // Build subnet objects array from the token
    const publicSubnetObjects: ec2.ISubnet[] = Array.from(
      { length: numPublicSubnets },
      (_, i) => ec2.Subnet.fromSubnetId(
        this, `PublicSubnet${i}`, cdk.Fn.select(i, publicSubnetIdTokens),
      ),
    );

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId,
      vpcCidrBlock: vpcCidr,
      availabilityZones: this.availabilityZones,
    });

    const publicSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 'ImportedPublicSG', publicSgId,
    ) as ec2.SecurityGroup;

    // ── NAT Gateway ───────────────────────────────────────────────────────
    // Placed in the FIRST public subnet.
    // Routes all private subnet traffic (0.0.0.0/0) through it.
    //
    // Note: AWS requires a NAT Gateway to be in a public subnet (a subnet
    // that has a route to an Internet Gateway).  Private subnets then
    // point their default route at the NAT GW for outbound internet access.
    this.natGatewayConstruct = new NatGatewayConstruct(this, 'NatGateway', {
      publicSubnetId: cdk.Fn.select(0, publicSubnetIdTokens),
      // Pass all private route table IDs so every private subnet gets the route
      privateRouteTableIds: [
        cdk.Fn.select(0, privateRtIdTokens),
        cdk.Fn.select(1, privateRtIdTokens),
      ],
      projectName,
      environment,
    });

    // ── Application Load Balancer ─────────────────────────────────────────
    this.albConstruct = new AlbConstruct(this, 'Alb', {
      projectName,
      environment,
      vpc,
      publicSubnets: publicSubnetObjects,
      publicSecurityGroup,
      certificateArn: props.certificateArn,
    });

    // ── SSM outputs for EcsStack ──────────────────────────────────────────
    this.putSsm(
      ssmPrefix, CLIENT_INFRA_SSM.NAT_GW_ID,
      this.natGatewayConstruct.natGatewayId,
      'NAT Gateway ID',
    );
    this.putSsm(
      ssmPrefix, CLIENT_INFRA_SSM.ALB_ARN,
      this.albConstruct.albArn,
      'ALB ARN',
    );
    this.putSsm(
      ssmPrefix, CLIENT_INFRA_SSM.ALB_DNS_NAME,
      this.albConstruct.albDnsName,
      'ALB DNS name',
    );
    this.putSsm(
      ssmPrefix, CLIENT_INFRA_SSM.ALB_SG_ID,
      this.albConstruct.albSecurityGroup.securityGroupId,
      'ALB security group ID',
    );
    this.putSsm(
      ssmPrefix, CLIENT_INFRA_SSM.HTTP_LISTENER_ARN,
      this.albConstruct.httpListenerArn,
      'ALB HTTP listener ARN',
    );
    if (this.albConstruct.httpsListenerArn) {
      this.putSsm(
        ssmPrefix, CLIENT_INFRA_SSM.HTTPS_LISTENER_ARN,
        this.albConstruct.httpsListenerArn,
        'ALB HTTPS listener ARN',
      );
    }

    // ── CloudFormation outputs ────────────────────────────────────────────
    new cdk.CfnOutput(this, 'NatGatewayId', {
      value: this.natGatewayConstruct.natGatewayId,
      description: 'NAT Gateway ID',
    });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.albConstruct.albDnsName,
      description: 'ALB DNS name – use this as the CNAME for your domain',
      exportName: `${projectName}-${environment}-alb-dns`,
    });
    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.albConstruct.albArn,
      description: 'ALB ARN',
      exportName: `${projectName}-${environment}-alb-arn`,
    });
    new cdk.CfnOutput(this, 'HttpListenerArn', {
      value: this.albConstruct.httpListenerArn,
      description: 'HTTP listener ARN – referenced by app service stacks',
      exportName: `${projectName}-${environment}-http-listener-arn`,
    });
  }

  private putSsm(prefix: string, name: string, value: string, description: string): void {
    new ssm.StringParameter(this, `Ssm${name.replace(/[^a-zA-Z0-9]/g, '')}`, {
      parameterName: `${prefix}/${name}`,
      stringValue: value,
      description,
      tier: ssm.ParameterTier.STANDARD,
    });
  }
}
