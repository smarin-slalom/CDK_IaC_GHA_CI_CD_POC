// ─────────────────────────────────────────────────────────────────────────────
// constructs/compute/ecs-cluster-construct.ts
//
// Reusable ECS Fargate cluster construct.  Creates:
//   • ECS Cluster with Fargate + Fargate Spot capacity providers
//   • Task Execution Role  – used by the ECS agent to pull images, write logs
//   • Task Role            – used by the application container at runtime
//   • CloudWatch Log Group (shared by all services in the cluster)
//   • Cluster-level security group for Fargate tasks
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk   from 'aws-cdk-lib';
import * as ec2   from 'aws-cdk-lib/aws-ec2';
import * as ecs   from 'aws-cdk-lib/aws-ecs';
import * as iam   from 'aws-cdk-lib/aws-iam';
import * as logs  from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface EcsClusterConstructProps {
  projectName: string;
  environment: string;
  /** L2 VPC object */
  vpc: ec2.IVpc;
  /** Log retention period (default: 1 month) */
  logRetentionDays?: logs.RetentionDays;
  /** Enable Container Insights (default: true) */
  enableContainerInsights?: boolean;
}

export class EcsClusterConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly clusterName: string;
  public readonly clusterArn: string;

  /** Role used by the ECS agent – pull ECR images, write CloudWatch logs */
  public readonly taskExecutionRole: iam.Role;

  /**
   * Default task role – application code runs as this role.
   * Services can extend it with additional permissions.
   */
  public readonly taskRole: iam.Role;

  /** Shared CloudWatch Log Group for all services */
  public readonly logGroup: logs.LogGroup;
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, props: EcsClusterConstructProps) {
    super(scope, id);

    const namePrefix = `${props.projectName}-${props.environment}`;

    // ── CloudWatch Log Group ──────────────────────────────────────────────
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${namePrefix}`,
      retention: props.logRetentionDays ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.logGroupName = this.logGroup.logGroupName;

    // ── Task Execution Role ───────────────────────────────────────────────
    // The ECS agent assumes this role to:
    //   • Pull container images from ECR
    //   • Write container logs to CloudWatch
    //   • Fetch secrets from Secrets Manager / SSM Parameter Store
    this.taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${namePrefix}-ecs-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role – used by the ECS agent',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // Allow reading specific SSM Parameter Store paths for secrets
    this.taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowSSMParameterAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [
        `arn:aws:ssm:*:*:parameter/${props.projectName}/${props.environment}/*`,
      ],
    }));

    // Allow reading secrets from Secrets Manager
    this.taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowSecretsManagerAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
      ],
      resources: [
        `arn:aws:secretsmanager:*:*:secret:${props.projectName}/${props.environment}/*`,
      ],
    }));

    // ── Task Role ─────────────────────────────────────────────────────────
    // Application code runs as this role.
    // Each service can add further policies via taskRole.addToPolicy().
    this.taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${namePrefix}-ecs-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task role – assumed by the running application container',
    });

    // Minimal permissions: write to its own log group
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogs',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [this.logGroup.logGroupArn],
    }));

    // Allow X-Ray tracing
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowXRay',
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
      ],
      resources: ['*'],
    }));

    // ── ECS Cluster ───────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${namePrefix}-cluster`,
      vpc: props.vpc,
      containerInsights: props.enableContainerInsights ?? true,
      enableFargateCapacityProviders: true,
    });

    this.clusterName = this.cluster.clusterName;
    this.clusterArn  = this.cluster.clusterArn;

    // ── CloudFormation outputs ────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS cluster name',
      exportName: `${namePrefix}-cluster-name`,
    });
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      description: 'ECS cluster ARN',
      exportName: `${namePrefix}-cluster-arn`,
    });
    new cdk.CfnOutput(this, 'TaskExecutionRoleArn', {
      value: this.taskExecutionRole.roleArn,
      description: 'ECS task execution role ARN',
      exportName: `${namePrefix}-task-execution-role-arn`,
    });
    new cdk.CfnOutput(this, 'TaskRoleArn', {
      value: this.taskRole.roleArn,
      description: 'ECS task role ARN',
      exportName: `${namePrefix}-task-role-arn`,
    });
    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      description: 'CloudWatch log group name',
      exportName: `${namePrefix}-log-group-name`,
    });
  }
}
