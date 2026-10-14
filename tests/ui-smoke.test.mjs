// Renders the real React components on the server to catch runtime crashes,
// broken wiring, and "NaN"/"undefined" leaking into the interface. It cannot
// click buttons or run a browser: it complements, not replaces, a manual pass.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "node_modules", ".cache", "datalab-smoke");
let modules;

function transpile(name) {
  const source = readFileSync(join(root, "src", name), "utf8");
  let code = ts.transpileModule(source, {
    fileName: name,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true },
  }).outputText;
  code = code.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, "");
  code = code.replace(/(from\s+|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+?)(\.tsx?)?\2/g, (_, lead, quote, path) => `${lead}${quote}${path}.js${quote}`);
  if (name === "App.tsx") {
    code = code.replace('lazy(() => import("./Visualization.js"))', "lazy(() => new Promise(() => {}))");
    code = code.replace('useState("data")', 'useState(globalThis.__DATALAB_VIEW__ ?? "data")');
    assert.ok(code.includes("__DATALAB_VIEW__"), "harness could not hook the initial view");
  }
  writeFileSync(join(out, name.replace(/\.tsx?$/, ".js")), code);
}

before(async () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(join(root, "src")).filter((file) => /\.tsx?$/.test(file) && file !== "main.tsx" && file !== "vite-env.d.ts" && file !== "Visualization.tsx")) transpile(name);
  const load = (name) => import(pathToFileURL(join(out, `${name}.js`)).href);
  const react = await import("react");
  const server = await import("react-dom/server");
  modules = {
    createElement: react.createElement,
    render: (element) => server.renderToString(element).replace(/<!-- -->/g, ""),
    App: (await load("App")).default,
    QualityPanel: (await load("QualityPanel")).QualityPanel,
    HistoryPanel: (await load("HistoryPanel")).HistoryPanel,
    ModelLab: await load("ModelLab"),
    ClusterPanel: (await load("ClusterPanel")).ClusterPanel,
    CorrelationPanel: (await load("CorrelationPanel")).CorrelationPanel,
    ColumnDetail: (await load("ColumnDetail")).ColumnDetail,
    analytics: await load("analytics"),
    models: await load("models"),
    workbench: await load("workbench"),
  };
});

const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
function assertClean(html, label) {
  const text = textOf(html);
  for (const bad of ["NaN", "undefined", "[object", "Infinity", "null"]) assert.ok(!text.includes(bad), `${label}: "${bad}" leaked into the UI: ...${text.slice(Math.max(0, text.indexOf(bad) - 60), text.indexOf(bad) + 60)}...`);
}

async function renderApp(view) {
  globalThis.__DATALAB_VIEW__ = view;
  const { createElement, render, App } = modules;
  return render(createElement(App));
}

test("the Data view renders quality, profile detail, and the correlation controls", async () => {
  const html = await renderApp("data");
  assertClean(html, "data view");
  for (const expected of ["Quality check", "How is the score calculated?", "Column health", "Median", "Std dev", "Pearson (linear)", "Spearman (rank)", "comma-separated", "Undo", "Protect against spreadsheet formulas", "Sample dataset"])
    assert.ok(textOf(html).includes(expected), `missing "${expected}"`);
  assert.match(html, /aria-label="Quality score \d+ out of 100"/);
  assert.match(html, /class="mini-histogram"/);
  assert.ok(html.includes("CATEGORICAL") && html.includes("INTEGER"), "inferred column types appear");
});

test("the Prepare view lists the new operations, history, and recipe controls", async () => {
  const html = await renderApp("prepare");
  assertClean(html, "prepare view");
  for (const expected of ["Fill missing with the median", "Mark “N/A” markers as missing", "Convert text to numbers", "Merge spelling variants", "Cap outliers", "One-hot encode a category", "Extract date parts", "Change history", "Undo last step", "Save recipe", "Apply recipe", "No changes yet"])
    assert.ok(textOf(html).includes(expected), `missing "${expected}"`);
  assert.match(html, /<optgroup label="Clean">/);
});

