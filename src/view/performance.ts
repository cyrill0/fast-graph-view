/** Work budgets for desktop graphs that exceed the normal clustered size. */

export interface GraphPerformanceProfile {
  simulationHz: number;
  publishHz: number;
  maxLabels: number;
  arrows: boolean;
  hoverIntervalMs: number;
}

const DEFAULT_MAX_LABELS = 700;

/**
 * Bound desktop work for very large, manually expanded graphs. Physics quality
 * remains full-rate for normal vaults; only graphs large enough to exceed a
 * frame's CPU budget reduce worker publication, labels, arrows, and stationary
 * pointer hit tests. Direct pointer movement is always tested immediately.
 */
export function graphPerformanceProfile(
  nodeCount: number,
  edgeCount: number,
  interacting = false,
): GraphPerformanceProfile {
  const load = Math.max(0, nodeCount) + Math.max(0, edgeCount) * 0.35;
  if (load >= 15_000) {
    return {
      simulationHz: 20,
      publishHz: 15,
      maxLabels: interacting ? 100 : 180,
      arrows: false,
      hoverIntervalMs: 66,
    };
  }
  if (load >= 7_500) {
    return {
      simulationHz: 30,
      publishHz: 20,
      maxLabels: interacting ? 180 : 300,
      arrows: false,
      hoverIntervalMs: 50,
    };
  }
  if (load >= 3_000) {
    return {
      simulationHz: 45,
      publishHz: 30,
      maxLabels: interacting ? 300 : 450,
      arrows: edgeCount <= 6_000,
      hoverIntervalMs: 33,
    };
  }
  return {
    simulationHz: 60,
    publishHz: 60,
    maxLabels: DEFAULT_MAX_LABELS,
    arrows: true,
    hoverIntervalMs: 0,
  };
}
