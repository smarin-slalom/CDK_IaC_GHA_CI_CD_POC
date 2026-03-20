// ─────────────────────────────────────────────────────────────────────────────
// templates/app-service-stack.ts
//
// Template for individual application repositories.
// Copy this file into your app repo under infrastructure/ and customise the
// AppServiceConfig for that specific service.
//
// What this stack deploys:
//   • Fargate Task Definition  (cpu / memory configurable)
//   • ECS Service              (2 minimum tasks, N maximum – per spec)
//   • ALB Target Group         (registers with the ALB HTTP listener)
//   • ALB Listener Rule        (routes traffic by path or host header)
//   • Auto-scaling policy:
//       – Scale OUT  when CPU > 80%  (add 1 task, 60 s cooldown)
//       – Scale IN   when CPU < 20%  (remove 1 task, 300 s cooldown)
//
// Prerequisites: EnvironmentStack, ClientInfraStack, EcsStack must be
//               deployed first (reads from SSM).
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk        from 'aws-cdk-lib';
import * as ec2        from 'aws-cdk-lib/aws-ec2';
import * as ecs        from 'aws-cdk-lib/aws-ecs';
import * as elbv2      from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam        from 'aws-cdk-lib/aws-iam';
import * as logs       from 'aws-cdk-lib/aws-logs';
import * as ssm        from 'aws-cdk-lib/aws-ssm';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { Construct }   from 'constructs';

// ── App-level configuration ───────────────────────────────────────────────────

export interface ContainerConfig {
  /** ECR image URI, e.g. "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-app:latest" */
  imageUri: string;
  /** Container port the application listens on (default 80) */
  containerPort: number;
  /** CPU units for the task (256 | 512 | 1024 | 2048 | 4096) */
  cpu: 256 | 512 | 1024 | 2048 | 4096;
  /** Memory (MiB) for the task */
  memoryMiB: 512 | 1024 | 2048 | 3072 | 4096 | 5120 | 6144 | 7168 | 8192;
  /** Environment variables injected into the container */
  environment?: Record<string, string>;
  /** Secrets pulled from SSM Parameter Store / Secrets Manager */
  secrets?: Record<string, ecs.Secret>;
}

export interface ScalingConfig {
  /** Minimum running tasks (spec: always ≥ 2) */
  minCapacity: number;
  /** Maximum running tasks – set per application */
  maxCapacity: number;
  /** CPU utilisation % above which to scale out (spec: 80) */
  scaleOutCpuPercent: number;
  /** CPU utilisation % below which to scale in (spec: 20) */
  scaleInCpuPercent: number;
  /** Seconds to wait after scaling out before considering another scale-out */
  scaleOutCooldownSec: number;
  /** Seconds to wait after scaling in before considering another scale-in */
  scaleInCooldownSec: number;
}

export interface AlbRoutingConfig {
  /**
   * Path pattern for the ALB listener rule, e.g. "/api/users*".
   * If omitted, a host-header rule is used (requires hostHeader).
   */
  pathPattern?: string;
  /** Host header, e.g. "users.example.com" */
  hostHeader?: string;
  /** Health check path (default "/health") */
  healthCheckPath: string;
  /** Health check grace period seconds (default 60) */
  healthCheckGracePeriodSec?: number;
}

export interface AppServiceConfig {
  /** Application / service name (lowercase, no spaces) */
  appName: string;
  projectName: string;
  environment: string;
  container: ContainerConfig;
  scaling: ScalingConfig;
  albRouting: AlbRoutingConfig;
}

export interface AppServiceStackProps extends cdk.StackProps {
  config: AppServiceConfig;
}

// ── Stack ─────────────────────────────────────────────────────────────────────

