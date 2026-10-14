import {
  MAX_CORRELATION_COLUMNS,
  MAX_IMPORT_COLUMNS,
  correlationMatrix,
  parseNumber,
  type CorrelationMatrix,
  type DataTable,
} from "./workbench.ts";
import type { Step } from "./recipe.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type SemanticType =
  | "empty"
  | "constant"
  | "boolean"
  | "date"
  | "integer"
  | "numeric"
  | "identifier"
  | "categorical"
  | "text";

export type HistogramBin = { start: number; end: number; count: number };

export type NumericSummary = {
  mean: number;
  /** Sample standard deviation (n - 1). Null when fewer than two values. */
  std: number | null;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  iqr: number;
  /** Adjusted Fisher-Pearson skewness. Null when n < 3 or variance is zero. */
  skewness: number | null;
  lowerFence: number;
  upperFence: number;
  outliers: number;
};

export type ColumnInsight = {
  name: string;
  type: SemanticType;
  present: number;
  missing: number;
  unique: number;
  /** True for the "integer" and "numeric" types. */
  numeric: boolean;
  stats: NumericSummary | null;
  histogram: HistogramBin[];
  topValues: Array<{ value: string; count: number; share: number }>;
  /** Present values with leading or trailing whitespace. */
  whitespaceValues: number;
  /** Values such as "N/A" or "null" that probably mean "missing". */
  missingTokens: number;
  /** Groups of values that differ only by case/spacing (e.g. "Paid", "paid"). */
  caseVariantGroups: number;
  /** Numeric only after removing currency symbols, thousands commas, or "%". */
  looseNumeric: boolean;
  /** Numeric once missing-marker tokens are treated as blanks. */
  numericAfterTokenCleanup: boolean;
};

export type TableInsight = {
  rowCount: number;
  columnCount: number;
  duplicateRows: number;
  columns: ColumnInsight[];
};

export type Severity = "high" | "medium" | "low" | "info";

export type QualityIssue = {
  id: string;
  severity: Severity;
  column?: string;
  title: string;
  detail: string;
  fix?: Step;
  fixLabel?: string;
};

export type QualityReport = {
  /** 0-100. See `assessQuality` for the exact formula. */
  score: number;
  components: {
    completeness: number;
    uniqueness: number;
    consistency: number;
    validity: number;
  };
  issues: QualityIssue[];
};

export type ImputeStrategy = "mean" | "median" | "mode";
export type OutlierMethod = "cap" | "remove";
export type CorrelationMethod = "pearson" | "spearman";
export type CorrelationResult = CorrelationMatrix & {
  method: CorrelationMethod;
  /** Two-sided p-values; null where r is undefined or n < 3. */
  pValues: Array<Array<number | null>>;
};

const MISSING_TOKENS = new Set([
  "n/a",
  "na",
  "nan",
  "null",
  "none",
  "nil",
  "-",
  "--",
  "?",
  "#n/a",
  "#na",
  "missing",
]);
const BOOLEAN_TOKENS = new Set(["true", "false", "yes", "no", "y", "n", "t", "f"]);
const ID_NAME = /(^|[\s_\-.])(id|uuid|guid|key|index|idx|ref|reference)$/i;
const CURRENCY_CODES = "USD|EUR|GBP|TZS|TSH|KES|KSH|UGX|RWF|ZAR|NGN|INR";
const LOOSE_NUMBER = new RegExp(
  `^(?<sign>[+-]?)\\s*(?:(?:${CURRENCY_CODES})\\s?|[$€£¥₹₦]\\s?)?` +
    `(?<body>\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|\\.\\d+)` +
    `\\s*(?<percent>%)?\\s*(?:${CURRENCY_CODES})?$`,
  "i",
);
const ISO_DATE =
  /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/* -------------------------------------------------------------------------- */
