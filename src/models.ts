import { analyzeColumn, compareText, quantileSorted, type SemanticType } from "./analytics.ts";
import { parseNumber, type DataTable } from "./workbench.ts";

/* -------------------------------------------------------------------------- */
/* Public types and limits                                                    */
/* -------------------------------------------------------------------------- */

export type Task = "regression" | "classification";
export type ModelKind = "linear" | "tree";
export type SplitMode = "random" | "chronological";

export const MAX_MODEL_ROWS = 20_000;
export const MAX_DESIGN_COLUMNS = 80;
export const MAX_CLASSES = 20;
export const MIN_MODEL_ROWS = 8;
const MAX_CATEGORIES_PER_FEATURE = 8;
const MAX_CATEGORY_FEATURE_UNIQUE = 50;

export type ModelConfig = {
  target: string;
  task: Task;
  model: ModelKind;
  features: string[];
  /** Share of rows held out for testing, 0.1 - 0.5. */
  testFraction: number;
  seed: number;
  split: SplitMode;
  /** 0 disables cross-validation; otherwise 2 - 10 folds. */
  folds: number;
  maxDepth?: number;
  /** Ridge strength alpha (regression). Default 1, as in scikit-learn. */
  ridge?: number;
  /** Inverse L2 strength C (classification). Default 1, as in scikit-learn. */
  regularization?: number;
};

export type MetricRow = {
  label: string;
  model: number | null;
  baseline: number | null;
  higherIsBetter: boolean;
  percent: boolean;
};

export type ModelReport = {
  task: Task;
  model: ModelKind;
  split: SplitMode;
  seed: number;
  rows: {
    used: number;
    train: number;
    test: number;
    droppedMissingTarget: number;
    sampledFrom: number | null;
  };
  features: string[];
  encodedFeatures: number;
  metrics: MetricRow[];
  primary: {
    label: string;
    model: number;
    baseline: number;
    beatsBaseline: boolean;
    /**
     * Permutation test on the held-out rows: how often shuffled answers score
     * at least this well by pure luck (smaller is stronger evidence).
     */
    pValue: number;
    /** Beats the baseline AND is unlikely to be luck (p < 0.05). */
    significant: boolean;
  };
  crossValidation: null | {
    folds: number;
    label: string;
    model: { mean: number; std: number | null; scores: number[] };
    baseline: { mean: number; std: number | null };
  };
  confusion: null | { classes: string[]; matrix: number[][] };
  classReport: null | Array<{ label: string; precision: number; recall: number; f1: number; support: number }>;
  importance: Array<{ feature: string; importance: number; std: number; share: number }>;
  coefficients: null | Array<{ name: string; value: number }>;
  predictions: Array<{ row: number; actual: string; predicted: string }>;
  warnings: string[];
};

/* -------------------------------------------------------------------------- */
/* Randomness                                                                 */
/* -------------------------------------------------------------------------- */

/** Mulberry32: tiny, fast, and identical on every JavaScript engine. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/* Linear algebra and optimizers                                              */
/* -------------------------------------------------------------------------- */

function choleskySolve(matrix: number[][], rhs: number[]): number[] | null {
  const size = rhs.length;
  const lower = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let sum = matrix[row][column];
      for (let inner = 0; inner < column; inner += 1) sum -= lower[row][inner] * lower[column][inner];
      if (row === column) {
        if (!(sum > 1e-12)) return null;
        lower[row][row] = Math.sqrt(sum);
      } else {
        lower[row][column] = sum / lower[column][column];
      }
    }
  }
  const forward = new Array<number>(size).fill(0);
  for (let row = 0; row < size; row += 1) {
    let sum = rhs[row];
    for (let column = 0; column < row; column += 1) sum -= lower[row][column] * forward[column];
    forward[row] = sum / lower[row][row];
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = forward[row];
    for (let column = row + 1; column < size; column += 1) sum -= lower[column][row] * solution[column];
    solution[row] = sum / lower[row][row];
  }
  return solution;
}

export type RidgeModel = { intercept: number; weights: number[] };

/**
 * Ridge regression: minimizes ||y - b - Xw||^2 + alpha ||w||^2 with an
 * unpenalized intercept, matching scikit-learn's `Ridge(alpha)`.
 */
export function fitRidge(features: number[][], target: number[], alpha: number): RidgeModel {
  const rows = features.length;
  const columns = rows ? features[0].length : 0;
  const columnMeans = new Array<number>(columns).fill(0);
  for (const row of features) for (let column = 0; column < columns; column += 1) columnMeans[column] += row[column];
  for (let column = 0; column < columns; column += 1) columnMeans[column] /= rows;
  let targetMean = 0;
  for (const value of target) targetMean += value;
  targetMean /= rows;

  const gram = Array.from({ length: columns }, () => new Array<number>(columns).fill(0));
  const moment = new Array<number>(columns).fill(0);
  const centered = new Array<number>(columns).fill(0);
  for (let index = 0; index < rows; index += 1) {
    for (let column = 0; column < columns; column += 1) centered[column] = features[index][column] - columnMeans[column];
    const residual = target[index] - targetMean;
    for (let left = 0; left < columns; left += 1) {
      moment[left] += centered[left] * residual;
      for (let right = 0; right <= left; right += 1) gram[left][right] += centered[left] * centered[right];
    }
  }
  for (let left = 0; left < columns; left += 1) for (let right = left + 1; right < columns; right += 1) gram[left][right] = gram[right][left];

  let penalty = Math.max(alpha, 0);
  let weights: number[] | null = null;
  for (let attempt = 0; attempt < 8 && weights === null; attempt += 1) {
    const system = gram.map((line, row) => line.map((value, column) => (row === column ? value + penalty : value)));
    weights = choleskySolve(system, moment);
    if (weights === null) penalty = penalty === 0 ? 1e-8 : penalty * 100;
  }
  if (weights === null) throw new Error("The features are too collinear to fit a linear model.");
  let intercept = targetMean;
  for (let column = 0; column < columns; column += 1) intercept -= weights[column] * columnMeans[column];
  return { intercept, weights };
}

