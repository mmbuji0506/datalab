import { performance } from "node:perf_hooks";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  aggregateBy,
  appendTables,
  correlationMatrix,
  dropDuplicateRows,
  dropRowsWithMissingValues,
  evaluateBaseline,
  fillMissing,
  filterRows,
  joinTables,
  normalizeNumericColumn,
  parseDelimitedFile,
  profileTable,
  removeColumn,
  renameColumn,
  serializeCsv,
  trimTextColumn,
} from "../src/workbench.ts";
import {
  analyzeTable,
  assessQuality,
  correlate,
  imputeColumn,
  oneHotEncode,
  treatOutliers,
} from "../src/analytics.ts";
import { kmeans, scanClusterCounts } from "../src/clustering.ts";
import { runModel } from "../src/models.ts";
import { replayRecipe } from "../src/recipe.ts";

const headers = ["id", "week", "region", "sessions", "orders", "revenue"];
const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, index) => {
  const sessions = index % 997 === 0 ? "" : String(500 + ((index * 37) % 5000));
  const orders = String(10 + ((index * 13) % 240));
  const revenue = String(Number(orders) * (15 + (index % 40)));
  return [
    String(index + 1),
    `2026-W${String((Math.floor(index / 7) % 52) + 1).padStart(2, "0")}`,
    `Region-${String(index % 20).padStart(2, "0")}`,
    sessions,
    orders,
    revenue,
  ].join(",");
});
const contents = [headers.join(","), ...rows].join("\n");
const fixtureBytes = Buffer.byteLength(contents);

if (fixtureBytes > MAX_IMPORT_BYTES) {
  throw new Error(
    `Benchmark fixture is ${fixtureBytes} bytes, above the ${MAX_IMPORT_BYTES}-byte import ceiling.`,
  );
}

function measure(operation, iterations = 5) {
  operation();
  const samples = [];
  let result;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    result = operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    result,
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(1)),
    iterations,
  };
}

const parsed = measure(() => parseDelimitedFile(contents, "benchmark.csv"));
const profiled = measure(() => profileTable(parsed.result));
const filtered = measure(() =>
  filterRows(parsed.result, "region", "equals", "Region-03"),
);
const aggregated = measure(() =>
  aggregateBy(parsed.result, "region", "revenue", "sum"),
);
const highCardinality = measure(() =>
  aggregateBy(parsed.result, "id", "revenue", "sum"),
);
const exported = measure(() => serializeCsv(filtered.result));
const prepared = measure(() =>
  removeColumn(
    renameColumn(fillMissing(parsed.result, "sessions", "0"), "week", "period"),
    "id",
  ),
);
const regression = measure(() =>
  evaluateBaseline(parsed.result, "revenue", "regression"),
);
const cleanDuplicates = measure(() => dropDuplicateRows(parsed.result));
const cleanNullRows = measure(() =>
  dropRowsWithMissingValues(parsed.result, ["sessions", "orders"]),
);
const normalized = measure(() =>
  normalizeNumericColumn(
    fillMissing(parsed.result, "sessions", "0"),
    "sessions",
    "min-max",
  ),
);
const correlations = measure(() =>
  correlationMatrix(parsed.result, ["sessions", "orders", "revenue"]),
);
const lookup = {
  sourceName: "region-lookup.csv",
  columns: ["region", "manager"],
  rows: Array.from({ length: 20 }, (_, index) => [
    `Region-${String(index).padStart(2, "0")}`,
    `Manager-${index + 1}`,
  ]),
};
const joined = measure(() =>
  joinTables(parsed.result, lookup, "region", "region", "left"),
);
const firstHalf = {
  ...parsed.result,
  sourceName: "first-half.csv",
  rows: parsed.result.rows.slice(0, MAX_IMPORT_ROWS / 2),
};
const secondHalf = {
  ...parsed.result,
  sourceName: "second-half.csv",
  rows: parsed.result.rows.slice(MAX_IMPORT_ROWS / 2),
};
const appended = measure(() => appendTables(firstHalf, secondHalf));

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const dirtyHeaders = ["record_id", "region", "class", "amount", "note"];
const dirtyRows = Array.from({ length: 20_000 }, (_, index) => {
  const sourceIndex = index % 200 === 199 ? index - 1 : index;
  const region = ["Nord, coast", "South", "East", "West"][sourceIndex % 4];
  const label = sourceIndex % 3 === 0 ? "positive" : "negative";
  const amount =
    sourceIndex % 13 === 0 ? "" : String((sourceIndex * 19) % 10_000);
  const note =
    sourceIndex % 53 === 0 ? 'quoted, "review"\nsecond line' : "standard";
  return [sourceIndex % 19_500, region, label, amount, note]
    .map(quote)
    .join(",");
});
const dirtyContents = [dirtyHeaders.map(quote).join(","), ...dirtyRows].join(
  "\r\n",
);
const dirtyBytes = Buffer.byteLength(dirtyContents);
if (dirtyBytes > MAX_IMPORT_BYTES)
  throw new Error("Dirty fixture exceeds the supported import byte ceiling.");
