// ─────────────────────────────────────────────────────────────────────────────
// constructs/vpc/vpc-construct.ts
//
// Reusable VPC construct.  Creates:
//   • VPC with configurable CIDR
//   • Internet Gateway + attachment
//   • N public subnets  (PUBLIC, /mask)  – one per AZ per subnet-config
//   • M private subnets (PRIVATE_ISOLATED initially) – NAT routes added later
//   • Route tables with public → IGW routes
//   • Security groups: internal SG, public SG, private SG
//   • VPC Flow Logs
//   • Exposes L2 IVpc / ISubnet[] objects for downstream constructs
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk from 'aws-cdk-lib';
import * as ec2  from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface VpcConstructProps {
  /** Tag name applied to the VPC resource */
  vpcName: string;
  /** VPC CIDR block, e.g. "10.0.0.0/16" */
  cidr: string;
  /** Maximum AZs.  CDK creates one subnet per AZ per SubnetConfiguration. */
  maxAzs: number;
  /** Number of PUBLIC subnet configurations to create */
  numPublicSubnets: number;
  /** Number of PRIVATE (isolated) subnet configurations to create */
  numPrivateSubnets: number;
  /** CIDR prefix length for each public subnet, e.g. 24 → /24 */
  publicSubnetCidrMask: number;
  /** CIDR prefix length for each private subnet, e.g. 24 → /24 */
  privateSubnetCidrMask: number;
}

export class VpcConstruct extends Construct {
  // ── L2 objects for direct CDK usage ──────────────────────────────────────
  public readonly vpc: ec2.IVpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];

  // ── Raw IDs for SSM export & cross-stack references ──────────────────────
  public readonly vpcId: string;
  public readonly vpcCidrBlock: string;
  public readonly publicSubnetIds: string[];
  public readonly privateSubnetIds: string[];

  /**
   * Route table IDs for the private subnets.
   * Exported so ClientInfraStack can wire NAT Gateway routes.
   */
  public readonly privateRouteTableIds: string[];

  // ── Security groups ───────────────────────────────────────────────────────
  /** Allows all inbound traffic within the VPC CIDR. */
  public readonly internalSecurityGroup: ec2.SecurityGroup;
  /** Allows HTTP (80) + HTTPS (443) from the internet. Used for the ALB. */
  public readonly publicSecurityGroup: ec2.SecurityGroup;
  /** Allows inbound only from publicSG and internalSG. Used for ECS tasks. */
  public readonly privateSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);

    // ── Build subnet configurations ────────────────────────────────────────
    const subnetConfigs: ec2.SubnetConfiguration[] = [];

    for (let i = 0; i < props.numPublicSubnets; i++) {
      subnetConfigs.push({
        name: `Public${i === 0 ? '' : i + 1}`,
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: props.publicSubnetCidrMask,
        mapPublicIpOnLaunch: true,
      });
    }

    for (let i = 0; i < props.numPrivateSubnets; i++) {
      subnetConfigs.push({
        name: `Private${i + 1}`,
        // PRIVATE_ISOLATED = no NAT route.  ClientInfraStack adds the route
        // after the NAT Gateway is created.
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: props.privateSubnetCidrMask,
      });
    }

    // ── VPC ───────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: props.vpcName,
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: props.maxAzs,
      natGateways: 0,          // NAT created + wired in ClientInfraStack
      subnetConfiguration: subnetConfigs,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    cdk.Tags.of(vpc).add('Name', props.vpcName);

    // ── Expose objects & IDs ──────────────────────────────────────────────
    this.vpc          = vpc;
    this.vpcId        = vpc.vpcId;
    this.vpcCidrBlock = vpc.vpcCidrBlock;

    this.publicSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PUBLIC,
    }).subnets;

    this.privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    }).subnets;

    this.publicSubnetIds  = this.publicSubnets.map(s => s.subnetId);
    this.privateSubnetIds = this.privateSubnets.map(s => s.subnetId);

    // Private route table IDs – needed by NatGatewayConstruct to add routes
    this.privateRouteTableIds = this.privateSubnets.map(
      s => (s as ec2.Subnet).routeTable.routeTableId,
    );

    // ── Tag subnets ───────────────────────────────────────────────────────
    this.publicSubnets.forEach((s, i) => {
      cdk.Tags.of(s).add('Name', `${props.vpcName}-public-${i + 1}`);
      cdk.Tags.of(s).add('SubnetType', 'Public');
    });
    this.privateSubnets.forEach((s, i) => {
      cdk.Tags.of(s).add('Name', `${props.vpcName}-private-${i + 1}`);
      cdk.Tags.of(s).add('SubnetType', 'Private');
    });

    // ── Security Groups ───────────────────────────────────────────────────

    this.internalSecurityGroup = new ec2.SecurityGroup(this, 'InternalSG', {
      vpc,
      securityGroupName: `${props.vpcName}-internal-sg`,
      description: 'Allow all inbound traffic within the VPC CIDR',
      allowAllOutbound: true,
    });
    this.internalSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.cidr),
      ec2.Port.allTraffic(),
      'VPC-internal traffic',
    );

    this.publicSecurityGroup = new ec2.SecurityGroup(this, 'PublicSG', {
      vpc,
      securityGroupName: `${props.vpcName}-public-sg`,
      description: 'Internet-facing resources – HTTP/HTTPS inbound',
      allowAllOutbound: true,
    });
    this.publicSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet',
    );
    this.publicSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet',
    );

    this.privateSecurityGroup = new ec2.SecurityGroup(this, 'PrivateSG', {
      vpc,
      securityGroupName: `${props.vpcName}-private-sg`,
      description: 'Private workloads – inbound from public/internal SGs only',
      allowAllOutbound: true,
    });
    this.privateSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.publicSecurityGroup.securityGroupId),
      ec2.Port.allTcp(),
      'All TCP from public SG (ALB → tasks)',
    );
    this.privateSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.internalSecurityGroup.securityGroupId),
      ec2.Port.allTcp(),
      'All TCP from internal SG (service-to-service)',
    );

    // ── VPC Flow Logs (best-practice for audit/troubleshooting) ──────────
    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
  }
}