export function predictRidge(model: RidgeModel, row: number[]): number {
  let value = model.intercept;
  for (let column = 0; column < row.length; column += 1) value += model.weights[column] * row[column];
  return value;
}

export type SoftmaxModel = { classes: number; columns: number; weights: number[][]; intercepts: number[] };

/**
 * Multinomial logistic regression with an L2 penalty and unpenalized
 * intercepts, fitted with L-BFGS. The objective is
 *   mean cross-entropy + (lambda / 2) ||W||^2,  lambda = 1 / (C n),
 * which is scikit-learn's `LogisticRegression(C)`. Binary problems use 2 lambda
 * on the two-vector softmax, which equals scikit-learn's single-logit form.
 */
export function fitSoftmax(
  features: number[][],
  labels: number[],
  classes: number,
  regularization = 1,
  maxIterations = 300,
): SoftmaxModel {
  const rows = features.length;
  const columns = rows ? features[0].length : 0;
  const lambda = (classes === 2 ? 2 : 1) / (Math.max(regularization, 1e-12) * rows);
  const size = classes * (columns + 1);
  const logits = new Array<number>(classes).fill(0);

  const evaluate = (theta: number[], gradient: number[]): number => {
    gradient.fill(0);
    let loss = 0;
    for (let index = 0; index < rows; index += 1) {
      const row = features[index];
      let largest = -Infinity;
      for (let cls = 0; cls < classes; cls += 1) {
        let value = theta[classes * columns + cls];
        const base = cls * columns;
        for (let column = 0; column < columns; column += 1) value += theta[base + column] * row[column];
        logits[cls] = value;
        if (value > largest) largest = value;
      }
      let total = 0;
      for (let cls = 0; cls < classes; cls += 1) {
        logits[cls] = Math.exp(logits[cls] - largest);
        total += logits[cls];
      }
      loss -= Math.log(logits[labels[index]] / total + 1e-300);
      for (let cls = 0; cls < classes; cls += 1) {
        const error = logits[cls] / total - (cls === labels[index] ? 1 : 0);
        const base = cls * columns;
        for (let column = 0; column < columns; column += 1) gradient[base + column] += error * row[column];
        gradient[classes * columns + cls] += error;
      }
    }
    let penalty = 0;
    for (let position = 0; position < classes * columns; position += 1) {
      penalty += theta[position] ** 2;
      gradient[position] = gradient[position] / rows + lambda * theta[position];
    }
    for (let position = classes * columns; position < size; position += 1) gradient[position] /= rows;
    return loss / rows + (lambda / 2) * penalty;
  };

  const theta = lbfgs(evaluate, size, maxIterations);
  const weights = Array.from({ length: classes }, (_, cls) => theta.slice(cls * columns, (cls + 1) * columns));
  return { classes, columns, weights, intercepts: theta.slice(classes * columns) };
}

export function softmaxProbabilities(model: SoftmaxModel, row: number[]): number[] {
  const scores = model.weights.map((weights, cls) => {
    let value = model.intercepts[cls];
    for (let column = 0; column < row.length; column += 1) value += weights[column] * row[column];
    return value;
  });
  const largest = Math.max(...scores);
  const exps = scores.map((score) => Math.exp(score - largest));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

export function predictSoftmax(model: SoftmaxModel, row: number[]): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let cls = 0; cls < model.classes; cls += 1) {
    let value = model.intercepts[cls];
    for (let column = 0; column < row.length; column += 1) value += model.weights[cls][column] * row[column];
    if (value > bestScore) {
      bestScore = value;
      best = cls;
    }
  }
  return best;
}