const dirtyParsed = measure(() =>
  parseDelimitedFile(dirtyContents, "dirty-mixed.csv"),
);
const dirtyProfile = measure(() => profileTable(dirtyParsed.result));
const dirtyFilled = fillMissing(dirtyParsed.result, "amount", "0");
const dirtyPrepared = measure(() =>
  filterRows(dirtyFilled, "region", "contains", "o"),
);
const dirtyTrimmed = measure(() =>
  trimTextColumn(dirtyParsed.result, "region"),
);
const dirtyDeduplicated = measure(() => dropDuplicateRows(dirtyParsed.result));
const dirtyNullsDropped = measure(() =>
  dropRowsWithMissingValues(dirtyParsed.result, ["amount"]),
);
const dirtyNormalized = measure(() =>
  normalizeNumericColumn(dirtyFilled, "amount", "z-score"),
);
const dirtyCorrelation = measure(() =>
  correlationMatrix(dirtyFilled, ["record_id", "amount"]),
);
const dirtyClassification = measure(() =>
  evaluateBaseline(dirtyParsed.result, "class", "classification"),
);

const wideHeaders = Array.from(
  { length: MAX_IMPORT_COLUMNS },
  (_, index) => `feature_${index + 1}`,
);
const wideRows = Array.from({ length: 2_500 }, (_, rowIndex) =>
  wideHeaders
    .map((_, columnIndex) => String((rowIndex * (columnIndex + 3)) % 100_003))
    .join(","),
);
const wideContents = [wideHeaders.join(","), ...wideRows].join("\n");
const wideBytes = Buffer.byteLength(wideContents);
if (wideBytes > MAX_IMPORT_BYTES)
  throw new Error("Wide fixture exceeds the supported import byte ceiling.");
const wideParsed = measure(() =>
  parseDelimitedFile(wideContents, "wide-100-columns.csv"),
);
const wideProfile = measure(() => profileTable(wideParsed.result));

// --- Analytics, recipe replay, models, and clustering at the same 50,000-row scale ---
const analyzed = measure(() => analyzeTable(parsed.result), 3);
const assessed = measure(() => assessQuality(parsed.result, analyzed.result), 3);
const wideAnalyzed = measure(() => analyzeTable(wideParsed.result), 3);
const spearman = measure(() => correlate(parsed.result, ["sessions", "orders", "revenue"], "spearman"), 3);
const imputed = measure(() => imputeColumn(parsed.result, "sessions", "median"), 3);
const outlierCapped = measure(() => treatOutliers(parsed.result, "revenue", "cap"), 3);
const oneHot = measure(() => oneHotEncode(parsed.result, "region"), 3);
const replaySteps = [
  { op: "impute", column: "sessions", strategy: "median" },
  { op: "outliers", column: "revenue", method: "cap" },
  { op: "normalize", column: "orders", method: "z-score" },
  { op: "one-hot", column: "region" },
  { op: "remove-column", column: "week" },
];
const replayed = measure(() => replayRecipe(parsed.result, replaySteps), 3);
const modelRows = parsed.result.rows.map((row) => [row[3] === "" ? "0" : row[3], row[4], row[2], row[5]]);
const modelTable = { sourceName: "model.csv", columns: ["sessions", "orders", "region", "revenue"], rows: modelRows };
const baseConfig = { testFraction: 0.2, seed: 42, split: "random", folds: 0 };
const ridgeRun = measure(() => runModel(modelTable, { ...baseConfig, target: "revenue", task: "regression", model: "linear", features: ["sessions", "orders", "region"] }), 1);
const ridgeCvRun = measure(() => runModel(modelTable, { ...baseConfig, folds: 5, target: "revenue", task: "regression", model: "linear", features: ["sessions", "orders", "region"] }), 1);
const treeRun = measure(() => runModel(modelTable, { ...baseConfig, target: "revenue", task: "regression", model: "tree", features: ["sessions", "orders", "region"] }), 1);
const classTable = { sourceName: "class.csv", columns: ["sessions", "orders", "region", "tier"], rows: modelRows.map((row) => [row[0], row[1], row[2], Number(row[3]) > 3000 ? "high" : Number(row[3]) > 1500 ? "mid" : "low"]) };
const logisticRun = measure(() => runModel(classTable, { ...baseConfig, target: "tier", task: "classification", model: "linear", features: ["sessions", "orders", "region"] }), 1);
const kmeansRun = measure(() => kmeans(modelTable, ["sessions", "orders", "revenue"], 4, 42), 1);
const scanRun = measure(() => scanClusterCounts(modelTable, ["sessions", "orders", "revenue"], 42), 1);

