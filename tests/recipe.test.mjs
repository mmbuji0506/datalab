import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RECIPE_STEPS,
  applyStep,
  describeStep,
  exportRecipe,
  needsExternalData,
  parseRecipe,
  replayRecipe,
} from "../src/recipe.ts";
import { parseDelimitedFile } from "../src/workbench.ts";

const CSV = [
  "id,region,sales,joined,note",
  "1,North,100,2026-01-05,ok",
  "2,north ,$1200,2026-01-06,N/A",
  "3,South,300,2026-02-07,ok",
  "4,South,,2026-02-08,ok",
  "4,South,,2026-02-08,ok",
  "5,South,900000,2026-02-09,ok",
].join("\n");
const source = () => parseDelimitedFile(CSV, "raw.csv");

const SAMPLE_STEPS = [
  { op: "deduplicate" },
  { op: "trim", column: "region" },
  { op: "harmonize-categories", column: "region" },
  { op: "standardize-missing", column: "note" },
  { op: "convert-number", column: "sales" },
  { op: "impute", column: "sales", strategy: "median" },
  { op: "outliers", column: "sales", method: "cap", multiplier: 1.5 },
  { op: "date-parts", column: "joined" },
  { op: "one-hot", column: "region" },
  { op: "normalize", column: "sales", method: "min-max" },
  { op: "rename", column: "note", to: "remark" },
  { op: "remove-column", column: "joined" },
  { op: "filter", column: "id", operator: "greater", value: "1" },
  { op: "fill", column: "remark", value: "none" },
  { op: "drop-missing", columns: ["sales"] },
];

test("a multi-step recipe runs end to end and each step does what it says", () => {
  const result = replayRecipe(source(), SAMPLE_STEPS);
  assert.deepEqual(result.columns, [
    "id", "sales", "remark", "joined (year)", "joined (month)", "joined (day)", "joined (weekday)", "region=South", "region=North",
  ]);
  assert.equal(result.rows.length, 4, "duplicate removed, then id 1 filtered out");
  assert.ok(result.rows.every((row) => row[result.columns.indexOf("remark")] !== ""), "fill left no blank remarks");
  const sales = result.rows.map((row) => Number(row[result.columns.indexOf("sales")]));
  assert.ok(Math.min(...sales) >= 0 && Math.max(...sales) <= 1, "min-max scaled after capping the 900000 outlier");
  assert.equal(source().rows.length, 6, "the source table is never mutated");
});

test("UNDO: replaying all-but-the-last step equals the state before that step", () => {
  let table = source();
  const snapshots = [table];
  for (const step of SAMPLE_STEPS) {
    table = applyStep(table, step);
    snapshots.push(table);
  }
  for (let count = 0; count <= SAMPLE_STEPS.length; count += 1)
    assert.deepEqual(replayRecipe(source(), SAMPLE_STEPS.slice(0, count)), snapshots[count], `after ${count} steps`);
});

test("replay is deterministic: the same recipe on the same data gives identical output", () => {
  assert.deepEqual(replayRecipe(source(), SAMPLE_STEPS), replayRecipe(source(), SAMPLE_STEPS));
});

test("a failing step is reported with its position and description", () => {
  const steps = [{ op: "trim", column: "region" }, { op: "impute", column: "region", strategy: "mean" }];
  assert.throws(() => replayRecipe(source(), steps), /Step 2 \(Fill missing "region" with the mean\): Mean and median fills need a numeric column/);
  assert.throws(() => replayRecipe(source(), [{ op: "remove-column", column: "ghost" }]), /Step 1 .*column that exists/);
});

test("a table from an append or join is replayed from memory and blocks file export", () => {
  const joined = { sourceName: "joined.csv", columns: ["a"], rows: [["1"], ["2"]] };
  const steps = [{ op: "replace-table", table: joined, label: "Join with other.csv" }, { op: "rename", column: "a", to: "b" }];
  assert.deepEqual(replayRecipe(source(), steps).columns, ["b"]);
  assert.equal(needsExternalData(steps), true);
  assert.throws(() => exportRecipe(steps, "raw.csv"), /combines another file/);
  assert.equal(needsExternalData(SAMPLE_STEPS), false);
  assert.equal(describeStep(steps[0]), "Join with other.csv");
});

test("export then import round-trips exactly, and the replayed result is identical", () => {
  const json = exportRecipe(SAMPLE_STEPS, "raw.csv");
  const parsed = parseRecipe(json);
  assert.deepEqual(parsed, SAMPLE_STEPS);
  assert.deepEqual(replayRecipe(source(), parsed), replayRecipe(source(), SAMPLE_STEPS));
  const header = JSON.parse(json);
  assert.equal(header.format, "datalab-recipe");
  assert.equal(header.createdFrom, "raw.csv");
});

test("every step has a human-readable description", () => {
  for (const step of SAMPLE_STEPS) {
    const text = describeStep(step);
    assert.ok(text.length > 8 && !text.includes("undefined"), text);
  }
  assert.match(describeStep({ op: "filter", column: "x", operator: "empty", value: "" }), /is empty$/);
});

const wrap = (steps, extra = {}) => JSON.stringify({ format: "datalab-recipe", version: 1, steps, ...extra });