function dot(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

/** Limited-memory BFGS with an Armijo backtracking line search. */
function lbfgs(
  evaluate: (theta: number[], gradient: number[]) => number,
  size: number,
  maxIterations: number,
): number[] {
  const memory = 10;
  let theta = new Array<number>(size).fill(0);
  let gradient = new Array<number>(size).fill(0);
  let value = evaluate(theta, gradient);
  const steps: number[][] = [];
  const changes: number[][] = [];
  const nextGradient = new Array<number>(size).fill(0);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let gradientNorm = 0;
    for (const entry of gradient) gradientNorm = Math.max(gradientNorm, Math.abs(entry));
    if (gradientNorm < 1e-9) break;

    const direction = gradient.slice();
    const alphas = new Array<number>(steps.length).fill(0);
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      alphas[index] = dot(steps[index], direction) / dot(changes[index], steps[index]);
      for (let position = 0; position < size; position += 1) direction[position] -= alphas[index] * changes[index][position];
    }
    if (steps.length) {
      const last = steps.length - 1;
      const scale = dot(steps[last], changes[last]) / dot(changes[last], changes[last]);
      for (let position = 0; position < size; position += 1) direction[position] *= scale;
    } else {
      const scale = 1 / Math.max(Math.sqrt(dot(gradient, gradient)), 1e-12);
      for (let position = 0; position < size; position += 1) direction[position] *= Math.min(1, scale);
    }
    for (let index = 0; index < steps.length; index += 1) {
      const beta = dot(changes[index], direction) / dot(changes[index], steps[index]);
      for (let position = 0; position < size; position += 1) direction[position] += steps[index][position] * (alphas[index] - beta);
    }
    for (let position = 0; position < size; position += 1) direction[position] = -direction[position];

    let slope = dot(gradient, direction);
    if (!(slope < 0)) {
      for (let position = 0; position < size; position += 1) direction[position] = -gradient[position];
      slope = dot(gradient, direction);
      steps.length = 0;
      changes.length = 0;
    }

    let stepSize = 1;
    let candidate = theta;
    let candidateValue = value;
    let accepted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      candidate = theta.map((entry, position) => entry + stepSize * direction[position]);
      candidateValue = evaluate(candidate, nextGradient);
      if (Number.isFinite(candidateValue) && candidateValue <= value + 1e-4 * stepSize * slope) {
        accepted = true;
        break;
      }
      stepSize *= 0.5;
    }
    if (!accepted) break;

    const step = candidate.map((entry, position) => entry - theta[position]);
    const change = nextGradient.map((entry, position) => entry - gradient[position]);
    const curvature = dot(step, change);
    if (curvature > 1e-12) {
      steps.push(step);
      changes.push(change);
      if (steps.length > memory) {
        steps.shift();
        changes.shift();
      }
    }
    const improvement = value - candidateValue;
    theta = candidate;
    gradient = nextGradient.slice();
    value = candidateValue;
    if (improvement >= 0 && improvement < 1e-14 * Math.max(1, Math.abs(value))) break;
  }
  return theta;
}

/* -------------------------------------------------------------------------- */
/* Decision tree (CART)                                                       */
/* -------------------------------------------------------------------------- */

export type TreeNode = {
  /** -1 marks a leaf. */
  feature: number;
  threshold: number;
  left: number;
  right: number;
  /** Mean (regression) or majority class index (classification). */
  value: number;
  samples: number;
};
export type TreeModel = { nodes: TreeNode[] };

export type TreeOptions = { maxDepth: number; minLeaf: number };

/**
 * CART tree: variance reduction for regression, Gini impurity for
 * classification. Thresholds sit midway between distinct sorted values; ties
 * resolve to the lowest feature index and threshold, so results are repeatable.
 */
export function fitTree(
  features: number[][],
  target: number[],
  task: Task,
  classes: number,
  options: TreeOptions,
): TreeModel {
  const columns = features.length ? features[0].length : 0;
  const nodes: TreeNode[] = [];

  const leafValue = (indices: number[]): number => {
    if (task === "regression") {
      let sum = 0;
      for (const index of indices) sum += target[index];
      return sum / indices.length;
    }
    const counts = new Array<number>(classes).fill(0);
    for (const index of indices) counts[target[index]] += 1;
    let best = 0;
    for (let cls = 1; cls < classes; cls += 1) if (counts[cls] > counts[best]) best = cls;
    return best;
  };

  const build = (indices: number[], depth: number): number => {
    const nodeId = nodes.length;
    nodes.push({ feature: -1, threshold: 0, left: -1, right: -1, value: leafValue(indices), samples: indices.length });
    if (depth >= options.maxDepth || indices.length < 2 * options.minLeaf) return nodeId;

    const count = indices.length;
    let parentScore = 0;
    let totalSum = 0;
    let totalSquares = 0;
    const totalCounts = new Array<number>(classes).fill(0);
    if (task === "regression") {
      for (const index of indices) {
        totalSum += target[index];
        totalSquares += target[index] ** 2;
      }
      parentScore = totalSquares - totalSum ** 2 / count;
      // Relative test, so targets of any magnitude (1e-6 or 1e9) can still split.
      if (parentScore <= 1e-12 * totalSquares) return nodeId;
    } else {
      for (const index of indices) totalCounts[target[index]] += 1;
      if (totalCounts.some((entry) => entry === count)) return nodeId;
      parentScore = count * (1 - totalCounts.reduce((sum, entry) => sum + (entry / count) ** 2, 0));
    }

    let bestGain = task === "regression" ? parentScore * 1e-9 : 1e-12;
    let bestFeature = -1;
    let bestThreshold = 0;
    for (let feature = 0; feature < columns; feature += 1) {
      const order = indices.slice().sort((left, right) => features[left][feature] - features[right][feature]);
      let leftSum = 0;
      let leftSquares = 0;
      const leftCounts = new Array<number>(classes).fill(0);
      for (let position = 0; position < count - 1; position += 1) {
        const index = order[position];
        if (task === "regression") {
          leftSum += target[index];
          leftSquares += target[index] ** 2;
        } else {
          leftCounts[target[index]] += 1;
        }
        const leftSize = position + 1;
        const rightSize = count - leftSize;
        const here = features[index][feature];
        const next = features[order[position + 1]][feature];
        if (here === next || leftSize < options.minLeaf || rightSize < options.minLeaf) continue;
        let gain: number;
        if (task === "regression") {
          const rightSum = totalSum - leftSum;
          const rightSquares = totalSquares - leftSquares;
          const childScore =
            leftSquares - leftSum ** 2 / leftSize + (rightSquares - rightSum ** 2 / rightSize);
          gain = parentScore - childScore;
        } else {
          let leftGini = 1;
          let rightGini = 1;
          for (let cls = 0; cls < classes; cls += 1) {
            leftGini -= (leftCounts[cls] / leftSize) ** 2;
            rightGini -= ((totalCounts[cls] - leftCounts[cls]) / rightSize) ** 2;
          }
          gain = parentScore - (leftSize * leftGini + rightSize * rightGini);
        }
        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = feature;
          bestThreshold = (here + next) / 2;
        }
      }
    }
    if (bestFeature < 0) return nodeId;

    const leftIndices: number[] = [];
    const rightIndices: number[] = [];
    for (const index of indices) (features[index][bestFeature] <= bestThreshold ? leftIndices : rightIndices).push(index);
    if (leftIndices.length === 0 || rightIndices.length === 0) return nodeId;
    nodes[nodeId].feature = bestFeature;
    nodes[nodeId].threshold = bestThreshold;
    nodes[nodeId].left = build(leftIndices, depth + 1);
    nodes[nodeId].right = build(rightIndices, depth + 1);
    return nodeId;
  };

  build(
    features.map((_, index) => index),
    0,
  );
  return { nodes };
}

