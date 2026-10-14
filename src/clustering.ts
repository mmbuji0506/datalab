import { createRng, shuffleInPlace } from "./models.ts";
import { parseNumber, type DataTable } from "./workbench.ts";

export const MAX_CLUSTER_COLUMNS = 20;
export const MAX_CLUSTER_FIT_ROWS = 20_000;
const SILHOUETTE_SAMPLE = 1_500;
const MAX_ITERATIONS = 100;

export type ClusterResult = {
  k: number;
  columns: string[];
  /** Cluster number (0-based, largest cluster first) for every table row. */
  assignments: number[];
  /** Mean of each column per cluster, in the original units. */
  centroids: number[][];
  sizes: number[];
  /** Within-cluster sum of squares on the standardized data used for fitting. */
  inertia: number;
  /** Mean silhouette (-1 to 1; higher is better separated). Null when undefined. */
  silhouette: number | null;
  iterations: number;
  /** Empty cells replaced by the column mean so every row can be assigned. */
  imputedCells: number;
  fitRows: number;
};

export type ClusterScanPoint = { k: number; inertia: number; silhouette: number | null };

/**
 * More random starts find better optima (20 starts keep the worst case within
 * ~1% of scikit-learn's best-of-50 on overlapping data) but cost more on big
 * tables, so the count scales down with the number of rows being fitted.
 */
function defaultRestarts(rows: number): number {
  if (rows <= 2_000) return 20;
  if (rows <= 10_000) return 10;
  return 5;
}

type Prepared = {
  raw: number[][];
  standardized: number[][];
  imputedCells: number;
};

function prepare(table: DataTable, columns: string[]): Prepared {
  if (columns.length < 1) throw new Error("Select at least one numeric column to cluster.");
  if (columns.length > MAX_CLUSTER_COLUMNS) throw new Error(`Cluster on no more than ${MAX_CLUSTER_COLUMNS} columns at a time.`);
  const indexes = columns.map((name) => {
    const index = table.columns.indexOf(name);
    if (index < 0) throw new Error(`"${name}" does not exist in the current dataset.`);
    return index;
  });
  const parsed = table.rows.map((row) =>
    indexes.map((index, position) => {
      const text = (row[index] ?? "").trim();
      if (text === "") return null;
      const value = parseNumber(text);
      if (value === null) throw new Error(`"${columns[position]}" contains non-numeric values; clean or convert it first.`);
      return value;
    }),
  );
  const means = columns.map((name, position) => {
    let sum = 0;
    let count = 0;
    for (const row of parsed) {
      const value = row[position];
      if (value !== null) {
        sum += value;
        count += 1;
      }
    }
    if (count === 0) throw new Error(`"${name}" has no values to cluster on.`);
    return sum / count;
  });
  let imputedCells = 0;
  const raw = parsed.map((row) =>
    row.map((value, position) => {
      if (value === null) {
        imputedCells += 1;
        return means[position];
      }
      return value;
    }),
  );
  const deviations = columns.map((name, position) => {
    let squares = 0;
    for (const row of raw) squares += (row[position] - means[position]) ** 2;
    const deviation = Math.sqrt(squares / raw.length);
    if (deviation < 1e-12) throw new Error(`"${name}" never varies, so it cannot separate clusters. Deselect it.`);
    return deviation;
  });
  const standardized = raw.map((row) => row.map((value, position) => (value - means[position]) / deviations[position]));
  return { raw, standardized, imputedCells };
}

function squaredDistance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return sum;
}

function nearest(point: number[], centroids: number[][]): { index: number; distance: number } {
  let index = 0;
  let distance = Infinity;
  for (let cluster = 0; cluster < centroids.length; cluster += 1) {
    const candidate = squaredDistance(point, centroids[cluster]);
    if (candidate < distance) {
      distance = candidate;
      index = cluster;
    }
  }
  return { index, distance };
}