test("HOSTILE INPUT: malformed recipe files are rejected with clear messages", () => {
  assert.throws(() => parseRecipe("not json"), /not valid JSON/);
  assert.throws(() => parseRecipe("[]"), /not a DataLab recipe/);
  assert.throws(() => parseRecipe(JSON.stringify({ format: "other", version: 1, steps: [] })), /not a DataLab recipe/);
  assert.throws(() => parseRecipe(JSON.stringify({ format: "datalab-recipe", version: 2, steps: [] })), /Unsupported recipe version 2/);
  assert.throws(() => parseRecipe(JSON.stringify({ format: "datalab-recipe", version: 1 })), /no steps list/);
  assert.throws(() => parseRecipe(wrap([{ op: "format-disk" }])), /Recipe step 1: Unknown operation "format-disk"/);
  assert.throws(() => parseRecipe(wrap([{ op: "replace-table", table: {}, label: "x" }])), /Unknown operation "replace-table"/);
  assert.throws(() => parseRecipe(wrap(["trim"])), /must be an object/);
  assert.throws(() => parseRecipe(wrap([{ op: "trim" }])), /"column" must be text/);
  assert.throws(() => parseRecipe(wrap([{ op: "trim", column: 5 }])), /"column" must be text/);
  assert.throws(() => parseRecipe(wrap([{ op: "impute", column: "a", strategy: "delete" }])), /"strategy" has an unsupported value/);
  assert.throws(() => parseRecipe(wrap([{ op: "filter", column: "a", operator: "regex", value: "." }])), /"operator" has an unsupported value/);
  assert.throws(() => parseRecipe(wrap([{ op: "drop-missing", columns: [1] }])), /list of names/);
  assert.throws(() => parseRecipe(wrap([{ op: "outliers", column: "a", method: "cap", multiplier: -1 }])), /positive number/);
  assert.throws(() => parseRecipe(wrap([{ op: "outliers", column: "a", method: "cap", multiplier: "2" }])), /positive number/);
  assert.throws(() => parseRecipe(wrap([{ op: "one-hot", column: "a", maxCategories: 0 }])), /positive number/);
  assert.throws(() => parseRecipe(wrap(Array(MAX_RECIPE_STEPS + 1).fill({ op: "deduplicate" }))), /limited to 200 steps/);
  assert.throws(() => parseRecipe(wrap([], { padding: "x".repeat(1024 * 1024) })), /too large/);
  assert.throws(() => parseRecipe(wrap([{ op: "trim", column: "a" }, { op: "bogus" }])), /Recipe step 2/);
});

test("HOSTILE INPUT: unknown fields and prototype-pollution keys are never copied", () => {
  const polluted = '{"format":"datalab-recipe","version":1,"steps":[{"op":"trim","column":"a","__proto__":{"admin":true},"constructor":{"x":1},"extra":"evil"}]}';
  const [step] = parseRecipe(polluted);
  assert.deepEqual(step, { op: "trim", column: "a" });
  assert.equal({}.admin, undefined, "Object.prototype was not polluted");
  assert.deepEqual(Object.keys(step), ["op", "column"]);
});

test("a recipe from one file applies to another file with the same columns, and fails clearly otherwise", () => {
  const steps = parseRecipe(exportRecipe([{ op: "trim", column: "region" }, { op: "deduplicate" }], "raw.csv"));
  const other = parseDelimitedFile("id,region\n1,a \n1,a \n2,b", "next-month.csv");
  assert.deepEqual(replayRecipe(other, steps).rows, [["1", "a"], ["2", "b"]]);
  const different = parseDelimitedFile("x,y\n1,2", "other.csv");
  assert.throws(() => replayRecipe(different, steps), /Step 1 .*column that exists/);
});

test("the cluster step is reproducible, round-trips through a recipe file, and validates input", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `${index},${index < 20 ? 1 + (index % 3) : 50 + (index % 4)},${index < 20 ? 2 : 60}`);
  const table = parseDelimitedFile(["id,a,b", ...rows].join("\n"), "c.csv");
  const step = { op: "cluster", columns: ["a", "b"], k: 2, seed: 7 };
  const first = replayRecipe(table, [step]);
  assert.deepEqual(first, replayRecipe(table, [step]), "same seed, same groups");
  assert.equal(first.columns.at(-1), "cluster");
  const labels = first.rows.map((row) => row.at(-1));
  assert.deepEqual([...new Set(labels.slice(0, 20))].length, 1, "the first 20 rows share a cluster");
  assert.notEqual(labels[0], labels[39]);
  assert.deepEqual(parseRecipe(exportRecipe([step], "c.csv")), [step]);
  assert.match(describeStep(step), /Group rows into 2 clusters using "a", "b" \(seed 7\)/);
  for (const bad of [
    { op: "cluster", columns: [], k: 2, seed: 1 },
    { op: "cluster", columns: ["a"], k: 1, seed: 1 },
    { op: "cluster", columns: ["a"], k: 2.5, seed: 1 },
    { op: "cluster", columns: ["a"], k: 2, seed: "1" },
    { op: "cluster", columns: [1], k: 2, seed: 1 },
    { op: "cluster", columns: Array(21).fill("a"), k: 2, seed: 1 },
  ])
    assert.throws(() => parseRecipe(wrap([bad])), /Recipe step 1/);
});