export function predictTree(model: TreeModel, row: number[]): number {
  let node = model.nodes[0];
  while (node.feature >= 0) node = model.nodes[row[node.feature] <= node.threshold ? node.left : node.right];
  return node.value;
}

export function treeDepth(model: TreeModel): number {
  const measure = (id: number): number => {
    const node = model.nodes[id];
    return node.feature < 0 ? 0 : 1 + Math.max(measure(node.left), measure(node.right));
  };
  return measure(0);
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

export function regressionMetrics(actual: number[], predicted: number[]) {
  const count = actual.length;
  let absolute = 0;
  let squared = 0;
  let total = 0;
  for (const value of actual) total += value;
  const mean = total / count;
  let variation = 0;
  for (let index = 0; index < count; index += 1) {
    const error = actual[index] - predicted[index];
    absolute += Math.abs(error);
    squared += error * error;
    variation += (actual[index] - mean) ** 2;
  }
  return {
    mae: absolute / count,
    rmse: Math.sqrt(squared / count),
    /** Null when the held-out target is constant (R² is undefined). */
    r2: variation === 0 ? null : 1 - squared / variation,
  };
}

export function classificationMetrics(actual: number[], predicted: number[], classes: number) {
  const matrix = Array.from({ length: classes }, () => new Array<number>(classes).fill(0));
  let correct = 0;
  for (let index = 0; index < actual.length; index += 1) {
    matrix[actual[index]][predicted[index]] += 1;
    if (actual[index] === predicted[index]) correct += 1;
  }
  const perClass = Array.from({ length: classes }, (_, cls) => {
    const truePositive = matrix[cls][cls];
    const predictedTotal = matrix.reduce((sum, line) => sum + line[cls], 0);
    const support = matrix[cls].reduce((sum, value) => sum + value, 0);
    const precision = predictedTotal ? truePositive / predictedTotal : 0;
    const recall = support ? truePositive / support : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { precision, recall, f1, support, predictedTotal };
  });
  // Like scikit-learn's default, average over classes seen in either list.
  const present = perClass.filter((entry) => entry.support > 0 || entry.predictedTotal > 0);
  return {
    accuracy: correct / actual.length,
    macroF1: present.reduce((sum, entry) => sum + entry.f1, 0) / Math.max(1, present.length),
    matrix,
    perClass,
  };
}

/* -------------------------------------------------------------------------- */
/* Feature encoding (fitted on training rows only)                            */
/* -------------------------------------------------------------------------- */

type DesignSource = {
  column: string;
  index: number;
  kind: "numeric" | "category";
  median: number;
  categories: string[];
};

export type Design = {
  sources: DesignSource[];
  names: string[];
  /** For each kept design column: which source feature it came from. */
  owner: number[];
  /** Raw (pre-scaling) column positions that were kept. */
  kept: number[];
  mean: number[];
  std: number[];
  skipped: string[];
};

function rawNames(sources: DesignSource[]): Array<{ name: string; owner: number }> {
  const names: Array<{ name: string; owner: number }> = [];
  sources.forEach((source, owner) => {
    if (source.kind === "numeric") names.push({ name: source.column, owner });
    else for (const category of source.categories) names.push({ name: `${source.column} = ${category}`, owner });
  });
  return names;
}

function rawVector(sources: DesignSource[], row: string[]): number[] {
  const vector: number[] = [];
  for (const source of sources) {
    const text = (row[source.index] ?? "").trim();
    if (source.kind === "numeric") {
      const value = parseNumber(text);
      vector.push(value === null ? source.median : value);
    } else {
      for (const category of source.categories) vector.push(text === category ? 1 : 0);
    }
  }
  return vector;
}

export function fitDesign(table: DataTable, trainRows: number[], featureColumns: string[]): Design {
  const sources: DesignSource[] = [];
  for (const column of featureColumns) {
    const index = table.columns.indexOf(column);
    if (index < 0) throw new Error(`Feature "${column}" does not exist in the current dataset.`);
    const present = table.rows.map((row) => (row[index] ?? "").trim()).filter((value) => value !== "");
    const allNumeric = present.length > 0 && present.every((value) => parseNumber(value) !== null);
    if (allNumeric) {
      const trainNumbers = trainRows
        .map((row) => parseNumber(table.rows[row][index] ?? ""))
        .filter((value): value is number => value !== null)
        .sort((left, right) => left - right);
      sources.push({ column, index, kind: "numeric", median: trainNumbers.length ? quantileSorted(trainNumbers, 0.5) : 0, categories: [] });
    } else {
      const counts = new Map<string, number>();
      for (const row of trainRows) {
        const value = (table.rows[row][index] ?? "").trim();
        if (value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      if (counts.size > MAX_CATEGORY_FEATURE_UNIQUE)
        throw new Error(
          `"${column}" has ${counts.size} distinct values, which is too many to encode reliably. Remove it or group its values first.`,
        );
      const categories = [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
        .slice(0, MAX_CATEGORIES_PER_FEATURE)
        .map(([value]) => value);
      sources.push({ column, index, kind: "category", median: 0, categories });
    }
  }
  const raw = rawNames(sources);
  const matrix = trainRows.map((row) => rawVector(sources, table.rows[row]));
  const mean: number[] = [];
  const std: number[] = [];
  const kept: number[] = [];
  const skipped: string[] = [];
  for (let column = 0; column < raw.length; column += 1) {
    let sum = 0;
    for (const row of matrix) sum += row[column];
    const average = sum / matrix.length;
    let squares = 0;
    for (const row of matrix) squares += (row[column] - average) ** 2;
    const deviation = Math.sqrt(squares / matrix.length);
    if (deviation < 1e-12) {
      skipped.push(raw[column].name);
      continue;
    }
    kept.push(column);
    mean.push(average);
    std.push(deviation);
  }
  if (kept.length === 0)
    throw new Error("The selected features do not vary in the training rows, so there is nothing to learn from.");
  if (kept.length > MAX_DESIGN_COLUMNS)
    throw new Error(`The features expand to ${kept.length} columns after encoding; the limit is ${MAX_DESIGN_COLUMNS}. Select fewer features.`);
  return {
    sources,
    names: kept.map((column) => raw[column].name),
    owner: kept.map((column) => raw[column].owner),
    kept,
    mean,
    std,
    skipped,
  };
}

export function transformRows(design: Design, table: DataTable, rows: number[]): number[][] {
  return rows.map((rowIndex) => {
    const raw = rawVector(design.sources, table.rows[rowIndex]);
    return design.kept.map((column, position) => (raw[column] - design.mean[position]) / design.std[position]);
  });
}

/* -------------------------------------------------------------------------- */
/* Target preparation and splitting                                           */
/* -------------------------------------------------------------------------- */

type PreparedTarget = {
  /** Table row indexes with a usable target. */
  rows: number[];
  /** Numbers (regression) or class indexes (classification). */
  values: number[];
  classes: string[];
  droppedMissingTarget: number;
};

function prepareTarget(table: DataTable, target: string, task: Task): PreparedTarget {
  const index = table.columns.indexOf(target);
  if (index < 0) throw new Error("Choose a target column that exists in the current dataset.");
  const rows: number[] = [];
  const raw: string[] = [];
  table.rows.forEach((row, position) => {
    const value = (row[index] ?? "").trim();
    if (value === "") return;
    rows.push(position);
    raw.push(value);
  });
  const droppedMissingTarget = table.rows.length - rows.length;
  if (task === "regression") {
    const values = raw.map(parseNumber);
    if (values.some((value) => value === null))
      throw new Error("Regression requires a numeric target column without non-numeric values.");
    return { rows, values: values as number[], classes: [], droppedMissingTarget };
  }
  const counts = new Map<string, number>();
  for (const value of raw) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (counts.size < 2) throw new Error("Classification needs a target with at least two different values.");
  if (counts.size > MAX_CLASSES)
    throw new Error(
      `The target has ${counts.size} distinct values. Classification is limited to ${MAX_CLASSES} classes; pick a category column or use regression for numbers.`,
    );
  const classes = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([value]) => value);
  const lookup = new Map(classes.map((value, position) => [value, position]));
  return { rows, values: raw.map((value) => lookup.get(value) as number), classes, droppedMissingTarget };
}

export function splitIndices(
  count: number,
  testFraction: number,
  mode: SplitMode,
  random: () => number,
  labels?: number[],
): { train: number[]; test: number[] } {
  const testCount = Math.min(count - 2, Math.max(1, Math.round(count * testFraction)));
  if (mode === "chronological") {
    const cut = count - testCount;
    return {
      train: Array.from({ length: cut }, (_, index) => index),
      test: Array.from({ length: testCount }, (_, index) => cut + index),
    };
  }
  const test = new Set<number>();
  if (labels) {
    const groups = new Map<number, number[]>();
    labels.forEach((label, index) => groups.set(label, [...(groups.get(label) ?? []), index]));
    for (const label of [...groups.keys()].sort((left, right) => left - right)) {
      const members = shuffleInPlace(groups.get(label) as number[], random);
      const share = members.length < 2 ? 0 : Math.max(1, Math.round(members.length * testFraction));
      for (const member of members.slice(0, Math.min(share, members.length - 1))) test.add(member);
    }
  } else {
    const order = shuffleInPlace(Array.from({ length: count }, (_, index) => index), random);
    for (const member of order.slice(0, testCount)) test.add(member);
  }
  if (test.size === 0) test.add(Math.floor(random() * count));
  const train: number[] = [];
  const held: number[] = [];
  for (let index = 0; index < count; index += 1) (test.has(index) ? held : train).push(index);
  return { train, test: held };
}

/* -------------------------------------------------------------------------- */
/* Training pipeline                                                          */
/* -------------------------------------------------------------------------- */

type Predictor = (row: number[]) => number;
type Trained = { predict: Predictor; coefficients: Array<{ name: string; value: number }> | null };

function trainModel(
  config: ModelConfig,
  features: number[][],
  target: number[],
  classes: number,
  names: string[],
): Trained {
  if (config.model === "tree") {
    const minLeaf = Math.max(2, Math.round(features.length * 0.01));
    const tree = fitTree(features, target, config.task, classes, { maxDepth: config.maxDepth ?? 5, minLeaf });
    return { predict: (row) => predictTree(tree, row), coefficients: null };
  }
  if (config.task === "regression") {
    const ridge = fitRidge(features, target, config.ridge ?? 1);
    return {
      predict: (row) => predictRidge(ridge, row),
      coefficients: names.map((name, position) => ({ name, value: ridge.weights[position] })),
    };
  }
  const softmax = fitSoftmax(features, target, classes, config.regularization ?? 1);
  return { predict: (row) => predictSoftmax(softmax, row), coefficients: null };
}

function baselineValue(task: Task, target: number[], classes: number): number {
  if (task === "regression") return target.reduce((sum, value) => sum + value, 0) / target.length;
  const counts = new Array<number>(classes).fill(0);
  for (const value of target) counts[value] += 1;
  let best = 0;
  for (let cls = 1; cls < classes; cls += 1) if (counts[cls] > counts[best]) best = cls;
  return best;
}

function primaryScore(task: Task, actual: number[], predicted: number[], classes: number): number {
  if (task === "regression") return regressionMetrics(actual, predicted).r2 ?? 0;
  return classificationMetrics(actual, predicted, classes).accuracy;
}

const PERMUTATIONS = 500;

/**
 * Shuffles the held-out answers and re-scores the fixed predictions. The
 * share of shuffles that score at least as well as the real answers estimates
 * the chance of getting this score with no real relationship (add-one
 * smoothing keeps p above zero).
 */
export function permutationPValue(
  task: Task,
  actual: number[],
  predicted: number[],
  classes: number,
  random: () => number,
  permutations = PERMUTATIONS,
): number {
  const observed = primaryScore(task, actual, predicted, classes);
  const shuffled = actual.slice();
  let atLeastAsGood = 0;
  for (let round = 0; round < permutations; round += 1) {
    shuffleInPlace(shuffled, random);
    if (primaryScore(task, shuffled, predicted, classes) >= observed - 1e-12) atLeastAsGood += 1;
  }
  return (atLeastAsGood + 1) / (permutations + 1);
}

function spread(values: number[]): { mean: number; std: number | null } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, std: null };
  return { mean, std: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) };
}