function seedPlusPlus(points: number[][], k: number, random: () => number): number[][] {
  const centroids = [points[Math.floor(random() * points.length)].slice()];
  const closest = points.map((point) => squaredDistance(point, centroids[0]));
  while (centroids.length < k) {
    const total = closest.reduce((sum, value) => sum + value, 0);
    let choice = points.length - 1;
    if (total > 0) {
      let threshold = random() * total;
      for (let index = 0; index < points.length; index += 1) {
        threshold -= closest[index];
        if (threshold <= 0) {
          choice = index;
          break;
        }
      }
    } else {
      choice = Math.floor(random() * points.length);
    }
    centroids.push(points[choice].slice());
    for (let index = 0; index < points.length; index += 1)
      closest[index] = Math.min(closest[index], squaredDistance(points[index], centroids[centroids.length - 1]));
  }
  return centroids;
}

function lloyd(points: number[][], k: number, random: () => number) {
  const dimensions = points[0].length;
  let centroids = seedPlusPlus(points, k, random);
  let assignments = new Array<number>(points.length).fill(-1);
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations += 1) {
    let changed = false;
    const distances = new Array<number>(points.length);
    for (let index = 0; index < points.length; index += 1) {
      const { index: cluster, distance } = nearest(points[index], centroids);
      distances[index] = distance;
      if (cluster !== assignments[index]) {
        assignments[index] = cluster;
        changed = true;
      }
    }
    const sums = Array.from({ length: k }, () => new Array<number>(dimensions).fill(0));
    const counts = new Array<number>(k).fill(0);
    points.forEach((point, index) => {
      counts[assignments[index]] += 1;
      for (let dimension = 0; dimension < dimensions; dimension += 1) sums[assignments[index]][dimension] += point[dimension];
    });
    centroids = sums.map((sum, cluster) => {
      if (counts[cluster] > 0) return sum.map((value) => value / counts[cluster]);
      // Re-seed an empty cluster on the point farthest from its centroid.
      let farthest = 0;
      for (let index = 1; index < points.length; index += 1) if (distances[index] > distances[farthest]) farthest = index;
      distances[farthest] = 0;
      changed = true;
      return points[farthest].slice();
    });
    if (!changed) break;
  }
  let inertia = 0;
  assignments = points.map((point) => {
    const { index: cluster, distance } = nearest(point, centroids);
    inertia += distance;
    return cluster;
  });
  return { centroids, assignments, inertia, iterations: iterations + 1 };
}

/** Mean silhouette over a seeded sample, using Euclidean distance. */
export function silhouetteScore(points: number[][], assignments: number[], k: number, seed: number): number | null {
  if (k < 2) return null;
  let order = Array.from({ length: points.length }, (_, index) => index);
  if (order.length > SILHOUETTE_SAMPLE) order = shuffleInPlace(order, createRng(seed ^ 0x7f4a7c15)).slice(0, SILHOUETTE_SAMPLE);
  const sample = order.map((index) => points[index]);
  const labels = order.map((index) => assignments[index]);
  const sizes = new Array<number>(k).fill(0);
  for (const label of labels) sizes[label] += 1;
  if (sizes.filter((size) => size > 0).length < 2) return null;
  let total = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const sums = new Array<number>(k).fill(0);
    for (let other = 0; other < sample.length; other += 1) {
      if (other === index) continue;
      sums[labels[other]] += Math.sqrt(squaredDistance(sample[index], sample[other]));
    }
    const own = labels[index];
    if (sizes[own] <= 1) continue; // a singleton scores 0
    const within = sums[own] / (sizes[own] - 1);
    let between = Infinity;
    for (let cluster = 0; cluster < k; cluster += 1)
      if (cluster !== own && sizes[cluster] > 0) between = Math.min(between, sums[cluster] / sizes[cluster]);
    total += (between - within) / Math.max(within, between);
  }
  return total / sample.length;
}

