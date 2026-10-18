/** Shared node sizing.
 *
 *  `weight` is the number of *distinct* neighbours, which is what the native
 *  graph uses (`getRelated().length`); folder clusters have no native
 *  equivalent, so they fall back to a sublinear count of rolled-up files.
 */

import { NodeKind } from "./types";
import type { GraphModel } from "./types";

/** Native: nodeSizeMultiplier * max(8, min(3*sqrt(neighbours+1), 30)) */
export function nodeRadius(
  neighbors: number,
  multiplier: number,
  kind: number,
  clusterFiles: number,
): number {
  const base = Math.max(8, Math.min(3 * Math.sqrt(neighbors + 1), 30));
  if (kind === NodeKind.Cluster) {
    const grown = Math.max(base, 3 * Math.sqrt(clusterFiles + 1));
    return multiplier * Math.min(grown, 46);
  }
  return multiplier * base;
}

/** Radius array for the whole model, in world units. */
export function modelRadii(model: GraphModel, multiplier: number): Float32Array {
  const n = model.nodeCount;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cluster = model.clusterId[i];
    const files = cluster >= 0 ? model.clusters[cluster].fileCount : 0;
    out[i] = nodeRadius(model.sizeWeight[i], multiplier, model.kind[i], files);
  }
  return out;
}