function makeFolds(
  count: number,
  folds: number,
  mode: SplitMode,
  random: () => number,
  labels?: number[],
): Array<{ train: number[]; test: number[] }> {
  if (mode === "chronological") {
    const block = Math.floor(count / (folds + 1));
    if (block < 2) return [];
    return Array.from({ length: folds }, (_, fold) => {
      const start = (fold + 1) * block;
      const end = fold === folds - 1 ? count : start + block;
      return {
        train: Array.from({ length: start }, (_, index) => index),
        test: Array.from({ length: end - start }, (_, index) => start + index),
      };
    });
  }
  const assignment = new Array<number>(count).fill(0);
  let counter = 0;
  if (labels) {
    const groups = new Map<number, number[]>();
    labels.forEach((label, index) => groups.set(label, [...(groups.get(label) ?? []), index]));
    for (const label of [...groups.keys()].sort((left, right) => left - right))
      for (const member of shuffleInPlace(groups.get(label) as number[], random)) {
        assignment[member] = counter % folds;
        counter += 1;
      }
  } else {
    for (const member of shuffleInPlace(Array.from({ length: count }, (_, index) => index), random)) {
      assignment[member] = counter % folds;
      counter += 1;
    }
  }
  return Array.from({ length: folds }, (_, fold) => ({
    train: assignment.flatMap((value, index) => (value === fold ? [] : [index])),
    test: assignment.flatMap((value, index) => (value === fold ? [index] : [])),
  }));
}