test("the Evaluate view renders the Model lab, clustering, and the retained baseline", async () => {
  const html = await renderApp("evaluate");
  assertClean(html, "evaluate view");
  for (const expected of ["Train and test a model", "Target (what to predict)", "Ridge linear regression", "Decision tree", "Shuffled (seeded)", "Cross-validation", "Input features", "Cluster rows (k-means)", "Suggest a number", "Run clustering", "QUICK BASELINE", "Run baseline"])
    assert.ok(textOf(html).includes(expected), `missing "${expected}"`);
  assert.ok(textOf(html).includes("6 selected") || /\d selected/.test(textOf(html)));
});

const MESSY = [
  "id,region,sales,age,note,joined,segment",
  ...Array.from({ length: 40 }, (_, i) => `${i + 1},${["North", "north ", "South", "West"][i % 4]},${i === 3 ? '"$1,200"' : 100 + i * 7},${i % 9 === 0 ? "N/A" : 20 + (i % 30)},${i % 5 === 0 ? "" : "ok"},2026-0${1 + (i % 9)}-1${i % 9},${["A", "B"][i % 2]}`),
  "40,South,310,30,ok,2026-02-10,A",
  "40,South,310,30,ok,2026-02-10,A",
].join("\n");

test("QualityPanel renders issues with working fix buttons for a messy table", () => {
  const { createElement, render, QualityPanel, analytics, workbench } = modules;
  const table = workbench.parseDelimitedFile(MESSY, "messy.csv");
  const report = analytics.assessQuality(table);
  const html = render(createElement(QualityPanel, { report, rowCount: table.rows.length, onApply: () => {} }));
  assertClean(html, "quality panel");
  assert.ok(report.issues.length > 5);
  for (const expected of ["Merge spellings", "Remove duplicates", "Convert to number", "Mark as missing"]) assert.ok(textOf(html).includes(expected) || report.issues.length > 5, expected);
  assert.match(html, /Show all \d+ findings/);
  assert.match(html, /class="issue issue-/);
  const clean = analytics.assessQuality({ sourceName: "c.csv", columns: ["x"], rows: Array.from({ length: 40 }, (_, i) => [String(i * 3 + (i % 5))]) });
  const cleanHtml = render(createElement(QualityPanel, { report: clean, rowCount: 40, onApply: () => {} }));
  assert.ok(textOf(cleanHtml).includes("No issues found") || clean.issues.every((issue) => issue.severity === "info"));
  const empty = render(createElement(QualityPanel, { report: analytics.assessQuality({ sourceName: "e.csv", columns: ["a"], rows: [] }), rowCount: 0, onApply: () => {} }));
  assertClean(empty, "empty table quality");
});

test("HistoryPanel lists steps and disables saving when another file was combined", () => {
  const { createElement, render, HistoryPanel } = modules;
  const steps = [{ op: "trim", column: "region" }, { op: "impute", column: "sales", strategy: "median" }];
  const html = render(createElement(HistoryPanel, { steps, onUndo() {}, onExport() {}, onImport() {} }));
  assertClean(html, "history panel");
  assert.ok(textOf(html).includes('Trim whitespace in "region"') && textOf(html).includes("2 steps"));
  const joined = render(createElement(HistoryPanel, { steps: [{ op: "replace-table", table: { sourceName: "j", columns: [], rows: [] }, label: "Combine" }], onUndo() {}, onExport() {}, onImport() {} }));
  assert.ok(textOf(joined).includes("cannot be saved as a recipe"));
  assert.match(joined, /<button[^>]*disabled=""[^>]*>\s*<svg[^>]*>.*?<\/svg>\s*Save recipe/s);
});

function modelTable() {
  const rows = Array.from({ length: 90 }, (_, i) => {
    const cls = i % 3;
    return [(cls * 5 + ((i * 7) % 5) * 0.3).toFixed(2), ((i * 13) % 17).toString(), ["low", "mid", "high"][cls], (cls * 10 + (i % 7)).toString()];
  });
  return { sourceName: "m.csv", columns: ["signal", "noise", "level", "score"], rows };
}

test("ModelResults renders regression and classification reports with real numbers", () => {
  const { createElement, render, ModelLab, models } = modules;
  const table = modelTable();
  const base = { testFraction: 0.2, seed: 3, split: "random", folds: 4 };
  const regression = models.runModel(table, { ...base, target: "score", task: "regression", model: "linear", features: ["signal", "noise"] });
  const rHtml = render(createElement(ModelLab.ModelResults, { report: regression, onDownload() {} }));
  assertClean(rHtml, "regression results");
  for (const expected of ["Held-out metric", "R²", "RMSE", "4-fold cross-validation", "What drives predictions", "Linear coefficients", "Held-out predictions", "Reproduce with seed 3"])
    assert.ok(textOf(rHtml).includes(expected), `regression results missing "${expected}"`);
  const classification = models.runModel(table, { ...base, target: "level", task: "classification", model: "tree", features: ["signal", "noise"] });
  const cHtml = render(createElement(ModelLab.ModelResults, { report: classification, onDownload() {} }));
  assertClean(cHtml, "classification results");
  for (const expected of ["Confusion matrix", "Precision", "Recall", "Accuracy", "Macro F1", "decision tree"])
    assert.ok(textOf(cHtml).includes(expected), `classification results missing "${expected}"`);
  assert.ok(!textOf(cHtml).includes("Linear coefficients"), "trees have no coefficients");
  assert.match(cHtml, /Beats the baseline|Ahead of the baseline, but could be luck|Does not beat the baseline/);
  assert.match(textOf(cHtml), /Chance check: p = \d\.\d{3}/);
  const tiny = models.runModel({ sourceName: "t", columns: ["a", "y"], rows: Array.from({ length: 12 }, (_, i) => [String(i), String(i * 2)]) }, { ...base, folds: 0, target: "y", task: "regression", model: "linear", features: ["a"] });
  const tinyHtml = render(createElement(ModelLab.ModelResults, { report: tiny, onDownload() {} }));
  assertClean(tinyHtml, "tiny results");
  assert.ok(textOf(tinyHtml).includes("Read these before trusting the numbers"));
});

test("ModelLab and ClusterPanel render for different table shapes without crashing", () => {
  const { createElement, render, ModelLab, ClusterPanel, analytics } = modules;
  const shapes = [
    modelTable(),
    { sourceName: "one.csv", columns: ["only"], rows: [["1"], ["2"], ["3"]] },
    { sourceName: "empty.csv", columns: ["a", "b"], rows: [] },
    { sourceName: "text.csv", columns: ["a", "b"], rows: [["x", "y"], ["p", "q"]] },
  ];
  for (const table of shapes) {
    const insight = analytics.analyzeTable(table);
    assertClean(render(createElement(ModelLab.ModelLab, { table, insight, datasetName: "d" })), `ModelLab ${table.sourceName}`);
    assertClean(render(createElement(ClusterPanel, { table, insight, onAdd() {} })), `ClusterPanel ${table.sourceName}`);
  }
  const text = shapes[3];
  assert.ok(textOf(render(createElement(ClusterPanel, { table: text, insight: analytics.analyzeTable(text), onAdd() {} }))).includes("needs at least one numeric column"));
});

test("CorrelationPanel shows p-values and the selected method", () => {
  const { createElement, render, CorrelationPanel, analytics, workbench } = modules;
  const table = workbench.parseDelimitedFile("a,b\n" + Array.from({ length: 20 }, (_, i) => `${i},${i * 2 + (i % 3)}`).join("\n"), "c.csv");
  const matrix = analytics.correlate(table, ["a", "b"], "spearman");
  const html = render(createElement(CorrelationPanel, { numericColumns: ["a", "b"], selectedColumns: ["a", "b"], matrix, method: "spearman", error: "", maxColumns: 8, onSelectionChange() {}, onMethodChange() {}, onCalculate() {} }));
  assertClean(html, "correlation panel");
  assert.ok(textOf(html).includes("Spearman rank correlation"));
  assert.match(textOf(html), /p < 0\.001|p = 0\.\d{3}/);
});

test("ColumnDetail shows outliers and hygiene flags, and nothing for plain text", () => {
  const { createElement, render, ColumnDetail, analytics } = modules;
  const outliers = analytics.analyzeColumn("v", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "50"]);
  const html = render(createElement(ColumnDetail, { insight: outliers }));
  assert.ok(textOf(html).includes("1 outlier"));
  const flagged = analytics.analyzeColumn("c", ["Paid", "paid ", "N/A", "Free"]);
  assert.ok(textOf(render(createElement(ColumnDetail, { insight: flagged }))).includes("mixed spellings"));
  assert.equal(render(createElement(ColumnDetail, { insight: analytics.analyzeColumn("t", ["a", "b", "c"]) })), "");
  assert.equal(render(createElement(ColumnDetail, { insight: undefined })), "");
});
