import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTable, assessQuality } from "../src/analytics.ts";
import { scanClusterCounts } from "../src/clustering.ts";
import { runModel, suggestFeatures, suggestTask } from "../src/models.ts";
import { applyStep, exportRecipe, parseRecipe, replayRecipe } from "../src/recipe.ts";
import { parseDelimitedFile, serializeCsv } from "../src/workbench.ts";
import { buildMessyCsv } from "./journey-data.mjs";

// The same sequence of calls the interface makes when someone cleans, models,
// and exports a messy file. State is threaded through the tests in order.
const state = {};

function cleanUntilStable(table) {
  const steps = [];
  for (let round = 0; round < 8; round += 1) {
    const todo = assessQuality(table).issues.filter((issue) => issue.fix && issue.severity !== "info");
    if (todo.length === 0) break;
    for (const target of todo) {
      const current = assessQuality(table).issues.find((issue) => issue.id === target.id);
      if (!current) continue;
      table = applyStep(table, current.fix);
      steps.push(current.fix);
    }
  }
  return { table, steps };
}

test("JOURNEY 1: a semicolon export imports as 8 columns (it used to be one)", () => {
  state.source = parseDelimitedFile(buildMessyCsv(), "retail-export.csv");
  assert.equal(state.source.delimiter, ";");
  assert.equal(state.source.columns.length, 8);
  assert.equal(state.source.rows.length, 155);
});

test("JOURNEY 2: the quality check finds every planted problem", () => {
  state.initial = assessQuality(state.source);
  const ids = state.initial.issues.map((issue) => issue.id);
  for (const planted of ["case:region", "space:region", "loose:discount", "tokens:amount", "missing:customer_age", "duplicates", "identifier:order_id", "date:order_date"])
    assert.ok(ids.includes(planted), `planted problem not found: ${planted} (found ${ids.join(", ")})`);
  assert.ok(state.initial.score < 100);
});

test("JOURNEY 3: suggested fixes converge to a clean, correctly typed table", () => {
  const { table, steps } = cleanUntilStable(state.source);
  state.table = table;
  state.steps = steps;
  const final = assessQuality(table);
  assert.equal(table.rows.length, 150, "5 duplicates removed");
  assert.ok(final.score >= 95 && final.score > state.initial.score, `${state.initial.score} -> ${final.score}`);
  assert.equal(final.issues.filter((issue) => issue.fix && issue.severity !== "info").length, 0);
  const insight = Object.fromEntries(analyzeTable(table).columns.map((column) => [column.name, column]));
  assert.equal(insight.amount.type, "numeric", "TSh amounts and N/A markers became numbers");
  assert.equal(insight.region.unique, 4, "mixed-case spellings merged into 4 regions");
  assert.ok(insight.discount.stats.max <= 0.15 && insight.discount.stats.min >= 0, "10% became 0.1");
  assert.equal(insight.order_date.type, "date");
  assert.equal(insight.amount.missing + insight.region.missing, 0);
});

test("JOURNEY 4: a model beats the baseline for the right reason, and says so with evidence", () => {
  assert.equal(suggestTask(state.table, "amount"), "regression");
  const features = suggestFeatures(state.table, "amount");
  assert.ok(!features.includes("order_id") && !features.includes("order_date"), "identifiers and dates are excluded by default");
  const config = { target: "amount", task: "regression", features, testFraction: 0.2, seed: 42, split: "random", folds: 5 };
  const linear = runModel(state.table, { ...config, model: "linear" });
  assert.ok(linear.primary.model > 0.8, `R² ${linear.primary.model}`);
  assert.ok(linear.primary.significant && linear.primary.pValue < 0.01);
  assert.equal(linear.importance[0].feature, "units", "the planted driver is found");
  assert.equal(linear.crossValidation.folds, 5);
  const tree = runModel(state.table, { ...config, model: "tree" });
  assert.ok(tree.primary.beatsBaseline);
});

test("JOURNEY 5: predicting pure noise is not reported as skill", () => {
  let significant = 0;
  for (let seed = 1; seed <= 10; seed += 1) {
    const report = runModel(state.table, { target: "channel", task: "classification", model: "linear", features: suggestFeatures(state.table, "channel"), testFraction: 0.2, seed, split: "random", folds: 0 });
    if (report.primary.significant) significant += 1;
  }
  assert.ok(significant <= 2, `${significant}/10 noise runs claimed significance`);
});

test("JOURNEY 6: clustering, recipe export, and exact replay from the original file", () => {
  const scan = scanClusterCounts(state.table, ["amount", "units", "customer_age"], 42, 2, 5);
  assert.ok(scan.suggested >= 2 && scan.points.every((point) => Number.isFinite(point.inertia)));
  const clusterStep = { op: "cluster", columns: ["amount", "units"], k: 3, seed: 42 };
  const withClusters = applyStep(state.table, clusterStep);
  const steps = [...state.steps, clusterStep];
  assert.equal(withClusters.columns.at(-1), "cluster");
  const recipe = exportRecipe(steps, state.source.sourceName);
  const replayed = replayRecipe(state.source, parseRecipe(recipe));
  assert.deepEqual(replayed, withClusters, "the saved recipe reproduces every cell");
  state.final = withClusters;
  state.allSteps = steps;
  state.recipe = recipe;
});

test("JOURNEY 7: every undo state is reachable and the recipe transfers to a new file", () => {
  for (let count = state.allSteps.length; count >= 0; count -= 1)
    assert.doesNotThrow(() => replayRecipe(state.source, state.allSteps.slice(0, count)), `undo to ${count} steps`);
  assert.deepEqual(replayRecipe(state.source, []), state.source);
  const nextMonth = parseDelimitedFile(buildMessyCsv(90), "next-month.csv");
  const transferred = replayRecipe(nextMonth, parseRecipe(state.recipe));
  assert.equal(transferred.columns.join("|"), state.final.columns.join("|"));
  assert.ok(transferred.rows.length > 80);
});

test("JOURNEY 8: export is formula-safe and the file re-imports to the same data", () => {
  const exported = serializeCsv(state.final);
  const roundTrip = parseDelimitedFile(exported, "prepared.csv");
  assert.deepEqual(roundTrip.rows, state.final.rows);
  assert.deepEqual(roundTrip.columns, state.final.columns);
  const hostile = { ...state.final, rows: state.final.rows.map((row, index) => (index === 0 ? row.map((value, column) => (column === 1 ? '=cmd|" /C calc"!A0' : value)) : row)) };
  const line = serializeCsv(hostile).split("\r\n")[1];
  assert.ok(line.includes(`"'=cmd`), "formula neutralized on export");
});
