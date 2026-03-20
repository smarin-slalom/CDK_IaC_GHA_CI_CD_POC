// ─────────────────────────────────────────────────────────────────────────────
// stacks/ecs-stack.ts  –  Stack 3: ECS / Fargate Cluster
//
// Responsibility: Resources owned by the engineering team.
//   • ECS Cluster (Fargate + Fargate Spot)
//   • Task Execution Role & Task Role
//   • CloudWatch Log Group
//   • Cluster-level security group for Fargate tasks
//   • ECR access for pulling images
//
// Services, task definitions, target groups and auto-scaling are each
// deployed from the individual app repositories using the
// templates/app-service-stack.ts template.
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk  from 'aws-cdk-lib';
import * as ec2  from 'aws-cdk-lib/aws-ec2';
import * as iam  from 'aws-cdk-lib/aws-iam';
import * as ssm  from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { EcsClusterConstruct } from '../constructs';
import { EcsStackConfig } from '../config/config';
import { ENV_SSM } from './environment-stack';
import { CLIENT_INFRA_SSM } from './client-infra-stack';

export interface EcsStackProps extends cdk.StackProps {
  config: EcsStackConfig;
}

// ── SSM parameter name constants for this stack ───────────────────────────────
export const ECS_SSM = {
  CLUSTER_NAME:             'clusterName',
  CLUSTER_ARN:              'clusterArn',
  TASK_EXECUTION_ROLE_ARN:  'taskExecutionRoleArn',
  TASK_ROLE_ARN:            'taskRoleArn',
  LOG_GROUP_NAME:           'logGroupName',
  TASK_SG_ID:               'taskSecurityGroupId',
} as const;

export class EcsStack extends cdk.Stack {
  public readonly ecsClusterConstruct: EcsClusterConstruct;
  /** Security group assigned to all Fargate tasks in the cluster */
  public readonly taskSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { projectName, environment, environmentSsmPrefix, clientInfraSsmPrefix } = config;
    const ssmPrefix   = `/${projectName}/${environment}/ecs`;
    const namePrefix  = `${projectName}-${environment}`;

    // ── Read VPC state from SSM (written by EnvironmentStack) ─────────────
    const vpcId = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.VPC_ID}`,
    );
    const vpcCidr = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.VPC_CIDR}`,
    );
    const privateSgId = ssm.StringParameter.valueForStringParameter(
      this, `${environmentSsmPrefix}/${ENV_SSM.PRIVATE_SG_ID}`,
    );
    const albSgId = ssm.StringParameter.valueForStringParameter(
      this, `${clientInfraSsmPrefix}/${CLIENT_INFRA_SSM.ALB_SG_ID}`,
    );

    // ── Reconstruct L2 VPC object ─────────────────────────────────────────
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId,
      vpcCidrBlock: vpcCidr,
      availabilityZones: this.availabilityZones,
    });

    // ── Task security group ───────────────────────────────────────────────
    // Fargate tasks are placed in private subnets behind the ALB.
    // This SG only allows inbound traffic from the ALB SG on the task port
    // (port 80 by default – per-app services can add their own rules).
    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSG', {
      vpc,
      securityGroupName: `${namePrefix}-ecs-task-sg`,
      description: 'Fargate tasks – inbound from ALB and private SG only',
      allowAllOutbound: true,
    });

    // Allow the ALB SG to reach tasks on port 80
    this.taskSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSgId),
      ec2.Port.tcp(80),
      'ALB → task (default HTTP)',
    );
    // Allow ephemeral ports from ALB (required for health-checks and dynamic ports)
    this.taskSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSgId),
      ec2.Port.tcpRange(1024, 65535),
      'ALB → task ephemeral ports',
    );
    // Allow inbound from the private SG (service-to-service)
    this.taskSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(privateSgId),
      ec2.Port.allTcp(),
      'Private SG service-to-service',
    );

    // ── ECS Cluster construct ─────────────────────────────────────────────
    this.ecsClusterConstruct = new EcsClusterConstruct(this, 'EcsCluster', {
      projectName,
      environment,
      vpc,
      enableContainerInsights: true,
    });

    // ── Additional ECR permissions on the execution role ─────────────────
    // Allow pulling from any ECR repo in this account
    this.ecsClusterConstruct.taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowEcrAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetAuthorizationToken',
        ],
        resources: ['*'],
      }),
    );

    // ── SSM outputs for app-service stacks ────────────────────────────────
    this.putSsm(
      ssmPrefix, ECS_SSM.CLUSTER_NAME,
      this.ecsClusterConstruct.clusterName,
      'ECS cluster name',
    );
    this.putSsm(
      ssmPrefix, ECS_SSM.CLUSTER_ARN,
      this.ecsClusterConstruct.clusterArn,
      'ECS cluster ARN',
    );
    this.putSsm(
      ssmPrefix, ECS_SSM.TASK_EXECUTION_ROLE_ARN,
      this.ecsClusterConstruct.taskExecutionRole.roleArn,
      'ECS task execution role ARN',
    );
    this.putSsm(
      ssmPrefix, ECS_SSM.TASK_ROLE_ARN,
      this.ecsClusterConstruct.taskRole.roleArn,
      'ECS task role ARN',
    );
    this.putSsm(
      ssmPrefix, ECS_SSM.LOG_GROUP_NAME,
      this.ecsClusterConstruct.logGroupName,
      'CloudWatch log group name',
    );
    this.putSsm(
      ssmPrefix, ECS_SSM.TASK_SG_ID,
      this.taskSecurityGroup.securityGroupId,
      'Fargate task security group ID',
    );

    // ── CloudFormation outputs ────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.ecsClusterConstruct.clusterName,
      description: 'ECS cluster name',
      exportName: `${namePrefix}-cluster-name`,
    });
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.ecsClusterConstruct.clusterArn,
      description: 'ECS cluster ARN',
      exportName: `${namePrefix}-cluster-arn`,
    });
    new cdk.CfnOutput(this, 'TaskExecutionRoleArn', {
      value: this.ecsClusterConstruct.taskExecutionRole.roleArn,
      description: 'Task execution role ARN',
      exportName: `${namePrefix}-task-execution-role-arn`,
    });
    new cdk.CfnOutput(this, 'TaskRoleArn', {
      value: this.ecsClusterConstruct.taskRole.roleArn,
      description: 'Task role ARN',
      exportName: `${namePrefix}-task-role-arn`,
    });
    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.ecsClusterConstruct.logGroupName,
      description: 'CloudWatch log group name',
      exportName: `${namePrefix}-log-group-name`,
    });
    new cdk.CfnOutput(this, 'TaskSgId', {
      value: this.taskSecurityGroup.securityGroupId,
      description: 'Fargate task security group ID',
      exportName: `${namePrefix}-task-sg-id`,
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