export class AppServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: AppServiceStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { projectName, environment, appName } = config;
    const namePrefix = `${projectName}-${environment}-${appName}`;

    // ── SSM prefixes (must match values written by infrastructure stacks) ──
    const envSsmPrefix          = `/${projectName}/${environment}/environment`;
    const clientInfraSsmPrefix  = `/${projectName}/${environment}/client-infra`;
    const ecsSsmPrefix          = `/${projectName}/${environment}/ecs`;

    // ── Read shared infrastructure values from SSM ─────────────────────────
    const vpcId = ssm.StringParameter.valueForStringParameter(
      this, `${envSsmPrefix}/vpcId`,
    );
    const vpcCidr = ssm.StringParameter.valueForStringParameter(
      this, `${envSsmPrefix}/vpcCidr`,
    );
    const privateSubnetIdsRaw = ssm.StringParameter.valueForStringParameter(
      this, `${envSsmPrefix}/privateSubnetIds`,
    );
    const taskSgId = ssm.StringParameter.valueForStringParameter(
      this, `${ecsSsmPrefix}/taskSecurityGroupId`,
    );
    const clusterName = ssm.StringParameter.valueForStringParameter(
      this, `${ecsSsmPrefix}/clusterName`,
    );
    const clusterArn = ssm.StringParameter.valueForStringParameter(
      this, `${ecsSsmPrefix}/clusterArn`,
    );
    const taskExecutionRoleArn = ssm.StringParameter.valueForStringParameter(
      this, `${ecsSsmPrefix}/taskExecutionRoleArn`,
    );
    const taskRoleArn = ssm.StringParameter.valueForStringParameter(
      this, `${ecsSsmPrefix}/taskRoleArn`,
    );
    const logGroupName = ssm.StringParameter.valueForStringParameter(
      this, `${ecsSsmPrefix}/logGroupName`,
    );
    const httpListenerArn = ssm.StringParameter.valueForStringParameter(
      this, `${clientInfraSsmPrefix}/httpListenerArn`,
    );
    const albArn = ssm.StringParameter.valueForStringParameter(
      this, `${clientInfraSsmPrefix}/albArn`,
    );

    // ── Reconstruct L2 objects ────────────────────────────────────────────
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId,
      vpcCidrBlock: vpcCidr,
      availabilityZones: this.availabilityZones,
    });

    const privateSubnetTokens = cdk.Fn.split(',', privateSubnetIdsRaw);
    // Create subnet objects (adjust count to match your deployment)
    const privateSubnets: ec2.ISubnet[] = [0, 1].map(i =>
      ec2.Subnet.fromSubnetId(this, `PrivateSub${i}`, cdk.Fn.select(i, privateSubnetTokens)),
    );

    const taskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this, 'TaskSG', taskSgId,
    );

    // ── Allow inbound on the container port from the ALB SG ───────────────
    const albSgId = ssm.StringParameter.valueForStringParameter(
      this, `${clientInfraSsmPrefix}/albSecurityGroupId`,
    );
    const albSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'AlbSG', albSgId);

    // Import cluster
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterName,
      clusterArn,
      vpc,
      securityGroups: [],
    });

    // Import roles
    const executionRole = iam.Role.fromRoleArn(
      this, 'ExecutionRole', taskExecutionRoleArn,
    );
    const taskRole = iam.Role.fromRoleArn(
      this, 'TaskRole', taskRoleArn,
    );

    // ── Task Definition ───────────────────────────────────────────────────
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: namePrefix,
      cpu: config.container.cpu,
      memoryLimitMiB: config.container.memoryMiB,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // ── Container ─────────────────────────────────────────────────────────
    const container = this.taskDefinition.addContainer('AppContainer', {
      containerName: appName,
      image: ecs.ContainerImage.fromRegistry(config.container.imageUri),
      cpu: config.container.cpu,
      memoryLimitMiB: config.container.memoryMiB,
      essential: true,
      environment: config.container.environment ?? {},
      secrets: config.container.secrets ?? {},
      logging: ecs.LogDriver.awsLogs({
        logGroup: logs.LogGroup.fromLogGroupName(this, 'LogGroup', logGroupName),
        streamPrefix: appName,
      }),
      healthCheck: {
        command: [
          'CMD-SHELL',
          `curl -f http://localhost:${config.container.containerPort}${config.albRouting.healthCheckPath} || exit 1`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      portMappings: [{
        containerPort: config.container.containerPort,
        protocol: ecs.Protocol.TCP,
        name: `${appName}-port`,
      }],
    });

    // ── Target Group ──────────────────────────────────────────────────────
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: `${namePrefix}-tg`,
      vpc,
      port: config.container.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        path: config.albRouting.healthCheckPath,
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: '200-299',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Register target group with the ALB listener ────────────────────────
    // This informs the load balancer to route traffic to the new service.
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(
      this, 'HttpListener', {
        listenerArn: httpListenerArn,
        securityGroup: albSg,
      },
    );

    const conditions: elbv2.ListenerCondition[] = [];
    if (config.albRouting.pathPattern) {
      conditions.push(
        elbv2.ListenerCondition.pathPatterns([config.albRouting.pathPattern]),
      );
    }
    if (config.albRouting.hostHeader) {
      conditions.push(
        elbv2.ListenerCondition.hostHeaders([config.albRouting.hostHeader]),
      );
    }

    // Use a stable priority derived from the app name hash to avoid conflicts
    const priority = Math.abs(
      Array.from(appName).reduce((acc, c) => acc + c.charCodeAt(0), 0),
    ) % 49900 + 100; // range: 100 – 50000

    new elbv2.ApplicationListenerRule(this, 'ListenerRule', {
      listener,
      priority,
      conditions,
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // ── ECS Fargate Service ───────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: namePrefix,
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: config.scaling.minCapacity,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [taskSecurityGroup],
      assignPublicIp: false,
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE',      weight: 1, base: config.scaling.minCapacity },
        { capacityProvider: 'FARGATE_SPOT', weight: 4, base: 0 },
      ],
      healthCheckGracePeriod: cdk.Duration.seconds(
        config.albRouting.healthCheckGracePeriodSec ?? 60,
      ),
      enableExecuteCommand: true,
      circuitBreaker: {
        enable: true,
        rollback: true,
      },
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      // CDK v2: loadBalancers is not a FargateServiceProps field.
      // Wire the target group after construction via addTarget() below.
    });

    // Register the service as a target of the ALB target group.
    // This is the correct CDK v2 pattern – it calls registerLoadBalancerTargets
    // on the task definition internally.
    this.targetGroup.addTarget(this.service);

    // ── Auto-Scaling ──────────────────────────────────────────────────────
    // Per spec:
    //   • Minimum tasks: 2  (always 2 running per region)
    //   • Maximum tasks: configurable per app
    //   • Scale OUT: CPU > 80%  → add 1 task (60 s cooldown)
    //   • Scale IN:  CPU < 20%  → remove 1 task (300 s cooldown)

    // ── Auto-Scaling ──────────────────────────────────────────────────────
    // Per spec:
    //   • Minimum tasks: 2  (always 2 running per region)
    //   • Maximum tasks: configurable per app
    //   • Scale OUT: CPU > 80%  → +1 task, 60 s cooldown
    //   • Scale IN:  CPU < 20%  → −1 task, 300 s cooldown
    //
    // We use StepScalingAction (low-level) rather than StepScalingPolicy
    // (high-level) because we need separate cooldowns per direction and want
    // to own the CloudWatch alarms ourselves.

    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity: config.scaling.minCapacity,
      maxCapacity: config.scaling.maxCapacity,
    });

    // ── Scale-OUT action (+1 task when CPU is high) ───────────────────────
    const scaleOutAction = new appscaling.StepScalingAction(this, 'ScaleOutAction', {
      scalingTarget,
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(config.scaling.scaleOutCooldownSec),
      metricAggregationType: appscaling.MetricAggregationType.AVERAGE,
    });
    // lowerBound: 0 means "add 1 task for any breach above the alarm threshold"
    scaleOutAction.addAdjustment({ adjustment: +1, lowerBound: 0 });

    // ── Scale-IN action (−1 task when CPU is low) ─────────────────────────
    const scaleInAction = new appscaling.StepScalingAction(this, 'ScaleInAction', {
      scalingTarget,
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(config.scaling.scaleInCooldownSec),
      metricAggregationType: appscaling.MetricAggregationType.AVERAGE,
    });
    // upperBound: 0 means "remove 1 task for any breach below the alarm threshold"
    scaleInAction.addAdjustment({ adjustment: -1, upperBound: 0 });

    // ── CloudWatch Alarms ─────────────────────────────────────────────────
    const cpuMetric = this.service.metricCpuUtilization({
      period: cdk.Duration.minutes(1),
    });

    const scaleOutAlarm = new cdk.aws_cloudwatch.Alarm(this, 'ScaleOutAlarm', {
      metric: cpuMetric,
      threshold: config.scaling.scaleOutCpuPercent,
      comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: `${namePrefix}-cpu-high`,
      alarmDescription: `CPU ≥ ${config.scaling.scaleOutCpuPercent}% – scale out`,
    });

    const scaleInAlarm = new cdk.aws_cloudwatch.Alarm(this, 'ScaleInAlarm', {
      metric: cpuMetric,
      threshold: config.scaling.scaleInCpuPercent,
      comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: `${namePrefix}-cpu-low`,
      alarmDescription: `CPU ≤ ${config.scaling.scaleInCpuPercent}% – scale in`,
    });

    // Wire alarms → actions
    // ApplicationScalingAction wraps a StepScalingAction (not StepScalingPolicy)
    scaleOutAlarm.addAlarmAction(
      new cdk.aws_cloudwatch_actions.ApplicationScalingAction(scaleOutAction),
    );
    scaleInAlarm.addAlarmAction(
      new cdk.aws_cloudwatch_actions.ApplicationScalingAction(scaleInAction),
    );

    // ── CloudFormation Outputs ────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: `${appName} ECS service name`,
    });
    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
      description: `${appName} ALB target group ARN`,
    });
    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: this.taskDefinition.taskDefinitionArn,
      description: `${appName} task definition ARN`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Example: bin/app.ts in an app repository