/* Small numeric helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Linear-interpolation quantile (NumPy's default, "R-7"). `sorted` ascending. */
export function quantileSorted(sorted: number[], probability: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Locale-independent text ordering (UTF-16 code units). Used wherever a tie
 * decides what gets written into the data, so a recipe replays identically on
 * every machine instead of depending on the browser's ICU locale.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function formatCell(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/**
 * Parses numbers written with currency symbols, thousands commas, parentheses
 * for negatives, or a percent sign ("12%" becomes 0.12). Ambiguous European
 * decimals such as "1,5" are rejected rather than guessed.
 */
export function parseLooseNumber(text: string): number | null {
  const direct = parseNumber(text);
  if (direct !== null) return direct;
  let trimmed = text.trim();
  if (!trimmed) return null;
  let negative = false;
  const wrapped = /^\((.*)\)$/.exec(trimmed);
  if (wrapped) {
    negative = true;
    trimmed = wrapped[1].trim();
  }
  const match = LOOSE_NUMBER.exec(trimmed);
  if (!match?.groups) return null;
  let value = Number(match.groups.body.replaceAll(",", ""));
  if (!Number.isFinite(value)) return null;
  if (match.groups.percent) value /= 100;
  if (match.groups.sign === "-") negative = !negative;
  return negative ? -value : value;
}

export type DateParts = {
  year: number;
  month: number;
  day: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
};

/** Parses ISO-style dates (YYYY-MM-DD or YYYY/MM/DD, optional time). */
export function parseDateParts(text: string): DateParts | null {
  const match = ISO_DATE.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day
  )
    return null;
  const weekday = stamp.getUTCDay() === 0 ? 7 : stamp.getUTCDay();
  return { year, month, day, weekday };
}

export function normalizeCategory(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function squashSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/* -------------------------------------------------------------------------- */
/* Column and table analysis                                                  */
/* -------------------------------------------------------------------------- */

export function summarizeNumbers(values: number[]): NumericSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  let total = 0;
  for (const value of sorted) total += value;
  const mean = total / count;
  let squares = 0;
  let cubes = 0;
  for (const value of sorted) {
    const delta = value - mean;
    squares += delta ** 2;
    cubes += delta ** 3;
  }
  const std = count > 1 ? Math.sqrt(squares / (count - 1)) : null;
  const populationVariance = squares / count;
  let skewness: number | null = null;
  if (count >= 3 && populationVariance > 0) {
    const g1 = cubes / count / populationVariance ** 1.5;
    skewness = (g1 * Math.sqrt(count * (count - 1))) / (count - 2);
  }
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  let outliers = 0;
  if (iqr > 0) {
    for (const value of sorted)
      if (value < lowerFence || value > upperFence) outliers += 1;
  }
  return {
    mean,
    std,
    min: sorted[0],
    q1,
    median: quantileSorted(sorted, 0.5),
    q3,
    max: sorted[count - 1],
    iqr,
    skewness,
    lowerFence,
    upperFence,
    outliers,
  };
}

export function buildHistogram(values: number[]): HistogramBin[] {
  if (values.length === 0) return [];
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  if (minimum === maximum) return [{ start: minimum, end: maximum, count: values.length }];
  const binCount = Math.min(20, Math.max(5, Math.ceil(Math.log2(values.length)) + 1));
  const width = (maximum - minimum) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => ({
    start: minimum + index * width,
    end: index === binCount - 1 ? maximum : minimum + (index + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - minimum) / width));
    bins[index].count += 1;
  }
  return bins;
}

