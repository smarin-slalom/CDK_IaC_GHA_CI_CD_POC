// ─────────────────────────────────────────────────────────────────────────────
// config/config.ts  –  Shared configuration types & helpers
// ─────────────────────────────────────────────────────────────────────────────

// ── VPC ──────────────────────────────────────────────────────────────────────

export interface VpcConfig {
  /** Friendly name tag applied to the VPC */
  vpcName: string;
  /** VPC CIDR block, e.g. "10.0.0.0/16" */
  cidr: string;
  /**
   * Maximum number of Availability Zones to use.
   * CDK creates one subnet (per subnet-config) per AZ.
   * For HA use ≥ 2. For a single-AZ POC use 1.
   */
  maxAzs: number;
  /** How many distinct public-subnet CIDRs to carve (one per AZ, per entry) */
  numPublicSubnets: number;
  /** How many distinct private-subnet configs to carve */
  numPrivateSubnets: number;
  /** CIDR mask for each public subnet, e.g. 24 → /24 */
  publicSubnetCidrMask: number;
  /** CIDR mask for each private subnet, e.g. 24 → /24 */
  privateSubnetCidrMask: number;
}

// ── Scaling ───────────────────────────────────────────────────────────────────

export interface ScalingConfig {
  /** Minimum tasks per service (always ≥ 2 per spec) */
  minCapacity: number;
  /** Maximum tasks per service – override per-app */
  maxCapacity: number;
  /** CPU % below which tasks are removed */
  scaleInCpuPercent: number;
  /** CPU % above which tasks are added */
  scaleOutCpuPercent: number;
  /** Cooldown (seconds) before scaling-in again */
  scaleInCooldownSec: number;
  /** Cooldown (seconds) before scaling-out again */
  scaleOutCooldownSec: number;
}

// ── Per-stack props passed through SSM or environment ────────────────────────

export interface EnvironmentStackConfig {
  projectName: string;
  environment: string;
  vpc: VpcConfig;
}

export interface ClientInfraStackConfig {
  projectName: string;
  environment: string;
  /** SSM parameter path prefix written by EnvironmentStack */
  environmentSsmPrefix: string;
}

export interface EcsStackConfig {
  projectName: string;
  environment: string;
  /** SSM parameter path prefix written by EnvironmentStack */
  environmentSsmPrefix: string;
  /** SSM parameter path prefix written by ClientInfraStack */
  clientInfraSsmPrefix: string;
}

// ── SSM naming convention ─────────────────────────────────────────────────────

export function ssmPath(
  projectName: string,
  environment: string,
  stackType: 'environment' | 'client-infra' | 'ecs',
  paramName: string
): string {
  return `/${projectName}/${environment}/${stackType}/${paramName}`;
}

// ── Default scaling values (per spec) ────────────────────────────────────────

export const DEFAULT_SCALING: ScalingConfig = {
  minCapacity: 2,
  maxCapacity: 6,
  scaleInCpuPercent: 20,
  scaleOutCpuPercent: 80,
  scaleInCooldownSec: 300,
  scaleOutCooldownSec: 60,
};
