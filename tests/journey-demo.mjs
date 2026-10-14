// Narrated walkthrough: drives the engine the same way the UI does, step by step.
// Run with: npm run journey
import { analyzeTable, assessQuality, correlate } from "../src/analytics.ts";
import { scanClusterCounts } from "../src/clustering.ts";
import { runModel, suggestFeatures, suggestTask } from "../src/models.ts";
import { applyStep, describeStep, exportRecipe, parseRecipe, replayRecipe } from "../src/recipe.ts";
import { parseDelimitedFile, profileTable, serializeCsv } from "../src/workbench.ts";
import { buildMessyCsv } from "./journey-data.mjs";

const line = (text = "") => console.log(text);
const heading = (text) => line(`\n=== ${text} ===`);
const pct = (value) => `${(value * 100).toFixed(1)}%`;

heading("1. Import a semicolon-delimited export");
const source = parseDelimitedFile(buildMessyCsv(), "retail-export.csv");
line(`rows: ${source.rows.length}  columns: ${source.columns.length}  detected delimiter: "${source.delimiter}"`);
line(`columns: ${source.columns.join(", ")}`);
line(`(before the fix, this file parsed as ONE column)`);

heading("2. Quality check");
let report = assessQuality(source);
line(`score ${report.score}/100  ${JSON.stringify(report.components)}`);
for (const issue of report.issues) line(`  [${issue.severity.padEnd(6)}] ${issue.title}${issue.fixLabel ? `  -> ${issue.fixLabel}` : ""}`);

heading("3. Apply suggested fixes round by round");
let table = source;
const steps = [];
for (let round = 1; round <= 6; round += 1) {
  const todo = assessQuality(table).issues.filter((issue) => issue.fix && issue.severity !== "info");
  if (!todo.length) { line(`round ${round}: nothing left to fix`); break; }
  line(`round ${round}: ${todo.length} fixable`);
  for (const target of todo) {
    const current = assessQuality(table).issues.find((issue) => issue.id === target.id);
    if (!current) continue;
    table = applyStep(table, current.fix);
    steps.push(current.fix);
    line(`   applied: ${describeStep(current.fix)}`);
  }
}
report = assessQuality(table);
line(`score after cleaning: ${report.score}/100  rows: ${table.rows.length}`);
const insight = analyzeTable(table);
line("column types: " + insight.columns.map((column) => `${column.name}=${column.type}`).join(", "));

heading("4. Correlations (Pearson vs Spearman)");
for (const method of ["pearson", "spearman"]) {
  const result = correlate(table, ["amount", "units", "discount"], method);
  line(`${method}: amount~units r=${result.values[0][1].toFixed(3)} (p=${result.pValues[0][1] < 0.001 ? "<0.001" : result.pValues[0][1].toFixed(3)})  amount~discount r=${result.values[0][2].toFixed(3)}`);
}

heading("5. Model lab: predict amount");
line(`suggested task: ${suggestTask(table, "amount")}; suggested features: ${suggestFeatures(table, "amount").join(", ")}`);
for (const model of ["linear", "tree"]) {
  const result = runModel(table, { target: "amount", task: "regression", model, features: suggestFeatures(table, "amount"), testFraction: 0.2, seed: 42, split: "random", folds: 5 });
  line(`${model.padEnd(6)} R² ${result.primary.model.toFixed(3)} vs baseline ${result.primary.baseline.toFixed(3)}  | CV ${result.crossValidation.model.mean.toFixed(3)} ± ${result.crossValidation.model.std.toFixed(3)}  | top driver: ${result.importance[0].feature}`);
  for (const warning of result.warnings) line(`   warning: ${warning}`);
}
const channel = runModel(table, { target: "channel", task: "classification", model: "linear", features: suggestFeatures(table, "channel"), testFraction: 0.2, seed: 42, split: "random", folds: 5 });
line(`channel (pure noise by construction): accuracy ${pct(channel.primary.model)} vs baseline ${pct(channel.primary.baseline)} -> beats baseline? ${channel.primary.beatsBaseline}`);

heading("6. Clustering");
const scan = scanClusterCounts(table, ["amount", "units", "customer_age"], 42, 2, 6);
line("silhouette by k: " + scan.points.map((point) => `${point.k}:${point.silhouette?.toFixed(3)}`).join("  ") + `  suggested k=${scan.suggested}`);
const clusterStep = { op: "cluster", columns: ["amount", "units"], k: 3, seed: 42 };
table = applyStep(table, clusterStep);
steps.push(clusterStep);
line(`added column "${table.columns.at(-1)}"; sizes: ` + ["Cluster 1", "Cluster 2", "Cluster 3"].map((name) => table.rows.filter((row) => row.at(-1) === name).length).join(" / "));

heading("7. Reproducibility");
const recipe = exportRecipe(steps, source.sourceName);
const restored = parseRecipe(recipe);
const replayed = replayRecipe(source, restored);
line(`recipe: ${steps.length} steps, ${recipe.length} bytes of JSON`);
line(`replaying the saved recipe on the original file reproduces the table exactly: ${JSON.stringify(replayed) === JSON.stringify(table)}`);
let undone = true;
for (let count = steps.length; count >= 0; count -= 1) { /* each prefix replays without error */ replayRecipe(source, steps.slice(0, count)); }
line(`all ${steps.length + 1} undo states replay cleanly: ${undone}`);

heading("8. Safe export");
const risky = { ...table, rows: table.rows.map((row, index) => (index === 0 ? row.map((value, column) => (column === 1 ? "=HYPERLINK(\"http://x\")" : value)) : row)) };
line("first data row of export: " + serializeCsv(risky).split("\r\n")[1].slice(0, 70));
line(`profile still consistent: ${profileTable(table).rowCount} rows`);
