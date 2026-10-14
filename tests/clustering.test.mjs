import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addClusterColumn, kmeans, scanClusterCounts, silhouetteScore } from "../src/clustering.ts";
import { createRng } from "../src/models.ts";

const oracle = JSON.parse(readFileSync(new URL("./fixtures/oracle-models.json", import.meta.url), "utf8"));

function tableOf(matrix, names = matrix[0].map((_, index) => `c${index}`)) {
  return { sourceName: "k.csv", columns: names, rows: matrix.map((row) => row.map(String)) };
}

/** Do two labelings describe the same partition (ignoring label names)? */
function samePartition(left, right) {
  const forward = new Map();
  const backward = new Map();
  for (let index = 0; index < left.length; index += 1) {
    if ((forward.get(left[index]) ?? right[index]) !== right[index]) return false;
    if ((backward.get(right[index]) ?? left[index]) !== left[index]) return false;
    forward.set(left[index], right[index]);
    backward.set(right[index], left[index]);
  }
  return true;
}

test("ORACLE: well-separated blobs on mismatched scales match scikit-learn exactly", () => {
  const reference = oracle.kmeans_blobs;
  const result = kmeans(tableOf(reference.X), ["c0", "c1"], 3, 1);
  assert.ok(samePartition(result.assignments, reference.labels), "identical partition");
  assert.ok(Math.abs(result.inertia - reference.inertia) < 1e-8 * reference.inertia, `inertia ${result.inertia} vs ${reference.inertia}`);
  assert.ok(Math.abs(result.silhouette - reference.silhouette) < 1e-9, `silhouette ${result.silhouette} vs ${reference.silhouette}`);
  assert.deepEqual([...result.sizes].sort(), [...reference.sizes].sort());
});

test("ORACLE: on overlapping groups, inertia stays within 1% of scikit-learn's best of 50 starts", () => {
  const reference = oracle.kmeans_overlap;
  const table = tableOf(reference.X);
  for (const [k, expected] of Object.entries(reference.per_k)) {
    const result = kmeans(table, ["c0", "c1"], Number(k), 3);
    assert.ok(result.inertia <= expected.inertia * 1.01, `k=${k}: ${result.inertia} vs sklearn ${expected.inertia}`);
  }
});

test("ORACLE: the silhouette formula matches scikit-learn on the same labels", () => {
  const reference = oracle.kmeans_blobs;
  const matrix = reference.X;
  const means = [0, 1].map((column) => matrix.reduce((sum, row) => sum + row[column], 0) / matrix.length);
  const deviations = [0, 1].map((column) => Math.sqrt(matrix.reduce((sum, row) => sum + (row[column] - means[column]) ** 2, 0) / matrix.length));
  const standardized = matrix.map((row) => row.map((value, column) => (value - means[column]) / deviations[column]));
  const score = silhouetteScore(standardized, reference.labels, 3, 1);
  assert.ok(Math.abs(score - reference.silhouette) < 1e-9, `${score} vs ${reference.silhouette}`);
  assert.equal(silhouetteScore(standardized, new Array(matrix.length).fill(0), 1, 1), null);
  assert.equal(silhouetteScore(standardized, new Array(matrix.length).fill(0), 2, 1), null, "one occupied cluster is undefined");
});

test("scanning cluster counts recovers the true number of groups", () => {
  const { points, suggested } = scanClusterCounts(tableOf(oracle.kmeans_blobs.X), ["c0", "c1"], 5, 2, 6);
  assert.equal(suggested, 3);
  assert.deepEqual(points.map((point) => point.k), [2, 3, 4, 5, 6]);
  for (let index = 1; index < points.length; index += 1)
    assert.ok(points[index].inertia <= points[index - 1].inertia * 1.02, "inertia falls as k grows");
});