/** Columns a user can pick as model inputs by default. */
export function suggestFeatures(table: DataTable, target: string): string[] {
  const usable: SemanticType[] = ["integer", "numeric", "boolean", "categorical"];
  return table.columns.filter((name, index) => {
    if (name === target) return false;
    const insight = analyzeColumn(name, table.rows.map((row) => row[index] ?? ""), table.rows.length);
    return usable.includes(insight.type);
  });
}

/** Regression for continuous numbers; classification for categories and small integer sets. */
export function suggestTask(table: DataTable, target: string): Task {
  const index = table.columns.indexOf(target);
  if (index < 0) return "regression";
  const insight = analyzeColumn(target, table.rows.map((row) => row[index] ?? ""), table.rows.length);
  return insight.numeric && insight.unique > 10 ? "regression" : "classification";
}

export function runModel(table: DataTable, config: ModelConfig): ModelReport {
  if (!table.columns.includes(config.target)) throw new Error("Choose a target column that exists in the current dataset.");
  const features = config.features.filter((name) => name !== config.target);
  if (features.length === 0) throw new Error("Select at least one feature column besides the target.");
  if (!(config.testFraction >= 0.1 && config.testFraction <= 0.5)) throw new Error("Hold out between 10% and 50% of rows for testing.");
  if (!Number.isInteger(config.seed)) throw new Error("The random seed must be a whole number.");
  if (config.folds !== 0 && !(Number.isInteger(config.folds) && config.folds >= 2 && config.folds <= 10))
    throw new Error("Use 0 (off) or 2 to 10 cross-validation folds.");

  const warnings: string[] = [];
  const prepared = prepareTarget(table, config.target, config.task);
  let rows = prepared.rows;
  let values = prepared.values;
  let sampledFrom: number | null = null;
  if (rows.length > MAX_MODEL_ROWS) {
    sampledFrom = rows.length;
    const chosen = shuffleInPlace(Array.from({ length: rows.length }, (_, index) => index), createRng(config.seed ^ 0x51ed270b))
      .slice(0, MAX_MODEL_ROWS)
      .sort((left, right) => left - right);
    rows = chosen.map((index) => rows[index]);
    values = chosen.map((index) => values[index]);
    warnings.push(`Used a seeded sample of ${MAX_MODEL_ROWS.toLocaleString()} of ${sampledFrom.toLocaleString()} rows to keep training responsive.`);
  }
  if (rows.length < MIN_MODEL_ROWS)
    throw new Error(`At least ${MIN_MODEL_ROWS} rows with a target value are needed to train and test a model.`);
  if (prepared.droppedMissingTarget > 0)
    warnings.push(`Skipped ${prepared.droppedMissingTarget.toLocaleString()} row${prepared.droppedMissingTarget === 1 ? "" : "s"} with no target value.`);

  const classCount = prepared.classes.length;
  const labels = config.task === "classification" ? values : undefined;
  const { train, test } = splitIndices(rows.length, config.testFraction, config.split, createRng(config.seed), labels);
  const trainRows = train.map((index) => rows[index]);
  const testRows = test.map((index) => rows[index]);
  const trainTarget = train.map((index) => values[index]);
  const testTarget = test.map((index) => values[index]);
  if (config.task === "classification" && new Set(trainTarget).size < 2)
    throw new Error("The training rows contain a single class. Use a random split or add more varied rows.");

  const design = fitDesign(table, trainRows, features);
  const xTrain = transformRows(design, table, trainRows);
  const xTest = transformRows(design, table, testRows);
  const trained = trainModel(config, xTrain, trainTarget, classCount, design.names);
  const predicted = xTest.map((row) => trained.predict(row));
  const constant = baselineValue(config.task, trainTarget, classCount);
  const baselinePredicted = testTarget.map(() => constant);

  const metrics: MetricRow[] = [];
  let primaryLabel: string;
  let primaryModel: number;
  let primaryBaseline: number;
  let confusion: ModelReport["confusion"] = null;
  let classReport: ModelReport["classReport"] = null;
  if (config.task === "regression") {
    const model = regressionMetrics(testTarget, predicted);
    const base = regressionMetrics(testTarget, baselinePredicted);
    metrics.push(
      { label: "MAE", model: model.mae, baseline: base.mae, higherIsBetter: false, percent: false },
      { label: "RMSE", model: model.rmse, baseline: base.rmse, higherIsBetter: false, percent: false },
      { label: "R²", model: model.r2, baseline: base.r2, higherIsBetter: true, percent: false },
    );
    primaryLabel = "R²";
    primaryModel = model.r2 ?? 0;
    primaryBaseline = base.r2 ?? 0;
  } else {
    const model = classificationMetrics(testTarget, predicted, classCount);
    const base = classificationMetrics(testTarget, baselinePredicted, classCount);
    metrics.push(
      { label: "Accuracy", model: model.accuracy, baseline: base.accuracy, higherIsBetter: true, percent: true },
      { label: "Macro F1", model: model.macroF1, baseline: base.macroF1, higherIsBetter: true, percent: true },
    );
    primaryLabel = "Accuracy";
    primaryModel = model.accuracy;
    primaryBaseline = base.accuracy;
    confusion = { classes: prepared.classes, matrix: model.matrix };
    classReport = model.perClass.map((entry, cls) => ({
      label: prepared.classes[cls],
      precision: entry.precision,
      recall: entry.recall,
      f1: entry.f1,
      support: entry.support,
    }));
  }
  const beatsBaseline = primaryModel > primaryBaseline + 1e-12;
  const pValue = permutationPValue(config.task, testTarget, predicted, classCount, createRng(config.seed ^ 0x85ebca6b));
  const significant = beatsBaseline && pValue < 0.05;

  // Permutation importance on the held-out rows: how much does shuffling one
  // original feature (all of its encoded columns together) hurt the score?
  const importanceRandom = createRng(config.seed ^ 0x9e3779b9);
  const repeats = 5;
  const reference = primaryScore(config.task, testTarget, predicted, classCount);
  const importance = design.sources.map((source, owner) => {
    const columnsOfSource = design.owner.flatMap((value, position) => (value === owner ? [position] : []));
    const drops: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const order = shuffleInPlace(Array.from({ length: xTest.length }, (_, index) => index), importanceRandom);
      const shuffled = xTest.map((row, index) => {
        const copy = row.slice();
        for (const position of columnsOfSource) copy[position] = xTest[order[index]][position];
        return copy;
      });
      drops.push(reference - primaryScore(config.task, testTarget, shuffled.map((row) => trained.predict(row)), classCount));
    }
    const { mean, std } = spread(drops);
    return { feature: source.column, importance: mean, std: std ?? 0, share: 0 };
  });
  const positive = importance.reduce((sum, entry) => sum + Math.max(0, entry.importance), 0);
  for (const entry of importance) entry.share = positive > 0 ? Math.max(0, entry.importance) / positive : 0;
  importance.sort((left, right) => right.importance - left.importance || compareText(left.feature, right.feature));

  // Cross-validation repeats the whole pipeline (encoding included) per fold.
  let crossValidation: ModelReport["crossValidation"] = null;
  if (config.folds >= 2) {
    const foldList = makeFolds(rows.length, config.folds, config.split, createRng(config.seed ^ 0x2545f491), labels);
    const modelScores: number[] = [];
    const baselineScores: number[] = [];
    for (const fold of foldList) {
      const foldTrainTarget = fold.train.map((index) => values[index]);
      if (config.task === "classification" && new Set(foldTrainTarget).size < 2) continue;
      if (fold.train.length < 2 || fold.test.length < 1) continue;
      try {
        const foldDesign = fitDesign(table, fold.train.map((index) => rows[index]), features);
        const foldModel = trainModel(config, transformRows(foldDesign, table, fold.train.map((index) => rows[index])), foldTrainTarget, classCount, foldDesign.names);
        const foldTestTarget = fold.test.map((index) => values[index]);
        const foldPredicted = transformRows(foldDesign, table, fold.test.map((index) => rows[index])).map((row) => foldModel.predict(row));
        const foldConstant = baselineValue(config.task, foldTrainTarget, classCount);
        modelScores.push(primaryScore(config.task, foldTestTarget, foldPredicted, classCount));
        baselineScores.push(primaryScore(config.task, foldTestTarget, foldTestTarget.map(() => foldConstant), classCount));
      } catch {
        // A fold whose training rows do not vary is skipped rather than failing the run.
      }
    }
    if (modelScores.length >= 2) {
      crossValidation = {
        folds: modelScores.length,
        label: primaryLabel,
        model: { ...spread(modelScores), scores: modelScores },
        baseline: spread(baselineScores),
      };
    } else {
      warnings.push("Cross-validation was skipped because there were too few usable rows for separate folds.");
    }
  }

  // Honest caveats.
  if (rows.length < 30) warnings.push(`Only ${rows.length} usable rows: scores are noisy and should be treated as illustrations.`);
  if (testRows.length < 10) warnings.push(`Only ${testRows.length} held-out row${testRows.length === 1 ? "" : "s"}, so a single score can swing widely.`);
  if (trainRows.length < 10 * design.names.length)
    warnings.push(`Few rows per feature (${trainRows.length} training rows for ${design.names.length} encoded columns): overfitting is likely.`);
  if (config.task === "classification") {
    const share = Math.max(...prepared.classes.map((_, cls) => values.filter((value) => value === cls).length)) / values.length;
    if (share > 0.8)
      warnings.push(`The most common class is ${Math.round(share * 100)}% of rows, so accuracy alone can mislead; compare F1 and the confusion matrix.`);
  }
  if (!beatsBaseline) warnings.push("The model does not beat the simple baseline on the held-out rows. The features may not explain the target.");
  else if (!significant)
    warnings.push(
      `The model scores higher than the baseline, but on only ${testRows.length} held-out rows that gap could easily be luck (permutation p = ${pValue.toFixed(2)}). Treat it as no evidence yet.`,
    );
  if (config.split === "chronological")
    warnings.push("Rows were kept in file order (oldest first assumed): the last rows are the test set. Sort the file by time before relying on this.");
  if (design.skipped.length)
    warnings.push(`Ignored ${design.skipped.length} encoded column${design.skipped.length === 1 ? "" : "s"} that never vary in the training rows.`);
  const suspects = findLeakageSuspects(table, rows, values, prepared.classes.length, config, features);
  for (const name of suspects)
    warnings.push(`"${name}" predicts the target almost perfectly. It may be a copy or consequence of the target (leakage), which would make these scores unrealistic.`);

  const label = (value: number) => (config.task === "regression" ? String(Number(value.toPrecision(8))) : prepared.classes[value]);
  return {
    task: config.task,
    model: config.model,
    split: config.split,
    seed: config.seed,
    rows: { used: rows.length, train: trainRows.length, test: testRows.length, droppedMissingTarget: prepared.droppedMissingTarget, sampledFrom },
    features,
    encodedFeatures: design.names.length,
    metrics,
    primary: { label: primaryLabel, model: primaryModel, baseline: primaryBaseline, beatsBaseline, pValue, significant },
    crossValidation,
    confusion,
    classReport,
    importance,
    coefficients: trained.coefficients,
    predictions: testRows.map((row, index) => ({ row, actual: label(testTarget[index]), predicted: label(predicted[index]) })),
    warnings,
  };
}