// ─────────────────────────────────────────────────────────────────────────────
//
// import 'source-map-support/register';
// import * as cdk from 'aws-cdk-lib';
// import { AppServiceStack } from '../infrastructure/templates/app-service-stack';
//
// const app = new cdk.App();
//
// new AppServiceStack(app, 'UsersServiceStack', {
//   stackName: 'migration-poc-poc-users-service',
//   env: {
//     account: process.env.CDK_DEFAULT_ACCOUNT,
//     region:  process.env.CDK_DEFAULT_REGION,
//   },
//   config: {
//     appName:     'users',
//     projectName: 'migration-poc',
//     environment: 'poc',
//     container: {
//       imageUri:    '123456789012.dkr.ecr.us-east-1.amazonaws.com/users:latest',
//       containerPort: 8080,
//       cpu:         512,
//       memoryMiB:  1024,
//       environment: {
//         NODE_ENV:  'production',
//         LOG_LEVEL: 'info',
//       },
//     },
//     scaling: {
//       minCapacity:        2,
//       maxCapacity:        12,      // ← app-specific maximum
//       scaleOutCpuPercent: 80,
//       scaleInCpuPercent:  20,
//       scaleOutCooldownSec: 60,
//       scaleInCooldownSec: 300,
//     },
//     albRouting: {
//       pathPattern:    '/api/users*',
//       healthCheckPath: '/health',
//     },
//   },
// });
//
// app.synth();