test("results are deterministic for a seed and labels run largest-first", () => {
  const table = tableOf(oracle.kmeans_overlap.X);
  const first = kmeans(table, ["c0", "c1"], 3, 9);
  assert.deepEqual(first, kmeans(table, ["c0", "c1"], 3, 9));
  for (let index = 1; index < first.sizes.length; index += 1) assert.ok(first.sizes[index - 1] >= first.sizes[index]);
  assert.equal(first.sizes.reduce((sum, value) => sum + value, 0), table.rows.length);
  assert.equal(first.assignments.length, table.rows.length);
  assert.equal(first.centroids.length, 3);
  assert.equal(first.centroids[0].length, 2);
});

test("centroids are reported in the original units, not standardized units", () => {
  const rows = [...Array.from({ length: 20 }, (_, index) => [1000 + index, 5]), ...Array.from({ length: 20 }, (_, index) => [5000 + index, 9])];
  const result = kmeans(tableOf(rows), ["c0", "c1"], 2, 1);
  const lows = result.centroids.map((centroid) => centroid[0]).sort((a, b) => a - b);
  assert.ok(Math.abs(lows[0] - 1009.5) < 1e-9);
  assert.ok(Math.abs(lows[1] - 5009.5) < 1e-9);
});

test("empty cells are filled with the column mean and counted; text and constants are refused", () => {
  const rows = Array.from({ length: 30 }, (_, index) => [index < 15 ? index : 100 + index, index === 3 ? "" : index % 4]);
  const result = kmeans(tableOf(rows), ["c0", "c1"], 2, 1);
  assert.equal(result.imputedCells, 1);
  assert.equal(result.assignments.length, 30);
  assert.throws(() => kmeans(tableOf([[1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]]), ["c0", "c1"], 2, 1), /non-numeric/);
  assert.throws(() => kmeans(tableOf(Array.from({ length: 10 }, (_, i) => [i, 5])), ["c0", "c1"], 2, 1), /never varies/);
  assert.throws(() => kmeans(tableOf(Array.from({ length: 10 }, (_, i) => [i, "", ])), ["c0", "c1"], 2, 1), /no values/);
  assert.throws(() => kmeans(tableOf([[1, 2], [3, 4], [5, 6]]), ["c0", "c1"], 2, 1), /at least 4 rows/);
  assert.throws(() => kmeans(tableOf(rows), ["c0"], 1, 1), /between 2 and 12/);
  assert.throws(() => kmeans(tableOf(rows), ["missing"], 2, 1), /does not exist/);
  assert.throws(() => kmeans(tableOf(rows), [], 2, 1), /at least one/);
});

test("heavily duplicated points never leave empty or NaN clusters", () => {
  const rows = [...Array(30).fill([1, 1]), ...Array(30).fill([9, 9]), [5, 5], [5.1, 5.1], [4.9, 5]];
  const result = kmeans(tableOf(rows), ["c0", "c1"], 4, 2);
  assert.ok(result.centroids.flat().every(Number.isFinite));
  assert.ok(Number.isFinite(result.inertia));
  assert.ok(result.sizes.every((size) => size >= 0));
});

test("large tables fit on a seeded sample but still label every row", () => {
  const random = createRng(77);
  const rows = Array.from({ length: 30_000 }, (_, index) => [(index % 2) * 10 + random(), (index % 2) * 10 + random()]);
  const started = performance.now();
  const result = kmeans(tableOf(rows), ["c0", "c1"], 2, 1);
  const seconds = (performance.now() - started) / 1000;
  assert.equal(result.assignments.length, 30_000);
  assert.equal(result.fitRows, 20_000);
  assert.ok(result.sizes.every((size) => Math.abs(size - 15_000) < 50), "the two groups are separated");
  assert.ok(seconds < 15, `took ${seconds.toFixed(1)}s`);
});

test("the cluster column is appended safely and validated", () => {
  const table = tableOf([[1, 2], [3, 4], [5, 6]], ["a", "cluster"]);
  const added = addClusterColumn(table, [0, 1, 0]);
  assert.deepEqual(added.columns, ["a", "cluster", "cluster (2)"]);
  assert.deepEqual(added.rows.map((row) => row[2]), ["Cluster 1", "Cluster 2", "Cluster 1"]);
  assert.throws(() => addClusterColumn(table, [0, 1]), /Run clustering again/);
});