export function analyzeColumn(
  name: string,
  values: string[],
  rowCount = values.length,
): ColumnInsight {
  const present = values.filter((value) => value.trim() !== "");
  const frequencies = new Map<string, number>();
  for (const value of present) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  const unique = frequencies.size;
  const topValues = [...frequencies.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .slice(0, 5)
    .map(([value, count]) => ({ value, count, share: count / present.length }));

  const parsed = present.map(parseNumber);
  const allNumeric = present.length > 0 && parsed.every((value) => value !== null);
  const numbers = allNumeric ? (parsed as number[]) : [];

  let whitespaceValues = 0;
  let missingTokens = 0;
  for (const value of present) {
    if (value !== value.trim()) whitespaceValues += 1;
    if (MISSING_TOKENS.has(value.trim().toLocaleLowerCase())) missingTokens += 1;
  }

  let caseVariantGroups = 0;
  if (!allNumeric && unique <= 5000) {
    const groups = new Map<string, Set<string>>();
    for (const value of frequencies.keys()) {
      const key = normalizeCategory(value);
      const spellings = groups.get(key) ?? new Set<string>();
      spellings.add(squashSpaces(value));
      groups.set(key, spellings);
    }
    for (const spellings of groups.values()) if (spellings.size > 1) caseVariantGroups += 1;
  }

  const nonTokens = present.filter(
    (value) => !MISSING_TOKENS.has(value.trim().toLocaleLowerCase()),
  );
  const numericAfterTokenCleanup =
    !allNumeric &&
    missingTokens > 0 &&
    nonTokens.length > 0 &&
    nonTokens.every((value) => parseNumber(value) !== null);
  const looseNumeric =
    !allNumeric &&
    !numericAfterTokenCleanup &&
    present.length > 0 &&
    present.every((value) => parseLooseNumber(value) !== null);

  let type: SemanticType;
  const lowered = new Set(present.map((value) => value.trim().toLocaleLowerCase()));
  if (present.length === 0) type = "empty";
  else if (unique === 1) type = "constant";
  else if (
    unique === 2 &&
    ((allNumeric && numbers.every((value) => value === 0 || value === 1)) ||
      [...lowered].every((value) => BOOLEAN_TOKENS.has(value)))
  )
    type = "boolean";
  else if (!allNumeric && present.every((value) => parseDateParts(value) !== null))
    type = "date";
  else if (allNumeric) {
    const integers = numbers.every(Number.isInteger);
    const idLike = ID_NAME.test(name) && integers && unique >= 0.5 * present.length;
    type = idLike ? "identifier" : integers ? "integer" : "numeric";
  } else if (
    (ID_NAME.test(name) && unique >= 0.5 * present.length) ||
    (rowCount >= 10 && unique >= 0.9 * present.length)
  )
    type = "identifier";
  else if (unique <= 50 && unique <= 0.5 * present.length) type = "categorical";
  else type = unique <= 12 ? "categorical" : "text";

  const numericType = type === "integer" || type === "numeric";
  return {
    name,
    type,
    present: present.length,
    missing: values.length - present.length,
    unique,
    numeric: numericType,
    stats: numericType ? summarizeNumbers(numbers) : null,
    histogram: numericType ? buildHistogram(numbers) : [],
    topValues,
    whitespaceValues,
    missingTokens,
    caseVariantGroups,
    looseNumeric,
    numericAfterTokenCleanup,
  };
}

export function analyzeTable(table: DataTable): TableInsight {
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const row of table.rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) duplicateRows += 1;
    else seen.add(key);
  }
  return {
    rowCount: table.rows.length,
    columnCount: table.columns.length,
    duplicateRows,
    columns: table.columns.map((name, index) =>
      analyzeColumn(
        name,
        table.rows.map((row) => row[index] ?? ""),
        table.rows.length,
      ),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Data-quality assessment                                                    */
/* -------------------------------------------------------------------------- */

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/**
 * Scores data quality 0-100 as a weighted mean of four transparent parts:
 *   completeness 35% = share of non-empty cells
 *   uniqueness   20% = share of rows that are not exact duplicates
 *   consistency  25% = share of columns without whitespace, missing-marker,
 *                      mixed-case-spelling, or number-formatting problems
 *   validity     20% = share of numeric cells that are not IQR outliers
 * It is a triage aid for spotting where to look first, not a guarantee.
 */
export function assessQuality(
  table: DataTable,
  insight: TableInsight = analyzeTable(table),
): QualityReport {
  const rows = Math.max(1, insight.rowCount);
  const issues: QualityIssue[] = [];
  let missingCells = 0;
  let flaggedColumns = 0;
  let outlierCells = 0;
  let numericCells = 0;

  for (const column of insight.columns) {
    missingCells += column.missing;
    const missingShare = column.missing / rows;
    const inconsistent =
      column.whitespaceValues > 0 ||
      column.missingTokens > 0 ||
      column.caseVariantGroups > 0 ||
      column.looseNumeric ||
      column.numericAfterTokenCleanup;
    if (inconsistent) flaggedColumns += 1;
    if (column.stats) {
      numericCells += column.present;
      outlierCells += column.stats.outliers;
    }

    if (column.type === "empty") {
      issues.push({
        id: `empty:${column.name}`,
        severity: "high",
        column: column.name,
        title: `"${column.name}" is completely empty`,
        detail: "Every value is missing, so it carries no information.",
        fix: { op: "remove-column", column: column.name },
        fixLabel: "Remove column",
      });
      continue;
    }
    if (missingShare > 0.4) {
      issues.push({
        id: `high-missing:${column.name}`,
        severity: "high",
        column: column.name,
        title: `"${column.name}" is ${Math.round(missingShare * 100)}% missing`,
        detail:
          "Filling this much missing data invents most of the column. Consider removing it or finding the source.",
        fix: { op: "remove-column", column: column.name },
        fixLabel: "Remove column",
      });
    } else if (column.missing > 0) {
      const numericColumn = column.numeric;
      issues.push({
        id: `missing:${column.name}`,
        severity: missingShare > 0.1 ? "medium" : "low",
        column: column.name,
        title: `"${column.name}" has ${column.missing} missing value${column.missing === 1 ? "" : "s"}`,
        detail:
          (numericColumn
            ? "The median is a robust fill that is not distorted by outliers."
            : "The most common value is a simple fill; review whether that is appropriate.") +
          " If this is the column you want to predict, remove these rows instead: filling it would invent answers.",
        fix: {
          op: "impute",
          column: column.name,
          strategy: numericColumn ? "median" : "mode",
        },
        fixLabel: numericColumn ? "Fill with median" : "Fill with most common",
      });
    }
    if (column.missingTokens > 0) {
      issues.push({
        id: `tokens:${column.name}`,
        severity: column.numericAfterTokenCleanup ? "medium" : "low",
        column: column.name,
        title: `"${column.name}" uses ${column.missingTokens} text marker${column.missingTokens === 1 ? "" : "s"} for missing`,
        detail: column.numericAfterTokenCleanup
          ? 'Values such as "N/A" are blocking this column from being numeric.'
          : 'Values such as "N/A" or "null" are counted as real values, not missing.',
        fix: { op: "standardize-missing", column: column.name },
        fixLabel: "Mark as missing",
      });
    }
    if (column.looseNumeric) {
      issues.push({
        id: `loose:${column.name}`,
        severity: "medium",
        column: column.name,
        title: `"${column.name}" holds numbers stored as text`,
        detail:
          "Currency symbols, thousands commas, or % signs stop it being treated as numeric. Percentages become fractions (12% → 0.12).",
        fix: { op: "convert-number", column: column.name },
        fixLabel: "Convert to number",
      });
    }
    if (column.whitespaceValues > 0) {
      issues.push({
        id: `space:${column.name}`,
        severity: "low",
        column: column.name,
        title: `"${column.name}" has stray whitespace in ${column.whitespaceValues} value${column.whitespaceValues === 1 ? "" : "s"}`,
        detail: 'Padding makes "Paid" and "Paid " count as different values.',
        fix: { op: "trim", column: column.name },
        fixLabel: "Trim whitespace",
      });
    }
    if (column.caseVariantGroups > 0) {
      issues.push({
        id: `case:${column.name}`,
        severity: "medium",
        column: column.name,
        title: `"${column.name}" spells the same value ${column.caseVariantGroups} different way${column.caseVariantGroups === 1 ? "" : "s"}`,
        detail: 'Variants such as "paid" and "Paid" split one category into several.',
        fix: { op: "harmonize-categories", column: column.name },
        fixLabel: "Merge spellings",
      });
    }
    if (column.stats && column.stats.outliers > 0) {
      const share = column.stats.outliers / Math.max(1, column.present);
      issues.push({
        id: `outliers:${column.name}`,
        severity: share > 0.05 ? "medium" : "low",
        column: column.name,
        title: `"${column.name}" has ${column.stats.outliers} outlier${column.stats.outliers === 1 ? "" : "s"}`,
        detail: `Values outside ${formatCell(column.stats.lowerFence)} to ${formatCell(column.stats.upperFence)} (1.5 × IQR rule). Outliers can be real; capping only limits their influence.`,
        fix: { op: "outliers", column: column.name, method: "cap", multiplier: 1.5 },
        fixLabel: "Cap outliers",
      });
    }
    if (column.type === "constant") {
      issues.push({
        id: `constant:${column.name}`,
        severity: "low",
        column: column.name,
        title: `"${column.name}" never changes`,
        detail: "A single repeated value cannot explain differences between rows.",
        fix: { op: "remove-column", column: column.name },
        fixLabel: "Remove column",
      });
    }
    if (column.type === "identifier") {
      issues.push({
        id: `identifier:${column.name}`,
        severity: "info",
        column: column.name,
        title: `"${column.name}" looks like an identifier`,
        detail: "Models skip identifier-like columns by default because they only memorize rows.",
      });
    }
    if (column.type === "date") {
      issues.push({
        id: `date:${column.name}`,
        severity: "info",
        column: column.name,
        title: `"${column.name}" is a date`,
        detail: "Splitting it into year, month, day and weekday makes it usable as a model feature.",
        fix: { op: "date-parts", column: column.name },
        fixLabel: "Extract date parts",
      });
    }
    if (column.type === "text" && column.unique > 50) {
      issues.push({
        id: `cardinality:${column.name}`,
        severity: "info",
        column: column.name,
        title: `"${column.name}" has ${column.unique} distinct text values`,
        detail: "Too many categories to encode reliably; models skip it unless you reshape it.",
      });
    }
  }

  if (insight.duplicateRows > 0) {
    issues.push({
      id: "duplicates",
      severity: insight.duplicateRows / rows > 0.05 ? "medium" : "low",
      title: `${insight.duplicateRows} exact duplicate row${insight.duplicateRows === 1 ? "" : "s"}`,
      detail: "Repeated rows overweight some records and can leak between train and test sets.",
      fix: { op: "deduplicate" },
      fixLabel: "Remove duplicates",
    });
  }
  if (insight.rowCount < 30) {
    issues.push({
      id: "small-sample",
      severity: "info",
      title: `Only ${insight.rowCount} row${insight.rowCount === 1 ? "" : "s"}`,
      detail: "Statistics and model scores on so few rows are unstable; treat them as illustrations.",
    });
  }

  const totalCells = Math.max(1, insight.rowCount * insight.columnCount);
  const completeness = 100 * (1 - missingCells / totalCells);
  const uniqueness = 100 * (1 - insight.duplicateRows / rows);
  const consistency = 100 * (1 - flaggedColumns / Math.max(1, insight.columnCount));
  const validity = 100 * (1 - outlierCells / Math.max(1, numericCells));
  const score = Math.round(
    0.35 * completeness + 0.2 * uniqueness + 0.25 * consistency + 0.2 * validity,
  );

  issues.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
  return {
    score,
    components: {
      completeness: Math.round(completeness),
      uniqueness: Math.round(uniqueness),
      consistency: Math.round(consistency),
      validity: Math.round(validity),
    },
    issues,
  };
}

/* -------------------------------------------------------------------------- */
/* Cleaning and feature-preparation operations                                */
/* -------------------------------------------------------------------------- */

function columnIndex(table: DataTable, column: string): number {
  const index = table.columns.indexOf(column);
  if (index < 0) throw new Error("Choose a column that exists in the current dataset.");
  return index;
}

function mapColumn(
  table: DataTable,
  index: number,
  transform: (value: string) => string,
): DataTable {
  return {
    ...table,
    rows: table.rows.map((row) =>
      row.map((value, position) => (position === index ? transform(value) : value)),
    ),
  };
}

function uniqueColumnName(existing: Iterable<string>, wanted: string): string {
  const taken = new Set([...existing].map((name) => name.toLocaleLowerCase()));
  let candidate = wanted;
  let suffix = 2;
  while (taken.has(candidate.toLocaleLowerCase())) {
    candidate = `${wanted} (${suffix})`;
    suffix += 1;
  }
  return candidate;
}

export function imputeColumn(
  table: DataTable,
  column: string,
  strategy: ImputeStrategy,
): DataTable {
  const index = columnIndex(table, column);
  const present = table.rows
    .map((row) => row[index] ?? "")
    .filter((value) => value.trim() !== "");
  if (present.length === 0)
    throw new Error("This column has no values to learn a replacement from.");
  let replacement: string;
  if (strategy === "mode") {
    const counts = new Map<string, number>();
    for (const value of present) counts.set(value, (counts.get(value) ?? 0) + 1);
    replacement = [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
    )[0][0];
  } else {
    const parsed = present.map(parseNumber);
    if (parsed.some((value) => value === null))
      throw new Error("Mean and median fills need a numeric column. Use the most common value instead.");
    const numbers = (parsed as number[]).sort((left, right) => left - right);
    replacement =
      strategy === "median"
        ? formatCell(quantileSorted(numbers, 0.5))
        : formatCell(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
  }
  return mapColumn(table, index, (value) => (value.trim() === "" ? replacement : value));
}

/** Converts missing-marker tokens ("N/A", "null", ...) to empty cells. */
export function standardizeMissing(table: DataTable, column: string): DataTable {
  const index = columnIndex(table, column);
  return mapColumn(table, index, (value) =>
    MISSING_TOKENS.has(value.trim().toLocaleLowerCase()) ? "" : value,
  );
}

/** Rewrites currency/thousands/percent text as plain numbers. All-or-nothing. */
export function convertToNumber(table: DataTable, column: string): DataTable {
  const index = columnIndex(table, column);
  for (const row of table.rows) {
    const value = row[index] ?? "";
    if (value.trim() !== "" && parseLooseNumber(value) === null)
      throw new Error(`"${value}" cannot be read as a number, so nothing was converted.`);
  }
  return mapColumn(table, index, (value) => {
    if (value.trim() === "") return value;
    return formatCell(parseLooseNumber(value) as number);
  });
}

/** Merges spellings that differ only by case/spacing into the most common form. */
export function harmonizeCategories(table: DataTable, column: string): DataTable {
  const index = columnIndex(table, column);
  const spellings = new Map<string, Map<string, number>>();
  for (const row of table.rows) {
    const value = row[index] ?? "";
    if (value.trim() === "") continue;
    const key = normalizeCategory(value);
    const group = spellings.get(key) ?? new Map<string, number>();
    const squashed = squashSpaces(value);
    group.set(squashed, (group.get(squashed) ?? 0) + 1);
    spellings.set(key, group);
  }
  const canonical = new Map<string, string>();
  for (const [key, group] of spellings) {
    canonical.set(
      key,
      [...group.entries()].sort(
        (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
      )[0][0],
    );
  }
  return mapColumn(table, index, (value) =>
    value.trim() === "" ? value : (canonical.get(normalizeCategory(value)) ?? value),
  );
}

export function treatOutliers(
  table: DataTable,
  column: string,
  method: OutlierMethod,
  multiplier = 1.5,
): DataTable {
  const index = columnIndex(table, column);
  if (!(multiplier > 0)) throw new Error("The IQR multiplier must be greater than zero.");
  const parsed = table.rows
    .map((row) => row[index] ?? "")
    .filter((value) => value.trim() !== "")
    .map(parseNumber);
  if (parsed.length === 0 || parsed.some((value) => value === null))
    throw new Error("Outlier handling needs a numeric column with no text values.");
  const sorted = (parsed as number[]).sort((left, right) => left - right);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return { ...table };
  const lower = q1 - multiplier * iqr;
  const upper = q3 + multiplier * iqr;
  if (method === "remove") {
    return {
      ...table,
      rows: table.rows.filter((row) => {
        const value = parseNumber(row[index] ?? "");
        return value === null || (value >= lower && value <= upper);
      }),
    };
  }
  return mapColumn(table, index, (value) => {
    const number = parseNumber(value);
    if (number === null) return value;
    if (number < lower) return formatCell(lower);
    if (number > upper) return formatCell(upper);
    return value;
  });
}

/** Replaces a category column with 0/1 indicator columns, most common first. */
export function oneHotEncode(
  table: DataTable,
  column: string,
  maxCategories = 20,
  keepOriginal = false,
): DataTable {
  const index = columnIndex(table, column);
  const counts = new Map<string, number>();
  for (const row of table.rows) {
    const value = (row[index] ?? "").trim();
    if (value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (counts.size === 0) throw new Error("This column has no values to encode.");
  if (counts.size > maxCategories)
    throw new Error(
      `"${column}" has ${counts.size} categories; encoding is limited to ${maxCategories} to keep the table manageable.`,
    );
  const categories = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([value]) => value);
  const kept = table.columns.filter((_, position) => keepOriginal || position !== index);
  if (kept.length + categories.length > MAX_IMPORT_COLUMNS)
    throw new Error(`Encoding would exceed the ${MAX_IMPORT_COLUMNS}-column limit.`);
  const names: string[] = [...kept];
  for (const category of categories)
    names.push(uniqueColumnName(names, `${column}=${category}`));
  return {
    ...table,
    columns: names,
    rows: table.rows.map((row) => [
      ...row.filter((_, position) => keepOriginal || position !== index),
      ...categories.map((category) => ((row[index] ?? "").trim() === category ? "1" : "0")),
    ]),
  };
}

/** Adds year, month, day and ISO-weekday columns for a date column. */
export function extractDateParts(table: DataTable, column: string): DataTable {
  const index = columnIndex(table, column);
  const parsed = table.rows.map((row) => {
    const value = row[index] ?? "";
    if (value.trim() === "") return null;
    const parts = parseDateParts(value);
    if (!parts) throw new Error(`"${value}" is not an ISO date (YYYY-MM-DD), so no parts were added.`);
    return parts;
  });
  if (parsed.every((parts) => parts === null))
    throw new Error("This column has no dates to extract from.");
  if (table.columns.length + 4 > MAX_IMPORT_COLUMNS)
    throw new Error(`Adding date parts would exceed the ${MAX_IMPORT_COLUMNS}-column limit.`);
  const columns = [...table.columns];
  for (const part of ["year", "month", "day", "weekday"])
    columns.push(uniqueColumnName(columns, `${column} (${part})`));
  return {
    ...table,
    columns,
    rows: table.rows.map((row, position) => {
      const parts = parsed[position];
      return [
        ...row,
        ...(parts
          ? [parts.year, parts.month, parts.day, parts.weekday].map(String)
          : ["", "", "", ""]),
      ];
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Correlation: Spearman and significance                                     */
/* -------------------------------------------------------------------------- */

/** Average ranks (1-based); ties share the mean of the ranks they occupy. */
export function averageRanks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let position = start; position <= end; position += 1) ranks[order[position].index] = rank;
    start = end + 1;
  }
  return ranks;
}

function pearson(left: number[], right: number[]): number | null {
  const count = left.length;
  if (count < 2) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / count;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < count; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  if (leftVariance === 0 || rightVariance === 0) return null;
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

function logGamma(x: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = 0.99999999999980993;
  for (let index = 0; index < coefficients.length; index += 1)
    sum += coefficients[index] / (shifted + index + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Regularized incomplete beta I_x(a, b) via a Lentz continued fraction. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  const fraction = (x: number, a: number, b: number): number => {
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m += 1) {
      const twoM = 2 * m;
      let term = (m * (b - m) * x) / ((a + twoM - 1) * (a + twoM));
      d = 1 + term * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + term / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      term = (-(a + m) * (a + b + m) * x) / ((a + twoM) * (a + twoM + 1));
      d = 1 + term * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + term / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < 1e-14) break;
    }
    return h;
  };
  if (x < (a + 1) / (a + b + 2)) return (front * fraction(x, a, b)) / a;
  return 1 - (front * fraction(1 - x, b, a)) / b;
}

/** Two-sided p-value for a correlation coefficient (t-test, n - 2 degrees of freedom). */
export function correlationPValue(r: number, n: number): number | null {
  if (!Number.isFinite(r) || n < 3) return null;
  const magnitude = Math.min(1, Math.abs(r));
  if (magnitude === 1) return 0;
  const degrees = n - 2;
  const t = (magnitude * Math.sqrt(degrees)) / Math.sqrt(1 - magnitude ** 2);
  return regularizedIncompleteBeta(degrees / (degrees + t * t), degrees / 2, 0.5);
}

export function correlate(
  table: DataTable,
  columns: string[],
  method: CorrelationMethod = "pearson",
): CorrelationResult {
  if (columns.length > MAX_CORRELATION_COLUMNS)
    throw new Error(`Compare no more than ${MAX_CORRELATION_COLUMNS} columns at a time.`);
  // Reuses the Pearson routine for validation, complete-pair counts, and values.
  const base = correlationMatrix(table, columns);
  let values = base.values;
  if (method === "spearman") {
    const indexes = columns.map((name) => table.columns.indexOf(name));
    const parsed = indexes.map((index) => table.rows.map((row) => parseNumber(row[index] ?? "")));
    // Columns without blanks share one ranking across every pair; the rest are
    // ranked over each pair's complete rows (the definition of pairwise Spearman).
    const sharedRanks = parsed.map((column) =>
      column.every((value) => value !== null) ? averageRanks(column as number[]) : null,
    );
    const matrix: Array<Array<number | null>> = columns.map((_, row) =>
      columns.map((__, column) => (row === column ? base.values[row][column] : null)),
    );
    for (let row = 0; row < columns.length; row += 1) {
      for (let column = row + 1; column < columns.length; column += 1) {
        const leftShared = sharedRanks[row];
        const rightShared = sharedRanks[column];
        let value: number | null;
        if (leftShared && rightShared) {
          value = pearson(leftShared, rightShared);
        } else {
          const left: number[] = [];
          const right: number[] = [];
          for (let position = 0; position < parsed[row].length; position += 1) {
            const a = parsed[row][position];
            const b = parsed[column][position];
            if (a === null || b === null) continue;
            left.push(a);
            right.push(b);
          }
          value = pearson(averageRanks(left), averageRanks(right));
        }
        matrix[row][column] = value;
        matrix[column][row] = value;
      }
    }
    values = matrix;
  }
  const pValues = values.map((line, row) =>
    line.map((value, column) =>
      value === null ? null : row === column ? 0 : correlationPValue(value, base.counts[row][column]),
    ),
  );
  return { columns: base.columns, values, counts: base.counts, method, pValues };
}