console.log(
  JSON.stringify(
    {
      fixture: {
        rows: parsed.result.rows.length,
        columns: parsed.result.columns.length,
        joinedRows: joined.result.rows.length,
        appendedRows: appended.result.rows.length,
        bytes: fixtureBytes,
        limitBytes: MAX_IMPORT_BYTES,
        rowLimit: MAX_IMPORT_ROWS,
      },
      dirtyFixture: {
        rows: dirtyParsed.result.rows.length,
        columns: dirtyParsed.result.columns.length,
        bytes: dirtyBytes,
        duplicateRows: dirtyProfile.result.duplicateRows,
        missingAmountCells: dirtyProfile.result.columns.find(
          (column) => column.name === "amount",
        ).missing,
        processedRows: dirtyPrepared.result.rows.length,
        rowsAfterDeduplication: dirtyDeduplicated.result.rows.length,
        rowsAfterDroppingMissing: dirtyNullsDropped.result.rows.length,
      },
      wideFixture: {
        rows: wideParsed.result.rows.length,
        columns: wideParsed.result.columns.length,
        bytes: wideBytes,
      },
      timingsMs: {
        parseMedian: parsed.medianMs,
        profileMedian: profiled.medianMs,
        filterMedian: filtered.medianMs,
        aggregateMedian: aggregated.medianMs,
        highCardinalityAggregateMedian: highCardinality.medianMs,
        exportFilteredRowsMedian: exported.medianMs,
        fullPrepareMedian: prepared.medianMs,
        regressionEvaluationMedian: regression.medianMs,
        duplicateRemovalMedian: cleanDuplicates.medianMs,
        missingRowRemovalMedian: cleanNullRows.medianMs,
        minMaxNormalizationMedian: normalized.medianMs,
        correlationMatrixMedian: correlations.medianMs,
        "50kLeftJoinMedian": joined.medianMs,
        "50kSchemaAlignedAppendMedian": appended.medianMs,
        dirtyParseMedian: dirtyParsed.medianMs,
        dirtyProfileMedian: dirtyProfile.medianMs,
        dirtyFillFilterMedian: dirtyPrepared.medianMs,
        dirtyTrimMedian: dirtyTrimmed.medianMs,
        dirtyDeduplicationMedian: dirtyDeduplicated.medianMs,
        dirtyNullRemovalMedian: dirtyNullsDropped.medianMs,
        dirtyZScoreNormalizationMedian: dirtyNormalized.medianMs,
        dirtyCorrelationMedian: dirtyCorrelation.medianMs,
        dirtyClassificationMedian: dirtyClassification.medianMs,
        wideParseMedian: wideParsed.medianMs,
        wideProfileMedian: wideProfile.medianMs,
        analyzeTable50kMedian: analyzed.medianMs,
        assessQuality50kMedian: assessed.medianMs,
        analyzeTableWide100ColumnsMedian: wideAnalyzed.medianMs,
        spearmanCorrelation50kMedian: spearman.medianMs,
        imputeMedian50kMedian: imputed.medianMs,
        outlierCap50kMedian: outlierCapped.medianMs,
        oneHot50kMedian: oneHot.medianMs,
        replayFiveSteps50kMedian: replayed.medianMs,
        "ridgeTrainAndTest20kSampleMs": ridgeRun.medianMs,
        "ridgeWith5FoldCvMs": ridgeCvRun.medianMs,
        "decisionTree20kSampleMs": treeRun.medianMs,
        "logisticRegression20kSampleMs": logisticRun.medianMs,
        "kmeansK4_20kFitSampleMs": kmeansRun.medianMs,
        "clusterCountScanK2to8Ms": scanRun.medianMs,
      },
      modelRowsUsed: ridgeRun.result.rows.used,
      iterationsPerOperation: parsed.iterations,
      filteredRows: filtered.result.rows.length,
      chartGroups: aggregated.result.length,
      highCardinalityGroupsExamined: MAX_IMPORT_ROWS,
      exportedBytes: Buffer.byteLength(exported.result),
      warmupAndIterationsPerOperation: parsed.iterations,
    },
    null,
    2,
  ),
);
