/** Mobile-only performance policy.
 *
 * Quality reductions are deliberately ephemeral: they tune the current view but
 * never mutate the plugin's persisted graph or clustering preferences.
 * Topology is the last thing to shrink because changing it is visually disruptive.
 */

export type MobileQualityTier = "high" | "balanced" | "low" | "emergency";

export interface MobileCapabilities {
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  screenPixels: number;
  devicePixelRatio: number;
}

export interface MobileQualityProfile {
  tier: MobileQualityTier;
  dprCap: number;
  maxLabels: number;
  arrows: boolean;
  simulationHz: number;
  publishHz: number;
  nodeBudget: number;
  metadataBudget: number;
}

const PROFILES: readonly MobileQualityProfile[] = [
  {
    tier: "high",
    dprCap: 1.5,
    maxLabels: 160,
    arrows: true,
    simulationHz: 60,
    publishHz: 30,
    nodeBudget: 650,
    metadataBudget: 125,
  },
  {
    tier: "balanced",
    dprCap: 1.25,
    maxLabels: 110,
    arrows: false,
    simulationHz: 40,
    publishHz: 30,
    nodeBudget: 550,
    metadataBudget: 100,
  },
  {
    tier: "low",
    dprCap: 1,
    maxLabels: 64,
    arrows: false,
    simulationHz: 30,
    publishHz: 20,
    nodeBudget: 400,
    metadataBudget: 72,
  },
  {
    tier: "emergency",
    dprCap: 0.8,
    maxLabels: 28,
    arrows: false,
    simulationHz: 20,
    publishHz: 15,
    nodeBudget: 280,
    metadataBudget: 40,
  },
] as const;

const DOWNGRADE_SAMPLES = 18;
const UPGRADE_SAMPLES = 240;
const DOWNGRADE_COOLDOWN_MS = 1_000;
const UPGRADE_COOLDOWN_MS = 12_000;

/** Browser capability read kept here so it can be replaced with fixtures in tests. */
export function readMobileCapabilities(): MobileCapabilities {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, window.screen?.width || window.innerWidth || 1);
  const height = Math.max(1, window.screen?.height || window.innerHeight || 1);
  return {
    hardwareConcurrency: Math.max(1, nav.hardwareConcurrency || 2),
    deviceMemoryGb:
      typeof nav.deviceMemory === "number" && Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null,
    screenPixels: width * height,
    devicePixelRatio: dpr,
  };
}

/** Conservative initial tier; runtime measurements can still move either way. */
export function initialMobileTier(capabilities: MobileCapabilities): MobileQualityTier {
  const memory = capabilities.deviceMemoryGb;
  if (memory !== null && memory <= 2) return "emergency";
  if (
    capabilities.hardwareConcurrency <= 4 ||
    (memory !== null && memory <= 4) ||
    capabilities.screenPixels * capabilities.devicePixelRatio ** 2 >= 5_000_000
  ) {
    return "low";
  }
  return "balanced";
}

export function mobileProfile(tier: MobileQualityTier): MobileQualityProfile {
  return PROFILES[tierIndex(tier)];
}

/**
 * Rolling frame-cost controller with asymmetric hysteresis: slow views shed work
 * quickly, while quality returns only after a long stable period.
 */
export class MobileQualityController {
  private index: number;
  private averageMs = 0;
  private badSamples = 0;
  private goodSamples = 0;
  private lastChangeMs: number;

  constructor(initial: MobileQualityTier, startedAtMs = 0) {
    this.index = tierIndex(initial);
    this.lastChangeMs = startedAtMs;
  }

  get tier(): MobileQualityTier {
    return PROFILES[this.index].tier;
  }

  get current(): MobileQualityProfile {
    return PROFILES[this.index];
  }

  /** During direct manipulation, temporarily drop one visual/cadence tier. */
  effective(interacting: boolean): MobileQualityProfile {
    return PROFILES[Math.min(PROFILES.length - 1, this.index + (interacting ? 1 : 0))];
  }

  /** Returns true when the persistent session tier changed. */
  sample(frameMs: number, nowMs: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return false;
    this.averageMs = this.averageMs === 0 ? frameMs : this.averageMs * 0.9 + frameMs * 0.1;

    const slow = this.averageMs > 20;
    const fast = this.averageMs < 12;
    this.badSamples = slow ? this.badSamples + 1 : Math.max(0, this.badSamples - 2);
    this.goodSamples = fast ? this.goodSamples + 1 : 0;

    if (
      this.badSamples >= DOWNGRADE_SAMPLES &&
      this.index < PROFILES.length - 1 &&
      nowMs - this.lastChangeMs >= DOWNGRADE_COOLDOWN_MS
    ) {
      this.index++;
      this.badSamples = 0;
      this.goodSamples = 0;
      this.lastChangeMs = nowMs;
      return true;
    }
    if (
      this.goodSamples >= UPGRADE_SAMPLES &&
      this.index > 0 &&
      nowMs - this.lastChangeMs >= UPGRADE_COOLDOWN_MS
    ) {
      this.index--;
      this.badSamples = 0;
      this.goodSamples = 0;
      this.lastChangeMs = nowMs;
      return true;
    }
    return false;
  }
}

function tierIndex(tier: MobileQualityTier): number {
  const index = PROFILES.findIndex((profile) => profile.tier === tier);
  return index < 0 ? 1 : index;
}
