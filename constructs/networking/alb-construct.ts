// ─────────────────────────────────────────────────────────────────────────────
// constructs/networking/alb-construct.ts
//
// Reusable Application Load Balancer construct.  Creates:
//   • Application Load Balancer (internet-facing) in the public subnets
//   • HTTP listener on port 80  – returns 404 by default; services add rules
//   • Optional HTTPS listener on port 443 (requires ACM cert ARN)
//   • ALB-specific security group (allows 80/443 from internet → tasks via SG)
//   • IAM role for ALB access logs (if log bucket provided)
//
// Each app service registers its own TargetGroup + listener rule via
// the helper method `addTargetGroup()` exposed on this construct.
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk  from 'aws-cdk-lib';
import * as ec2  from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface AlbConstructProps {
  projectName: string;
  environment: string;
  /** L2 VPC object */
  vpc: ec2.IVpc;
  /** Public subnets where the ALB will be placed (minimum 2 AZs for HA) */
  publicSubnets: ec2.ISubnet[];
  /** SG that already allows 80/443 from internet (from VpcConstruct) */
  publicSecurityGroup: ec2.SecurityGroup;
  /** If provided, HTTPS listener + redirect will be configured */
  certificateArn?: string;
  /** If provided, access logs are stored in this S3 bucket */
  accessLogsBucketName?: string;
  /** Idle timeout in seconds (default 60) */
  idleTimeoutSec?: number;
}

export class AlbConstruct extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpListener: elbv2.ApplicationListener;
  public readonly httpsListener?: elbv2.ApplicationListener;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly albArn: string;
  public readonly albDnsName: string;
  public readonly httpListenerArn: string;
  public readonly httpsListenerArn?: string;

  /** Running counter for listener rule priorities */
  private listenerRulePriority = 10;

  constructor(scope: Construct, id: string, props: AlbConstructProps) {
    super(scope, id);

    const namePrefix = `${props.projectName}-${props.environment}`;

    // ── ALB security group ────────────────────────────────────────────────
    // A dedicated SG makes it easy to reference the ALB as a source in
    // the private (task) security group rules.
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      securityGroupName: `${namePrefix}-alb-sg`,
      description: 'ALB – internet-facing HTTP/HTTPS',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(80),  'HTTP from internet',
    );
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet',
    );

    // Also allow the existing public SG to be used interchangeably
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(props.publicSecurityGroup.securityGroupId),
      ec2.Port.allTcp(),
      'Public SG passthrough',
    );

    // ── ALB ───────────────────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${namePrefix}-alb`,
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnets: props.publicSubnets },
      securityGroup: this.albSecurityGroup,
      idleTimeout: cdk.Duration.seconds(props.idleTimeoutSec ?? 60),
      deletionProtection: false, // set true in production
    });

    this.albArn     = this.alb.loadBalancerArn;
    this.albDnsName = this.alb.loadBalancerDnsName;

    // Optional access logs
    if (props.accessLogsBucketName) {
      this.alb.logAccessLogs(
        cdk.aws_s3.Bucket.fromBucketName(this, 'LogBucket', props.accessLogsBucketName),
        `${namePrefix}-alb-logs`,
      );
    }

    // ── HTTP listener (default: 404) ──────────────────────────────────────
    // App services add their own path/host rules via addTargetGroup().
    this.httpListener = this.alb.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: '{"error":"Not Found"}',
      }),
    });
    this.httpListenerArn = this.httpListener.listenerArn;

    // ── HTTPS listener (optional) ─────────────────────────────────────────
    if (props.certificateArn) {
      const cert = elbv2.ListenerCertificate.fromArn(props.certificateArn);

      this.httpsListener = this.alb.addListener('HttpsListener', {
        port: 443,
        open: true,
        certificates: [cert],
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: 'application/json',
          messageBody: '{"error":"Not Found"}',
        }),
      });
      this.httpsListenerArn = this.httpsListener.listenerArn;

      // Redirect HTTP → HTTPS
      this.httpListener.addAction('HttpToHttpsRedirect', {
        priority: 1,
        conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
        action: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    }

    // ── CloudFormation outputs ────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name',
      exportName: `${namePrefix}-alb-dns`,
    });
    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.alb.loadBalancerArn,
      description: 'ALB ARN',
      exportName: `${namePrefix}-alb-arn`,
    });
    new cdk.CfnOutput(this, 'HttpListenerArn', {
      value: this.httpListener.listenerArn,
      description: 'HTTP listener ARN',
      exportName: `${namePrefix}-alb-http-listener-arn`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // addTargetGroup()
  //
  // Called by each app-service stack to register a target group with the ALB.
  // Adds a forward rule on the HTTP (and HTTPS if configured) listener.
  //
  // Parameters:
  //   targetGroup  – the elbv2.ApplicationTargetGroup created by the service
  //   pathPattern  – e.g. "/api/users*"
  //   hostHeader   – optional, e.g. "api.example.com"
  // ─────────────────────────────────────────────────────────────────────────
  public addTargetGroup(
    targetGroup: elbv2.ApplicationTargetGroup,
    pathPattern?: string,
    hostHeader?: string,
  ): void {
    const conditions: elbv2.ListenerCondition[] = [];
    if (pathPattern) {
      conditions.push(elbv2.ListenerCondition.pathPatterns([pathPattern]));
    }
    if (hostHeader) {
      conditions.push(elbv2.ListenerCondition.hostHeaders([hostHeader]));
    }

    const priority = this.listenerRulePriority;
    this.listenerRulePriority += 10;

    if (conditions.length > 0) {
      this.httpListener.addTargetGroups(`HttpRule${priority}`, {
        targetGroups: [targetGroup],
        priority,
        conditions,
      });
      this.httpsListener?.addTargetGroups(`HttpsRule${priority}`, {
        targetGroups: [targetGroup],
        priority,
        conditions,
      });
    } else {
      // No conditions → set as default forward action
      this.httpListener.addDefaultTargetGroups([targetGroup]);
      this.httpsListener?.addDefaultTargetGroups([targetGroup]);
    }
  }
}