/** Flags features that are near-copies of the target (a common cause of too-good scores). */
function findLeakageSuspects(
  table: DataTable,
  rows: number[],
  values: number[],
  classCount: number,
  config: ModelConfig,
  features: string[],
): string[] {
  const suspects: string[] = [];
  for (const name of features) {
    const index = table.columns.indexOf(name);
    if (config.task === "regression") {
      const pairs: Array<[number, number]> = [];
      rows.forEach((row, position) => {
        const x = parseNumber(table.rows[row][index] ?? "");
        if (x !== null) pairs.push([x, values[position]]);
      });
      if (pairs.length < 8) continue;
      const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
      const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
      let covariance = 0;
      let varianceX = 0;
      let varianceY = 0;
      for (const [x, y] of pairs) {
        covariance += (x - meanX) * (y - meanY);
        varianceX += (x - meanX) ** 2;
        varianceY += (y - meanY) ** 2;
      }
      if (varianceX > 0 && varianceY > 0 && Math.abs(covariance / Math.sqrt(varianceX * varianceY)) >= 0.999) suspects.push(name);
    } else {
      const groups = new Map<string, Set<number>>();
      const sizes = new Map<string, number>();
      rows.forEach((row, position) => {
        const key = (table.rows[row][index] ?? "").trim();
        if (key === "") return;
        const set = groups.get(key) ?? new Set<number>();
        set.add(values[position]);
        groups.set(key, set);
        sizes.set(key, (sizes.get(key) ?? 0) + 1);
      });
      if (groups.size < 2 || groups.size > Math.max(classCount * 3, 12)) continue;
      const total = [...sizes.values()].reduce((sum, value) => sum + value, 0);
      if ([...groups.values()].every((set) => set.size === 1) && total / groups.size >= 3) suspects.push(name);
    }
  }
  return suspects;
}
