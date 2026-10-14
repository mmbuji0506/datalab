import { addClusterColumn, kmeans, MAX_CLUSTER_COLUMNS } from "./clustering.ts";
import {
  convertToNumber,
  extractDateParts,
  harmonizeCategories,
  imputeColumn,
  oneHotEncode,
  standardizeMissing,
  treatOutliers,
  type ImputeStrategy,
  type OutlierMethod,
} from "./analytics.ts";
import {
  dropDuplicateRows,
  dropRowsWithMissingValues,
  fillMissing,
  filterRows,
  normalizeNumericColumn,
  removeColumn,
  renameColumn,
  trimTextColumn,
  type DataTable,
  type FilterOperator,
  type Normalization,
} from "./workbench.ts";

/**
 * One reversible data-preparation action. Steps are plain data so a session can
 * be replayed from the imported source (for undo) or saved as a recipe file.
 */
export type Step =
  | { op: "rename"; column: string; to: string }
  | { op: "fill"; column: string; value: string }
  | { op: "impute"; column: string; strategy: ImputeStrategy }
  | { op: "trim"; column: string }
  | { op: "drop-missing"; columns: string[] }
  | { op: "deduplicate" }
  | { op: "normalize"; column: string; method: Normalization }
  | { op: "remove-column"; column: string }
  | { op: "filter"; column: string; operator: FilterOperator; value: string }
  | { op: "standardize-missing"; column: string }
  | { op: "convert-number"; column: string }
  | { op: "harmonize-categories"; column: string }
  | { op: "outliers"; column: string; method: OutlierMethod; multiplier?: number }
  | { op: "one-hot"; column: string; maxCategories?: number }
  | { op: "date-parts"; column: string }
  /** Deterministic for a given seed, so replaying a recipe reproduces the same groups. */
  | { op: "cluster"; columns: string[]; k: number; seed: number }
  /** In-memory only: a table produced by appending or joining another file. */
  | { op: "replace-table"; table: DataTable; label: string };

export const RECIPE_FORMAT = "datalab-recipe";
export const RECIPE_VERSION = 1;
export const MAX_RECIPE_STEPS = 200;
const MAX_RECIPE_BYTES = 1024 * 1024;

export function applyStep(table: DataTable, step: Step): DataTable {
  switch (step.op) {
    case "rename":
      return renameColumn(table, step.column, step.to);
    case "fill":
      return fillMissing(table, step.column, step.value);
    case "impute":
      return imputeColumn(table, step.column, step.strategy);
    case "trim":
      return trimTextColumn(table, step.column);
    case "drop-missing":
      return dropRowsWithMissingValues(table, step.columns);
    case "deduplicate":
      return dropDuplicateRows(table);
    case "normalize":
      return normalizeNumericColumn(table, step.column, step.method);
    case "remove-column":
      return removeColumn(table, step.column);
    case "filter":
      return filterRows(table, step.column, step.operator, step.value);
    case "standardize-missing":
      return standardizeMissing(table, step.column);
    case "convert-number":
      return convertToNumber(table, step.column);
    case "harmonize-categories":
      return harmonizeCategories(table, step.column);
    case "outliers":
      return treatOutliers(table, step.column, step.method, step.multiplier);
    case "one-hot":
      return oneHotEncode(table, step.column, step.maxCategories);
    case "date-parts":
      return extractDateParts(table, step.column);
    case "cluster":
      return addClusterColumn(table, kmeans(table, step.columns, step.k, step.seed).assignments);
    case "replace-table":
      return step.table;
  }
}

export function describeStep(step: Step): string {
  switch (step.op) {
    case "rename":
      return `Rename "${step.column}" to "${step.to}"`;
    case "fill":
      return `Fill missing "${step.column}" with "${step.value}"`;
    case "impute":
      return `Fill missing "${step.column}" with the ${step.strategy === "mode" ? "most common value" : step.strategy}`;
    case "trim":
      return `Trim whitespace in "${step.column}"`;
    case "drop-missing":
      return `Remove rows missing ${step.columns.map((name) => `"${name}"`).join(", ")}`;
    case "deduplicate":
      return "Remove duplicate rows";
    case "normalize":
      return `${step.method === "min-max" ? "Scale to 0–1" : "Standardize (z-score)"}: "${step.column}"`;
    case "remove-column":
      return `Remove column "${step.column}"`;
    case "filter":
      return `Keep rows where "${step.column}" ${filterPhrase(step.operator)}${step.operator === "empty" || step.operator === "not-empty" ? "" : ` "${step.value}"`}`;
    case "standardize-missing":
      return `Mark "N/A"-style values in "${step.column}" as missing`;
    case "convert-number":
      return `Convert "${step.column}" to numbers`;
    case "harmonize-categories":
      return `Merge spelling variants in "${step.column}"`;
    case "outliers":
      return `${step.method === "cap" ? "Cap" : "Remove"} outliers in "${step.column}" (${step.multiplier ?? 1.5} × IQR)`;
    case "one-hot":
      return `One-hot encode "${step.column}"`;
    case "date-parts":
      return `Extract year, month, day, weekday from "${step.column}"`;
    case "cluster":
      return `Group rows into ${step.k} clusters using ${step.columns.map((name) => `"${name}"`).join(", ")} (seed ${step.seed})`;
    case "replace-table":
      return step.label;
  }
}

