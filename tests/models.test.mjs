import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_MODEL_ROWS,
  classificationMetrics,
  createRng,
  fitDesign,
  fitRidge,
  fitSoftmax,
  fitTree,
  predictRidge,
  predictSoftmax,
  permutationPValue,
  predictTree,
  regressionMetrics,
  runModel,
  shuffleInPlace,
  softmaxProbabilities,
  splitIndices,
  suggestFeatures,
  suggestTask,
  treeDepth,
} from "../src/models.ts";

const oracle = JSON.parse(readFileSync(new URL("./fixtures/oracle-models.json", import.meta.url), "utf8"));

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual} (tolerance ${tolerance})`);

/* ----------------------------- scikit-learn oracle ----------------------------- */

test("ORACLE: ridge regression matches scikit-learn Ridge (coefficients, intercept, predictions)", () => {
  for (const reference of oracle.ridge) {
    const model = fitRidge(reference.X, reference.y, reference.alpha);
    reference.coef.forEach((expected, index) => near(model.weights[index], expected, 1e-9, `alpha ${reference.alpha} coef ${index}`));
    near(model.intercept, reference.intercept, 1e-9, `alpha ${reference.alpha} intercept`);
    reference.Xnew.forEach((row, index) => near(predictRidge(model, row), reference.pred[index], 1e-9, `alpha ${reference.alpha} prediction ${index}`));
  }
});

test("ORACLE: multiclass logistic regression matches scikit-learn probabilities and labels", () => {
  for (const reference of oracle.logistic_multi) {
    const model = fitSoftmax(reference.X, reference.y, 3, reference.C);
    reference.Xnew.forEach((row, index) => {
      const probabilities = softmaxProbabilities(model, row);
      probabilities.forEach((value, cls) => near(value, reference.proba[index][cls], 2e-5, `C ${reference.C} row ${index} class ${cls}`));
      assert.equal(predictSoftmax(model, row), reference.pred[index], `C ${reference.C} label ${index}`);
      near(probabilities.reduce((sum, value) => sum + value, 0), 1, 1e-12, "probabilities sum to one");
    });
  }
});

test("ORACLE: binary logistic regression matches scikit-learn across regularization strengths", () => {
  for (const reference of oracle.logistic_binary) {
    const model = fitSoftmax(reference.X, reference.y, 2, reference.C);
    reference.Xnew.forEach((row, index) => {
      const probabilities = softmaxProbabilities(model, row);
      probabilities.forEach((value, cls) => near(value, reference.proba[index][cls], 2e-5, `C ${reference.C} row ${index} class ${cls}`));
      assert.equal(predictSoftmax(model, row), reference.pred[index]);
    });
  }
});

test("ORACLE: decision trees reproduce scikit-learn predictions on 200 unseen points", () => {
  for (const reference of oracle.tree) {
    const options = { maxDepth: reference.depth, minLeaf: reference.leaf };
    const classifier = fitTree(reference.X, reference.y_class, "classification", 2, options);
    const regressor = fitTree(reference.X, reference.y_reg, "regression", 0, options);
    reference.Xnew.forEach((row, index) => {
      assert.equal(predictTree(classifier, row), reference.class_pred[index], `depth ${reference.depth} classifier point ${index}`);
      near(predictTree(regressor, row), reference.reg_pred[index], 1e-9, `depth ${reference.depth} regressor point ${index}`);
    });
    assert.ok(treeDepth(classifier) <= reference.depth && treeDepth(regressor) <= reference.depth);
    assert.equal(classifier.nodes.length, reference.class_nodes, "same tree size as scikit-learn (classifier)");
    assert.equal(regressor.nodes.length, reference.reg_nodes, "same tree size as scikit-learn (regressor)");
  }
});

test("ORACLE: regression and classification metrics match scikit-learn", () => {
  const regression = regressionMetrics([3, -0.5, 2, 7, 4.2, 1.1], [2.5, 0, 2, 8, 4, 0.9]);
  near(regression.r2, 0.9536112742219612, 1e-12, "r2");
  near(regression.mae, 0.4000000000000001, 1e-12, "mae");
  near(regression.rmse, 0.5131601439446885, 1e-12, "rmse");
  const result = classificationMetrics([0, 1, 2, 2, 1, 0, 1, 2, 0, 1], [0, 2, 2, 1, 1, 0, 0, 2, 0, 1], 3);
  near(result.accuracy, 0.7, 1e-12, "accuracy");
  near(result.macroF1, 0.6984126984126983, 1e-12, "macro F1");
  assert.deepEqual(result.matrix, [[3, 0, 0], [1, 2, 1], [0, 1, 2]]);
  const precision = [0.75, 2 / 3, 2 / 3];
  const recall = [1, 0.5, 2 / 3];
  result.perClass.forEach((entry, cls) => {
    near(entry.precision, precision[cls], 1e-12, `precision ${cls}`);
    near(entry.recall, recall[cls], 1e-12, `recall ${cls}`);
  });
  near(classificationMetrics([0, 0, 1, 1], [0, 1, 1, 1], 3).macroF1, 0.7333333333333334, 1e-12, "classes absent everywhere are not averaged in");
  assert.equal(regressionMetrics([2, 2, 2], [2, 2, 2]).r2, null, "R² is undefined when the target is constant");
});

/* ------------------------------- primitives ------------------------------- */

test("the seeded generator is repeatable and shuffles are permutations", () => {
  const first = Array.from({ length: 5 }, createRng(42));
  const second = Array.from({ length: 5 }, createRng(42));
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, Array.from({ length: 5 }, createRng(43)));
  assert.ok(first.every((value) => value >= 0 && value < 1));
  const shuffled = shuffleInPlace(Array.from({ length: 50 }, (_, index) => index), createRng(1));
  assert.deepEqual([...shuffled].sort((a, b) => a - b), Array.from({ length: 50 }, (_, index) => index));
});

test("splits never overlap, always cover every row, and stratify classes", () => {
  const labels = [...Array(90).fill(0), ...Array(10).fill(1)];
  const { train, test: held } = splitIndices(100, 0.2, "random", createRng(3), labels);
  assert.equal(new Set([...train, ...held]).size, 100);
  assert.equal(train.length + held.length, 100);
  assert.equal(held.filter((index) => labels[index] === 1).length, 2, "the 10% minority stays 10% of the test set");
  const sparse = splitIndices(6, 0.5, "random", createRng(9), [0, 0, 0, 0, 0, 1]);
  assert.ok(sparse.train.some((index) => index === 5), "a one-member class stays in training");
  const ordered = splitIndices(10, 0.3, "chronological", createRng(1));
  assert.deepEqual(ordered.train, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ordered.test, [7, 8, 9]);
});

/* ------------------------------ end-to-end runs ------------------------------ */

function makeTable(columns, rows) {
  return { sourceName: "t.csv", columns, rows: rows.map((row) => row.map(String)) };
}

function lcg(seed) {
  const random = createRng(seed);
  return { uniform: random, normal: () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random()) };
}

const base = { target: "y", task: "regression", model: "linear", features: ["a", "b"], testFraction: 0.2, seed: 1, split: "random", folds: 0 };

test("a noiseless linear relationship is recovered almost exactly", () => {
  const g = lcg(5);
  const rows = Array.from({ length: 120 }, () => {
    const a = g.normal();
    const b = g.normal();
    return [a, b, 3 * a - 2 * b + 5];
  });
  const report = runModel(makeTable(["a", "b", "y"], rows), { ...base, ridge: 1e-9 });
  assert.ok(report.primary.model > 0.9999, `R² ${report.primary.model}`);
  assert.ok(report.primary.beatsBaseline);
  const coefficients = Object.fromEntries(report.coefficients.map((entry) => [entry.name, entry.value]));
  assert.ok(coefficients.a > 0 && coefficients.b < 0, "signs follow the data");
  assert.ok(Math.abs(coefficients.a) > Math.abs(coefficients.b), "a matters more than b (3 vs 2)");
  assert.equal(report.importance[0].feature, "a");
  near(report.importance.reduce((sum, entry) => sum + entry.share, 0), 1, 1e-9, "importance shares");
});

test("pure noise does not fool the evaluation (R² near or below zero, flagged against baseline)", () => {
  const g = lcg(11);
  const rows = Array.from({ length: 200 }, () => [g.normal(), g.normal(), g.normal()]);
  const report = runModel(makeTable(["a", "b", "y"], rows), { ...base, folds: 5 });
  assert.ok(report.primary.model < 0.15, `noise R² should be near zero, got ${report.primary.model}`);
  assert.ok(report.crossValidation.model.mean < 0.15);
  assert.ok(report.crossValidation.model.scores.length === 5);
});

test("a tree learns XOR, which a linear classifier cannot", () => {
  // XOR has no useful single split, so greedy CART needs depth to find it. This
  // matches scikit-learn exactly (depth 4 reaches only ~87% on the training
  // data of seed 21; depth 6 reaches 99.7%), so the test uses a deeper tree.
  const g = lcg(21);
  const rows = Array.from({ length: 600 }, () => {
    const a = g.uniform() * 2 - 1;
    const b = g.uniform() * 2 - 1;
    return [a, b, a > 0 !== b > 0 ? "yes" : "no"];
  });
  const table = makeTable(["a", "b", "y"], rows);
  const config = { ...base, task: "classification", seed: 4 };
  const tree = runModel(table, { ...config, model: "tree", maxDepth: 8 });
  const linear = runModel(table, { ...config, model: "linear" });
  assert.ok(tree.primary.model > 0.9, `tree accuracy ${tree.primary.model}`);
  assert.ok(linear.primary.model < 0.7, `linear accuracy ${linear.primary.model}`);
  assert.ok(tree.primary.beatsBaseline);
});

test("separable classes give a perfect confusion matrix with consistent bookkeeping", () => {
  const g = lcg(2);
  const rows = Array.from({ length: 90 }, (_, index) => {
    const cls = index % 3;
    return [g.normal() * 0.2 + cls * 5, g.normal() * 0.2, ["low", "mid", "high"][cls]];
  });
  const report = runModel(makeTable(["a", "b", "y"], rows), { ...base, task: "classification" });
  assert.equal(report.primary.model, 1);
  const total = report.confusion.matrix.flat().reduce((sum, value) => sum + value, 0);
  assert.equal(total, report.rows.test);
  assert.equal(report.rows.train + report.rows.test, report.rows.used);
  assert.equal(report.predictions.length, report.rows.test);
  assert.equal(report.classReport.reduce((sum, entry) => sum + entry.support, 0), report.rows.test);
  report.confusion.matrix.forEach((line, index) => assert.equal(line.reduce((sum, value, column) => sum + (column === index ? 0 : value), 0), 0));
});

test("runs are deterministic for a seed, and the seed changes the split", () => {
  const g = lcg(8);
  const rows = Array.from({ length: 100 }, () => {
    const a = g.normal();
    return [a, g.normal(), a + g.normal() * 0.5];
  });
  const table = makeTable(["a", "b", "y"], rows);
  const config = { ...base, folds: 4, model: "tree" };
  assert.deepEqual(runModel(table, config), runModel(table, config));
  const other = runModel(table, { ...config, seed: 2 });
  assert.notDeepEqual(
    other.predictions.map((entry) => entry.row),
    runModel(table, config).predictions.map((entry) => entry.row),
  );
});

test("NO LEAKAGE: encoding statistics come from training rows only", () => {
  const rows = Array.from({ length: 20 }, (_, index) => [index, index % 2 ? "x" : "y", index]);
  const table = makeTable(["a", "c", "y"], rows);
  const trainRows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const design = fitDesign(table, trainRows, ["a", "c"]);
  const trainMean = trainRows.reduce((sum, row) => sum + row, 0) / trainRows.length;
  near(design.mean[0], trainMean, 1e-12, "mean of a");
  const poisoned = makeTable(["a", "c", "y"], rows.map((row, index) => (index >= 15 ? [1e9, "z", row[2]] : row)));
  const again = fitDesign(poisoned, trainRows, ["a", "c"]);
  assert.deepEqual(again.mean, design.mean, "changing held-out rows cannot move the fitted scaler");
  assert.deepEqual(again.std, design.std);
  assert.deepEqual(again.names, design.names, "held-out categories cannot enter the vocabulary");
});

test("chronological mode tests on the last rows and cross-validates forward in time", () => {
  const rows = Array.from({ length: 60 }, (_, index) => [index, (index * 7) % 5, index * 2 + 1]);
  const report = runModel(makeTable(["a", "b", "y"], rows), { ...base, split: "chronological", folds: 4, testFraction: 0.25 });
  const heldRows = report.predictions.map((entry) => entry.row);
  assert.deepEqual(heldRows, Array.from({ length: 15 }, (_, index) => 45 + index));
  assert.equal(report.crossValidation.folds, 4);
  assert.ok(report.warnings.some((warning) => /file order/.test(warning)));
});

test("missing values and unseen categories are handled without crashing", () => {
  const g = lcg(14);
  const rows = Array.from({ length: 60 }, (_, index) => {
    const a = g.normal();
    return [index % 7 === 0 ? "" : a, index % 3 === 0 ? "red" : index % 3 === 1 ? "blue" : index === 59 ? "violet" : "green", a * 2 + (index % 3)];
  });
  const report = runModel(makeTable(["a", "color", "y"], rows), { ...base, features: ["a", "color"], split: "chronological" });
  assert.ok(Number.isFinite(report.primary.model));
  assert.ok(report.encodedFeatures >= 3);
});

test("importance ranks the informative feature above noise", () => {
  const g = lcg(30);
  const rows = Array.from({ length: 160 }, () => {
    const signal = g.normal();
    return [g.normal(), signal, signal * 4];
  });
  const report = runModel(makeTable(["noise", "signal", "y"], rows), { ...base, features: ["noise", "signal"] });
  assert.equal(report.importance[0].feature, "signal");
  assert.ok(report.importance[0].importance > report.importance[1].importance * 5);
});

test("leakage suspects are flagged for both tasks", () => {
  const g = lcg(40);
  const rows = Array.from({ length: 80 }, () => {
    const a = g.normal();
    return [a, a * 2, g.normal()];
  });
  const regression = runModel(makeTable(["noise", "copy", "y"], rows.map(([noise, , y]) => [noise, y * 1, y])), { ...base, features: ["noise", "copy"] });
  assert.ok(regression.warnings.some((warning) => /"copy" predicts the target almost perfectly/.test(warning)));
  const labelled = Array.from({ length: 90 }, (_, index) => {
    const cls = index % 3 === 0 ? "A" : index % 3 === 1 ? "B" : "C";
    return [g.normal(), `code-${cls}`, cls];
  });
  const classification = runModel(makeTable(["noise", "code", "y"], labelled), { ...base, task: "classification", features: ["noise", "code"] });
  assert.ok(classification.warnings.some((warning) => /"code" predicts the target almost perfectly/.test(warning)));
});

test("honest caveats: tiny samples, imbalance, and rows skipped for missing targets", () => {
  const rows = Array.from({ length: 12 }, (_, index) => [index, index % 2, index < 11 ? "no" : "yes"]);
  rows.push([13, 1, ""]);
  const report = runModel(makeTable(["a", "b", "y"], rows), { ...base, task: "classification", split: "random" });
  const text = report.warnings.join(" | ");
  assert.match(text, /Only 12 usable rows/);
  assert.match(text, /Skipped 1 row with no target/);
  assert.match(text, /most common class is 92%/);
  assert.equal(report.rows.droppedMissingTarget, 1);
});

test("large tables are sampled with a seed and still finish quickly", () => {
  const g = lcg(50);
  const rows = Array.from({ length: MAX_MODEL_ROWS + 5000 }, () => {
    const a = g.normal();
    return [a, g.normal(), a * 2 + g.normal()];
  });
  const started = performance.now();
  const report = runModel(makeTable(["a", "b", "y"], rows), { ...base, folds: 3 });
  const seconds = (performance.now() - started) / 1000;
  assert.equal(report.rows.used, MAX_MODEL_ROWS);
  assert.equal(report.rows.sampledFrom, MAX_MODEL_ROWS + 5000);
  assert.ok(report.warnings.some((warning) => /seeded sample/.test(warning)));
  assert.ok(seconds < 20, `took ${seconds.toFixed(1)}s`);
});

test("invalid requests fail with specific, actionable messages", () => {
  const g = lcg(60);
  const rows = Array.from({ length: 40 }, () => [g.normal(), g.normal(), g.normal()]);
  const table = makeTable(["a", "b", "y"], rows);
  assert.throws(() => runModel(table, { ...base, target: "nope" }), /target column that exists/);
  assert.throws(() => runModel(table, { ...base, features: ["y"] }), /at least one feature/);
  assert.throws(() => runModel(table, { ...base, testFraction: 0.9 }), /between 10% and 50%/);
  assert.throws(() => runModel(table, { ...base, seed: 1.5 }), /whole number/);
  assert.throws(() => runModel(table, { ...base, folds: 1 }), /cross-validation folds/);
  assert.throws(() => runModel(makeTable(["a", "y"], [[1, "x"], [2, "y"], [3, "z"], [4, "x"], [5, "y"], [6, "z"], [7, "x"], [8, "y"]]), { ...base, features: ["a"] }), /numeric target/);
  assert.throws(() => runModel(makeTable(["a", "y"], [[1, 1], [2, 2]]), { ...base, features: ["a"] }), /At least 8 rows/);
  assert.throws(() => runModel(makeTable(["a", "y"], Array.from({ length: 20 }, (_, i) => [i, "same"])), { ...base, task: "classification", features: ["a"] }), /at least two different/);
  assert.throws(() => runModel(makeTable(["a", "y"], Array.from({ length: 60 }, (_, i) => [i, `c${i}`])), { ...base, task: "classification", features: ["a"] }), /limited to 20 classes/);
  const many = makeTable(["tag", "y"], Array.from({ length: 120 }, (_, i) => [`t${i}`, i]));
  assert.throws(() => runModel(many, { ...base, features: ["tag"] }), /too many to encode/);
  const constant = makeTable(["a", "y"], Array.from({ length: 20 }, (_, i) => [5, i]));
  assert.throws(() => runModel(constant, { ...base, features: ["a"] }), /do not vary/);
  const sorted = makeTable(["a", "y"], [...Array(15).fill(0), ...Array(15).fill(1)].map((v, i) => [i, v ? "late" : "early"]));
  // A 20% holdout still leaves both classes in training; 50% leaves only "early".
  assert.doesNotThrow(() => runModel(sorted, { ...base, task: "classification", features: ["a"], split: "chronological" }));
  assert.throws(() => runModel(sorted, { ...base, task: "classification", features: ["a"], split: "chronological", testFraction: 0.5 }), /single class/);
});

test("task and feature suggestions follow the data", () => {
  const rows = Array.from({ length: 40 }, (_, index) => [index, `id${index}`, index % 2 ? "x" : "y", index * 2.5, "k", index % 3]);
  const table = makeTable(["n", "name", "flag", "price", "const", "tier"], rows);
  assert.equal(suggestTask(table, "price"), "regression");
  assert.equal(suggestTask(table, "flag"), "classification");
  assert.equal(suggestTask(table, "tier"), "classification");
  assert.deepEqual(suggestFeatures(table, "price"), ["n", "flag", "tier"], "identifiers and constants are excluded");
});

test("NO LEAKAGE (end to end): the fitted model cannot depend on held-out feature values", () => {
  const g = lcg(71);
  const rows = Array.from({ length: 80 }, (_, index) => {
    const a = g.normal();
    const b = g.normal();
    return [a, b, 2 * a - b + index * 0.01];
  });
  // Same data, but the features of the last 25% of rows (the chronological test set) are wrecked.
  const wrecked = rows.map((row, index) => (index >= 60 ? [row[0] + 1e6, row[1] * 500, row[2]] : row));
  const config = { ...base, split: "chronological", testFraction: 0.25 };
  const clean = runModel(makeTable(["a", "b", "y"], rows), config);
  const poisoned = runModel(makeTable(["a", "b", "y"], wrecked), config);
  assert.equal(clean.rows.train, 60);
  assert.deepEqual(poisoned.coefficients, clean.coefficients, "coefficients may only depend on training rows");
  const treeClean = runModel(makeTable(["a", "b", "y"], rows), { ...config, model: "tree" });
  const treePoisoned = runModel(makeTable(["a", "b", "y"], wrecked), { ...config, model: "tree" });
  assert.equal(treeClean.rows.train, treePoisoned.rows.train);
  assert.notDeepEqual(treeClean.predictions, treePoisoned.predictions, "sanity: the wrecked features do change test predictions");
});

test("STRATIFICATION (end to end): a rare class appears in the test set in proportion, for every seed", () => {
  const rows = Array.from({ length: 100 }, (_, index) => [index % 17, index % 5, index < 10 ? "rare" : "common"]);
  for (let seed = 1; seed <= 8; seed += 1) {
    const report = runModel(makeTable(["a", "b", "y"], rows), { ...base, task: "classification", seed });
    const rareInTest = report.predictions.filter((entry) => entry.actual === "rare").length;
    assert.equal(rareInTest, 2, `seed ${seed}: 10% of 20 held-out rows`);
    assert.equal(report.rows.test, 20);
  }
});

test("permutation test: strong signal is significant, constant predictions never are, and it is seeded", () => {
  const actual = Array.from({ length: 40 }, (_, index) => index);
  const exact = permutationPValue("regression", actual, actual, 0, createRng(1));
  assert.ok(exact <= 2 / 501, `perfect predictions: p = ${exact}`);
  const constant = permutationPValue("regression", actual, actual.map(() => 19.5), 0, createRng(1));
  assert.equal(constant, 1, "a constant guess is identical under every shuffle");
  const labels = Array.from({ length: 60 }, (_, index) => index % 3);
  assert.ok(permutationPValue("classification", labels, labels, 3, createRng(2)) < 0.01);
  assert.equal(permutationPValue("regression", actual, actual, 0, createRng(9)), permutationPValue("regression", actual, actual, 0, createRng(9)));
  assert.ok(permutationPValue("classification", labels, labels.map((value) => (value + 1) % 3), 3, createRng(3)) > 0.9, "systematically wrong answers are not evidence of skill");
});

test("CALIBRATION: on pure noise the verdict rarely claims skill; on real signal it nearly always does", () => {
  let falsePositives = 0;
  let detections = 0;
  const trials = 150;
  for (let trial = 0; trial < trials; trial += 1) {
    const g = lcg(1000 + trial);
    const noise = Array.from({ length: 60 }, () => [g.normal(), g.normal(), g.normal()]);
    const signal = Array.from({ length: 60 }, () => {
      const a = g.normal();
      return [a, g.normal(), a * 1.5 + g.normal() * 0.7];
    });
    const config = { ...base, seed: trial + 1 };
    if (runModel(makeTable(["a", "b", "y"], noise), config).primary.significant) falsePositives += 1;
    if (runModel(makeTable(["a", "b", "y"], signal), config).primary.significant) detections += 1;
  }
  // A well-calibrated 5% test: expect about 7 of 150; allow generous sampling slack.
  assert.ok(falsePositives / trials <= 0.12, `false-positive rate ${falsePositives}/${trials}`);
  assert.ok(detections / trials >= 0.9, `detection rate ${detections}/${trials}`);
});

test("a lucky small margin is reported as 'could be luck', not as skill", () => {
  const g = lcg(5);
  const rows = Array.from({ length: 150 }, (_, index) => [g.normal(), g.normal(), ["Walk-in", "Mobile", "Online"][Math.floor(g.uniform() * 3)], index]);
  let lucky = null;
  for (let seed = 1; seed <= 40 && lucky === null; seed += 1) {
    const report = runModel(makeTable(["a", "b", "y", "id"], rows), { ...base, task: "classification", features: ["a", "b"], seed });
    if (report.primary.beatsBaseline && !report.primary.significant) lucky = report;
  }
  assert.ok(lucky, "pure-noise runs include some that nominally beat the baseline");
  assert.ok(lucky.primary.pValue >= 0.05);
  assert.ok(lucky.warnings.some((warning) => /could easily be luck/.test(warning)));
});
