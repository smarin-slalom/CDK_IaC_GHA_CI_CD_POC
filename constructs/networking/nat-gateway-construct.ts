// ─────────────────────────────────────────────────────────────────────────────
// constructs/networking/nat-gateway-construct.ts
//
// Reusable NAT Gateway construct.  Creates:
//   • Elastic IP
//   • NAT Gateway placed in a PUBLIC subnet (AWS requirement – a NAT GW
//     must reside in a public subnet to reach the internet)
//   • A 0.0.0.0/0 route in every supplied private route table pointing to
//     the NAT Gateway so private subnets gain outbound internet access
//
// Usage pattern:
//   EnvironmentStack   → deploys VPC + PRIVATE_ISOLATED subnets, exports
//                        private route table IDs via SSM
//   ClientInfraStack   → imports those IDs, creates this construct, which
//                        patches the route tables so private subnets can
//                        reach the internet through the NAT GW
// ─────────────────────────────────────────────────────────────────────────────

import * as cdk from 'aws-cdk-lib';
import * as ec2  from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NatGatewayConstructProps {
  /** The public subnet in which to place the NAT Gateway */
  publicSubnetId: string;
  /**
   * Route table IDs of the PRIVATE subnets that should route outbound
   * internet traffic through this NAT Gateway.
   */
  privateRouteTableIds: string[];
  /** Used for resource naming / tagging */
  projectName: string;
  environment: string;
}

export class NatGatewayConstruct extends Construct {
  /** The NAT Gateway L1 resource */
  public readonly natGateway: ec2.CfnNatGateway;
  /** NAT Gateway ID */
  public readonly natGatewayId: string;
  /** The Elastic IP associated with the NAT Gateway */
  public readonly eip: ec2.CfnEIP;
  /** The public IP address of the NAT Gateway */
  public readonly eipAllocationId: string;

  constructor(scope: Construct, id: string, props: NatGatewayConstructProps) {
    super(scope, id);

    const namePrefix = `${props.projectName}-${props.environment}`;

    // ── Elastic IP ────────────────────────────────────────────────────────
    this.eip = new ec2.CfnEIP(this, 'NatEip', {
      domain: 'vpc',
      tags: [
        { key: 'Name',        value: `${namePrefix}-nat-eip` },
        { key: 'Project',     value: props.projectName },
        { key: 'Environment', value: props.environment },
      ],
    });
    this.eipAllocationId = this.eip.attrAllocationId;

    // ── NAT Gateway (in the public subnet) ───────────────────────────────
    // AWS requires a NAT Gateway to reside in a PUBLIC subnet with a route
    // to the Internet Gateway.  Private subnets then route 0.0.0.0/0 → NAT.
    this.natGateway = new ec2.CfnNatGateway(this, 'NatGateway', {
      allocationId: this.eip.attrAllocationId,
      subnetId: props.publicSubnetId,
      connectivityType: 'public',
      tags: [
        { key: 'Name',        value: `${namePrefix}-nat-gw` },
        { key: 'Project',     value: props.projectName },
        { key: 'Environment', value: props.environment },
      ],
    });
    this.natGatewayId = this.natGateway.ref;

    // ── Route 0.0.0.0/0 → NAT GW in every private route table ───────────
    props.privateRouteTableIds.forEach((rtId, index) => {
      const route = new ec2.CfnRoute(this, `PrivateNatRoute${index}`, {
        routeTableId: rtId,
        destinationCidrBlock: '0.0.0.0/0',
        natGatewayId: this.natGateway.ref,
      });
      // Ensure the NAT GW is fully created before adding routes
      route.addDependency(this.natGateway);
    });

    // ── CloudFormation outputs (informational) ────────────────────────────
    new cdk.CfnOutput(this, 'NatGatewayIdOutput', {
      value: this.natGateway.ref,
      description: 'NAT Gateway ID',
      exportName: `${namePrefix}-nat-gateway-id`,
    });
  }
}