export function kmeans(
  table: DataTable,
  columns: string[],
  k: number,
  seed: number,
  options: { maxFitRows?: number; restarts?: number } = {},
): ClusterResult {
  if (!Number.isInteger(k) || k < 2 || k > 12) throw new Error("Choose between 2 and 12 clusters.");
  if (!Number.isInteger(seed)) throw new Error("The random seed must be a whole number.");
  const prepared = prepare(table, columns);
  if (prepared.standardized.length < 2 * k) throw new Error(`Clustering into ${k} groups needs at least ${2 * k} rows.`);
  const random = createRng(seed);
  const limit = options.maxFitRows ?? MAX_CLUSTER_FIT_ROWS;
  let fitIndexes = Array.from({ length: prepared.standardized.length }, (_, index) => index);
  if (fitIndexes.length > limit) fitIndexes = shuffleInPlace(fitIndexes, createRng(seed ^ 0x3c6ef372)).slice(0, limit).sort((a, b) => a - b);
  const fitPoints = fitIndexes.map((index) => prepared.standardized[index]);

  let best: ReturnType<typeof lloyd> | null = null;
  for (let attempt = 0; attempt < (options.restarts ?? defaultRestarts(fitPoints.length)); attempt += 1) {
    const candidate = lloyd(fitPoints, k, random);
    if (best === null || candidate.inertia < best.inertia - 1e-12) best = candidate;
  }
  const fitted = best as ReturnType<typeof lloyd>;
  const silhouette = silhouetteScore(fitPoints, fitted.assignments, k, seed);

  // Assign every row (including those not used for fitting), then number the
  // clusters from largest to smallest so labels are stable and readable.
  const rawAssignments = prepared.standardized.map((point) => nearest(point, fitted.centroids).index);
  const rawSizes = new Array<number>(k).fill(0);
  for (const cluster of rawAssignments) rawSizes[cluster] += 1;
  const rank = [...rawSizes.keys()].sort((left, right) => rawSizes[right] - rawSizes[left] || left - right);
  const renumber = new Map(rank.map((cluster, position) => [cluster, position]));
  const assignments = rawAssignments.map((cluster) => renumber.get(cluster) as number);
  const sizes = rank.map((cluster) => rawSizes[cluster]);
  const dimensions = columns.length;
  const sums = Array.from({ length: k }, () => new Array<number>(dimensions).fill(0));
  prepared.raw.forEach((row, index) => {
    for (let dimension = 0; dimension < dimensions; dimension += 1) sums[assignments[index]][dimension] += row[dimension];
  });
  return {
    k,
    columns,
    assignments,
    centroids: sums.map((sum, cluster) => sum.map((value) => (sizes[cluster] ? value / sizes[cluster] : 0))),
    sizes,
    inertia: fitted.inertia,
    silhouette,
    iterations: fitted.iterations,
    imputedCells: prepared.imputedCells,
    fitRows: fitPoints.length,
  };
}

/** Fits k = kMin..kMax and reports inertia and silhouette for each. */
export function scanClusterCounts(
  table: DataTable,
  columns: string[],
  seed: number,
  kMin = 2,
  kMax = 8,
): { points: ClusterScanPoint[]; suggested: number | null } {
  const rows = table.rows.length;
  const upper = Math.min(kMax, Math.floor(rows / 2));
  const points: ClusterScanPoint[] = [];
  for (let k = kMin; k <= upper; k += 1) {
    const result = kmeans(table, columns, k, seed, { maxFitRows: 5_000, restarts: 5 });
    points.push({ k, inertia: result.inertia, silhouette: result.silhouette });
  }
  let suggested: number | null = null;
  let top = -Infinity;
  for (const point of points)
    if (point.silhouette !== null && point.silhouette > top + 1e-12) {
      top = point.silhouette;
      suggested = point.k;
    }
  return { points, suggested };
}

/** Adds a text column ("Cluster 1", ...) so groups can be filtered, charted, or exported. */
export function addClusterColumn(table: DataTable, assignments: number[], name = "cluster"): DataTable {
  if (assignments.length !== table.rows.length) throw new Error("The clusters no longer match the current rows. Run clustering again.");
  let columnName = name;
  let suffix = 2;
  while (table.columns.some((existing) => existing.toLocaleLowerCase() === columnName.toLocaleLowerCase())) {
    columnName = `${name} (${suffix})`;
    suffix += 1;
  }
  return {
    ...table,
    columns: [...table.columns, columnName],
    rows: table.rows.map((row, index) => [...row, `Cluster ${assignments[index] + 1}`]),
  };
}