function filterPhrase(operator: FilterOperator): string {
  switch (operator) {
    case "equals":
      return "equals";
    case "contains":
      return "contains";
    case "greater":
      return "is greater than";
    case "less":
      return "is less than";
    case "empty":
      return "is empty";
    case "not-empty":
      return "is not empty";
  }
}

/** Re-runs every step on `source`. A failure names the step that caused it. */
export function replayRecipe(source: DataTable, steps: Step[]): DataTable {
  let table = source;
  steps.forEach((step, index) => {
    try {
      table = applyStep(table, step);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "The step failed.";
      throw new Error(`Step ${index + 1} (${describeStep(step)}): ${reason}`);
    }
  });
  return table;
}

/** True when the recipe depends on another file and cannot be saved as JSON. */
export function needsExternalData(steps: Step[]): boolean {
  return steps.some((step) => step.op === "replace-table");
}

export function exportRecipe(steps: Step[], sourceName: string): string {
  if (needsExternalData(steps))
    throw new Error(
      "This session combines another file (append or join), which a recipe file cannot contain. Export the prepared CSV instead.",
    );
  return JSON.stringify(
    { format: RECIPE_FORMAT, version: RECIPE_VERSION, createdFrom: sourceName, steps },
    null,
    2,
  );
}

const OPERATORS: FilterOperator[] = ["equals", "contains", "greater", "less", "empty", "not-empty"];
const IMPUTE: ImputeStrategy[] = ["mean", "median", "mode"];
const NORMALIZATIONS: Normalization[] = ["min-max", "z-score"];
const OUTLIER_METHODS: OutlierMethod[] = ["cap", "remove"];

/** Parses and strictly validates a recipe file. Only known fields are copied. */
export function parseRecipe(text: string): Step[] {
  if (text.length > MAX_RECIPE_BYTES) throw new Error("The recipe file is too large.");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The recipe file is not valid JSON.");
  }
  if (!isRecord(data) || data.format !== RECIPE_FORMAT)
    throw new Error("This file is not a DataLab recipe.");
  if (data.version !== RECIPE_VERSION)
    throw new Error(`Unsupported recipe version ${String(data.version)}.`);
  if (!Array.isArray(data.steps)) throw new Error("The recipe has no steps list.");
  if (data.steps.length > MAX_RECIPE_STEPS)
    throw new Error(`Recipes are limited to ${MAX_RECIPE_STEPS} steps.`);
  return data.steps.map((raw, index) => {
    try {
      return validateStep(raw);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "Invalid step.";
      throw new Error(`Recipe step ${index + 1}: ${reason}`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`"${key}" must be text.`);
  return value;
}

function oneOf<T extends string>(record: Record<string, unknown>, key: string, allowed: T[]): T {
  const value = text(record, key);
  if (!allowed.includes(value as T)) throw new Error(`"${key}" has an unsupported value.`);
  return value as T;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`"${key}" must be a positive number.`);
  return value;
}

function validateStep(raw: unknown): Step {
  if (!isRecord(raw)) throw new Error("A step must be an object.");
  const op = text(raw, "op");
  switch (op) {
    case "rename":
      return { op, column: text(raw, "column"), to: text(raw, "to") };
    case "fill":
      return { op, column: text(raw, "column"), value: text(raw, "value") };
    case "impute":
      return { op, column: text(raw, "column"), strategy: oneOf(raw, "strategy", IMPUTE) };
    case "drop-missing": {
      const columns = raw.columns;
      if (!Array.isArray(columns) || columns.some((name) => typeof name !== "string"))
        throw new Error('"columns" must be a list of names.');
      return { op, columns: columns as string[] };
    }
    case "deduplicate":
      return { op };
    case "normalize":
      return { op, column: text(raw, "column"), method: oneOf(raw, "method", NORMALIZATIONS) };
    case "filter":
      return {
        op,
        column: text(raw, "column"),
        operator: oneOf(raw, "operator", OPERATORS),
        value: text(raw, "value"),
      };
    case "outliers": {
      const multiplier = optionalNumber(raw, "multiplier");
      return {
        op,
        column: text(raw, "column"),
        method: oneOf(raw, "method", OUTLIER_METHODS),
        ...(multiplier === undefined ? {} : { multiplier }),
      };
    }
    case "one-hot": {
      const maxCategories = optionalNumber(raw, "maxCategories");
      return {
        op,
        column: text(raw, "column"),
        ...(maxCategories === undefined ? {} : { maxCategories }),
      };
    }
    case "cluster": {
      const columns = raw.columns;
      if (
        !Array.isArray(columns) ||
        columns.length < 1 ||
        columns.length > MAX_CLUSTER_COLUMNS ||
        columns.some((name) => typeof name !== "string")
      )
        throw new Error(`"columns" must list 1 to ${MAX_CLUSTER_COLUMNS} column names.`);
      const k = raw.k;
      const seed = raw.seed;
      if (typeof k !== "number" || !Number.isInteger(k) || k < 2 || k > 12)
        throw new Error('"k" must be a whole number from 2 to 12.');
      if (typeof seed !== "number" || !Number.isInteger(seed))
        throw new Error('"seed" must be a whole number.');
      return { op, columns: columns as string[], k, seed };
    }
    case "trim":
    case "remove-column":
    case "standardize-missing":
    case "convert-number":
    case "harmonize-categories":
    case "date-parts":
      return { op, column: text(raw, "column") };
    default:
      throw new Error(`Unknown operation "${op}".`);
  }
}
