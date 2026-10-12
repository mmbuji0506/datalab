export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
export const MAX_IMPORT_COLUMNS = 100;
export const MAX_CORRELATION_COLUMNS = 8;
const MAX_CELL_LENGTH = 32_000;

export type DataTable = {
  sourceName: string;
  columns: string[];
  rows: string[][];
};

export type ColumnProfile = {
  name: string;
  missing: number;
  unique: number;
  numeric: boolean;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  topValues: Array<{ value: string; count: number }>;
};

export type TableProfile = {
  rowCount: number;
  columnCount: number;
  duplicateRows: number;
  columns: ColumnProfile[];
};

export type FilterOperator =
  "equals" | "contains" | "greater" | "less" | "empty" | "not-empty";
export type Aggregation = "sum" | "mean" | "count";
export type AggregatePoint = { group: string; value: number; records: number };
export type Normalization = "min-max" | "z-score";
export type CorrelationMatrix = {
  columns: string[];
  values: Array<Array<number | null>>;
  counts: number[][];
};
export type JoinMode = "inner" | "left";

export type BaselineEvaluation = {
  task: "regression" | "classification";
  trainRows: number;
  testRows: number;
  prediction: string;
  metrics: Array<{ label: string; value: string }>;
};

export function validateImportFile(
  file: Pick<File, "name" | "size" | "type">,
): string | null {
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension !== "csv" && extension !== "tsv") {
    return "Choose a CSV or TSV file. Excel and Parquet import are not included in this prototype.";
  }
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_IMPORT_BYTES) {
    return `The file exceeds this prototype's ${formatBytes(MAX_IMPORT_BYTES)} import limit.`;
  }
  if (
    file.type &&
    ![
      "text/csv",
      "text/tab-separated-values",
      "text/plain",
      "application/vnd.ms-excel",
    ].includes(file.type)
  ) {
    return "The file type does not match a supported text-delimited file.";
  }
  return null;
}

export function parseDelimitedFile(
  contents: string,
  sourceName: string,
): DataTable {
  if (contents.includes("\0"))
    throw new Error(
      "The file contains binary data and cannot be read as CSV or TSV.",
    );

  const delimiter = sourceName.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (
    let index = contents.charCodeAt(0) === 0xfeff ? 1 : 0;
    index < contents.length;
    index += 1
  ) {
    const character = contents[index];
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field.length > 0)
        throw new Error("A quote appeared in the middle of an unquoted field.");
      quoted = true;
    } else if (character === delimiter) {
      pushField(record, field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && contents[index + 1] === "\n") index += 1;
      pushField(record, field);
      field = "";
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      if (records.length > MAX_IMPORT_ROWS + 1)
        throw new Error(
          `The file exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row limit.`,
        );
    } else {
      field += character;
      if (field.length > MAX_CELL_LENGTH)
        throw new Error("A cell exceeds the 32,000-character limit.");
    }
  }

  if (quoted)
    throw new Error(
      "The file ends inside a quoted field. Check the CSV quoting and try again.",
    );
  pushField(record, field);
  if (record.some((value) => value.length > 0)) records.push(record);

  if (records.length < 2)
    throw new Error("Include a header row and at least one data row.");
  if (records.length - 1 > MAX_IMPORT_ROWS)
    throw new Error(
      `The file exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row limit.`,
    );

  const rawHeaders = records[0];
  if (rawHeaders.length > MAX_IMPORT_COLUMNS)
    throw new Error(`The file exceeds the ${MAX_IMPORT_COLUMNS}-column limit.`);
  const columns = makeUniqueHeaders(rawHeaders);
  const rows = records.slice(1).map((row, index) => {
    if (row.length !== columns.length) {
      throw new Error(
        `Row ${index + 2} has ${row.length} fields; expected ${columns.length}. Check the delimiter and quoting.`,
      );
    }
    return row;
  });

  return { sourceName, columns, rows };
}

export function profileTable(table: DataTable): TableProfile {
  const duplicateRows = countDuplicateRows(table.rows);
  const columns = table.columns.map((name, columnIndex): ColumnProfile => {
    const values = table.rows.map((row) => row[columnIndex] ?? "");
    const present = values.filter((value) => value.trim() !== "");
    const frequencies = new Map<string, number>();
    for (const value of present)
      frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
    const numbers = present.map(Number);
    const numeric = present.length > 0 && numbers.every(Number.isFinite);

    return {
      name,
      missing: values.length - present.length,
      unique: frequencies.size,
      numeric,
      minimum: numeric ? Math.min(...numbers) : null,
      maximum: numeric ? Math.max(...numbers) : null,
      mean: numeric
        ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
        : null,
      topValues: [...frequencies.entries()]
        .sort(
          (left, right) =>
            right[1] - left[1] || left[0].localeCompare(right[0]),
        )
        .slice(0, 3)
        .map(([value, count]) => ({ value, count })),
    };
  });

  return {
    rowCount: table.rows.length,
    columnCount: table.columns.length,
    duplicateRows,
    columns,
  };
}

export function filterRows(
  table: DataTable,
  column: string,
  operator: FilterOperator,
  operand: string,
): DataTable {
  const index = table.columns.indexOf(column);
  if (index < 0)
    throw new Error("Choose a column that exists in the current dataset.");
  const numericOperand = Number(operand);

  const rows = table.rows.filter((row) => {
    const value = row[index] ?? "";
    switch (operator) {
      case "equals":
        return value === operand;
      case "contains":
        return value.toLocaleLowerCase().includes(operand.toLocaleLowerCase());
      case "greater":
        return (
          operand.trim() !== "" &&
          value.trim() !== "" &&
          Number.isFinite(Number(value)) &&
          Number(value) > numericOperand
        );
      case "less":
        return (
          operand.trim() !== "" &&
          value.trim() !== "" &&
          Number.isFinite(Number(value)) &&
          Number(value) < numericOperand
        );
      case "empty":
        return value.trim() === "";
      case "not-empty":
        return value.trim() !== "";
    }
  });

  return { ...table, rows };
}

export function aggregateBy(
  table: DataTable,
  groupColumn: string,
  valueColumn: string,
  aggregation: Aggregation,
  limit = 12,
): AggregatePoint[] {
  const groupIndex = table.columns.indexOf(groupColumn);
  const valueIndex = table.columns.indexOf(valueColumn);
  if (groupIndex < 0)
    throw new Error(
      "Choose a grouping column that exists in the current dataset.",
    );
  if (aggregation !== "count" && valueIndex < 0)
    throw new Error(
      "Choose a value column that exists in the current dataset.",
    );
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("The chart limit must be a positive whole number.");

  const groups = new Map<string, { sum: number; records: number }>();
  for (const row of table.rows) {
    const group = row[groupIndex]?.trim() || "(Missing)";
    const current = groups.get(group) ?? { sum: 0, records: 0 };
    if (aggregation === "count") {
      current.records += 1;
    } else {
      const rawValue = row[valueIndex]?.trim() ?? "";
      if (rawValue === "" || !Number.isFinite(Number(rawValue))) continue;
      current.sum += Number(rawValue);
      current.records += 1;
    }
    groups.set(group, current);
  }

  return [...groups.entries()]
    .map(([group, values]) => ({
      group,
      records: values.records,
      value:
        aggregation === "count"
          ? values.records
          : aggregation === "mean"
            ? values.sum / values.records
            : values.sum,
    }))
    .sort(
      (left, right) =>
        right.value - left.value || left.group.localeCompare(right.group),
    )
    .slice(0, limit);
}

export function renameColumn(
  table: DataTable,
  currentName: string,
  nextName: string,
): DataTable {
  const cleanName = nextName.trim();
  const index = table.columns.indexOf(currentName);
  if (index < 0)
    throw new Error("Choose a column that exists in the current dataset.");
  if (!cleanName) throw new Error("Enter a name for the column.");
  if (
    table.columns.some(
      (name, candidate) =>
        candidate !== index && name.toLowerCase() === cleanName.toLowerCase(),
    )
  ) {
    throw new Error("Column names must be unique.");
  }
  const columns = [...table.columns];
  columns[index] = cleanName;
  return { ...table, columns };
}

export function removeColumn(table: DataTable, column: string): DataTable {
  const index = table.columns.indexOf(column);
  if (index < 0)
    throw new Error("Choose a column that exists in the current dataset.");
  if (table.columns.length === 1)
    throw new Error("A dataset must keep at least one column.");
  return {
    ...table,
    columns: table.columns.filter((_, columnIndex) => columnIndex !== index),
    rows: table.rows.map((row) =>
      row.filter((_, columnIndex) => columnIndex !== index),
    ),
  };
}

export function fillMissing(
  table: DataTable,
  column: string,
  replacement: string,
): DataTable {
  const index = table.columns.indexOf(column);
  if (index < 0)
    throw new Error("Choose a column that exists in the current dataset.");
  return {
    ...table,
    rows: table.rows.map((row) =>
      row.map((value, columnIndex) =>
        columnIndex === index && value.trim() === "" ? replacement : value,
      ),
    ),
  };
}

export function trimTextColumn(table: DataTable, column: string): DataTable {
  const index = table.columns.indexOf(column);
  if (index < 0)
    throw new Error("Choose a column that exists in the current dataset.");
  return {
    ...table,
    rows: table.rows.map((row) =>
      row.map((value, columnIndex) =>
        columnIndex === index ? value.trim() : value,
      ),
    ),
  };
}

export function dropDuplicateRows(table: DataTable): DataTable {
  const seen = new Set<string>();
  const rows = table.rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...table, rows };
}

export function dropRowsWithMissingValues(
  table: DataTable,
  columns: string[],
): DataTable {
  if (columns.length === 0)
    throw new Error("Select at least one column to check for missing values.");
  const indexes = columns.map((column) => {
    const index = table.columns.indexOf(column);
    if (index < 0)
      throw new Error(
        `Column "${column}" does not exist in the current dataset.`,
      );
    return index;
  });
  return {
    ...table,
    rows: table.rows.filter((row) =>
      indexes.every((index) => (row[index] ?? "").trim() !== ""),
    ),
  };
}

export function normalizeNumericColumn(
  table: DataTable,
  column: string,
  method: Normalization,
): DataTable {
  const index = table.columns.indexOf(column);
  if (index < 0)
    throw new Error("Choose a column that exists in the current dataset.");
  const values = table.rows.map((row) => row[index] ?? "");
  const numbers = values.filter((value) => value.trim() !== "").map(Number);
  if (numbers.length === 0 || !numbers.every(Number.isFinite)) {
    throw new Error(
      "Normalization requires at least one non-empty numeric value and no non-numeric values.",
    );
  }

  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const deviation = Math.sqrt(
    numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      numbers.length,
  );
  const minimum = Math.min(...numbers);
  const maximum = Math.max(...numbers);
  const rows = table.rows.map((row) =>
    row.map((value, columnIndex) => {
      if (columnIndex !== index || value.trim() === "") return value;
      const number = Number(value);
      const normalized =
        method === "min-max"
          ? maximum === minimum
            ? 0
            : (number - minimum) / (maximum - minimum)
          : deviation === 0
            ? 0
            : (number - mean) / deviation;
      return String(Number(normalized.toPrecision(12)));
    }),
  );

  return { ...table, rows };
}

export function correlationMatrix(
  table: DataTable,
  columns: string[],
): CorrelationMatrix {
  if (columns.length < 2)
    throw new Error("Select at least two numeric columns to compare.");
  if (columns.length > MAX_CORRELATION_COLUMNS) {
    throw new Error(
      `Compare no more than ${MAX_CORRELATION_COLUMNS} columns at a time.`,
    );
  }
  const indexes = columns.map((column) => {
    const index = table.columns.indexOf(column);
    if (index < 0)
      throw new Error(
        `Column "${column}" does not exist in the current dataset.`,
      );
    return index;
  });
  const vectors = indexes.map((columnIndex) =>
    table.rows.map((row) => {
      const text = row[columnIndex]?.trim() ?? "";
      if (text === "") return null;
      const value = Number(text);
      if (!Number.isFinite(value))
        throw new Error(
          "Correlation requires numeric columns. Remove or handle non-numeric values first.",
        );
      return value;
    }),
  );
  const counts = vectors.map(() => vectors.map(() => 0));
  const values = vectors.map((leftValues, leftIndex) =>
    vectors.map((rightValues, rightIndex) => {
      let count = 0;
      let leftSum = 0;
      let rightSum = 0;
      for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
        const left = leftValues[rowIndex];
        const right = rightValues[rowIndex];
        if (left === null || right === null) continue;
        count += 1;
        leftSum += left;
        rightSum += right;
      }
      counts[leftIndex][rightIndex] = count;
      if (count < 2) return null;

      const leftMean = leftSum / count;
      const rightMean = rightSum / count;
      let covariance = 0;
      let leftVariance = 0;
      let rightVariance = 0;
      for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
        const left = leftValues[rowIndex];
        const right = rightValues[rowIndex];
        if (left === null || right === null) continue;
        const leftDelta = left - leftMean;
        const rightDelta = right - rightMean;
        covariance += leftDelta * rightDelta;
        leftVariance += leftDelta ** 2;
        rightVariance += rightDelta ** 2;
      }
      if (leftVariance === 0 || rightVariance === 0) return null;
      return covariance / Math.sqrt(leftVariance * rightVariance);
    }),
  );

  return { columns: [...columns], values, counts };
}

export function joinTables(
  left: DataTable,
  right: DataTable,
  leftKey: string,
  rightKey: string,
  mode: JoinMode,
): DataTable {
  const leftKeyIndex = left.columns.indexOf(leftKey);
  const rightKeyIndex = right.columns.indexOf(rightKey);
  if (leftKeyIndex < 0)
    throw new Error("Choose a join key from the current dataset.");
  if (rightKeyIndex < 0)
    throw new Error("Choose a join key from the second dataset.");

  const appendedIndexes = right.columns
    .map((name, index) => ({ name, index }))
    .filter(({ index }) => index !== rightKeyIndex);
  const existingNames = new Set(
    left.columns.map((name) => name.toLocaleLowerCase()),
  );
  const proposedColumns = [
    ...left.columns,
    ...appendedIndexes.map(({ name }) =>
      existingNames.has(name.toLocaleLowerCase()) ? `${name} (right)` : name,
    ),
  ];
  if (proposedColumns.length > MAX_IMPORT_COLUMNS) {
    throw new Error(`The join exceeds the ${MAX_IMPORT_COLUMNS}-column limit.`);
  }
  const columns = makeUniqueHeaders(proposedColumns);
  const rightRowsByKey = new Map<string, string[][]>();
  for (const row of right.rows) {
    const key = row[rightKeyIndex]?.trim() ?? "";
    if (!key) continue;
    const matches = rightRowsByKey.get(key) ?? [];
    matches.push(row);
    rightRowsByKey.set(key, matches);
  }

  const rows: string[][] = [];
  for (const leftRow of left.rows) {
    const key = leftRow[leftKeyIndex]?.trim() ?? "";
    const matches = key ? rightRowsByKey.get(key) : undefined;
    if (!matches?.length) {
      if (mode === "left")
        rows.push([...leftRow, ...appendedIndexes.map(() => "")]);
    } else {
      for (const rightRow of matches) {
        rows.push([
          ...leftRow,
          ...appendedIndexes.map(({ index }) => rightRow[index] ?? ""),
        ]);
        if (rows.length > MAX_IMPORT_ROWS) {
          throw new Error(
            `The join exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit.`,
          );
        }
      }
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new Error(
        `The join exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit.`,
      );
    }
  }

  return {
    sourceName: `${left.sourceName}+${right.sourceName}`,
    columns,
    rows,
  };
}

export function appendTables(first: DataTable, second: DataTable): DataTable {
  const columns = [...first.columns];
  const seen = new Set(columns.map((name) => name.toLocaleLowerCase()));
  for (const column of second.columns) {
    const key = column.toLocaleLowerCase();
    if (!seen.has(key)) {
      columns.push(column);
      seen.add(key);
    }
  }
  if (columns.length > MAX_IMPORT_COLUMNS) {
    throw new Error(
      `The append exceeds the ${MAX_IMPORT_COLUMNS}-column limit.`,
    );
  }
  if (first.rows.length + second.rows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `The append exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit.`,
    );
  }

  const indexesFor = (table: DataTable) =>
    columns.map((column) =>
      table.columns.findIndex(
        (candidate) =>
          candidate.toLocaleLowerCase() === column.toLocaleLowerCase(),
      ),
    );
  const firstIndexes = indexesFor(first);
  const secondIndexes = indexesFor(second);
  const align = (row: string[], indexes: number[]) =>
    indexes.map((index) => (index < 0 ? "" : (row[index] ?? "")));
  return {
    sourceName: `${first.sourceName}+${second.sourceName}`,
    columns,
    rows: [
      ...first.rows.map((row) => align(row, firstIndexes)),
      ...second.rows.map((row) => align(row, secondIndexes)),
    ],
  };
}

export function evaluateBaseline(
  table: DataTable,
  targetColumn: string,
  task: "regression" | "classification",
): BaselineEvaluation {
  const index = table.columns.indexOf(targetColumn);
  if (index < 0)
    throw new Error(
      "Choose a target column that exists in the current dataset.",
    );
  const values = table.rows
    .map((row) => row[index] ?? "")
    .filter((value) => value.trim() !== "");
  const trainRows = Math.floor(values.length * 0.8);
  const testValues = values.slice(trainRows);
  if (trainRows === 0 || testValues.length === 0)
    throw new Error(
      "Add at least two non-empty target values to evaluate a baseline.",
    );

  if (task === "regression") {
    const numbers = values.map(Number);
    if (!numbers.every(Number.isFinite))
      throw new Error(
        "Regression requires a numeric target column without non-numeric values.",
      );
    const prediction =
      numbers.slice(0, trainRows).reduce((sum, value) => sum + value, 0) /
      trainRows;
    const actual = numbers.slice(trainRows);
    const errors = actual.map((value) => value - prediction);
    const mean = actual.reduce((sum, value) => sum + value, 0) / actual.length;
    const totalVariation = actual.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    );
    const residualVariation = errors.reduce(
      (sum, value) => sum + value ** 2,
      0,
    );
    return {
      task,
      trainRows,
      testRows: actual.length,
      prediction: formatNumber(prediction),
      metrics: [
        {
          label: "MAE",
          value: formatNumber(
            errors.reduce((sum, value) => sum + Math.abs(value), 0) /
              actual.length,
          ),
        },
        {
          label: "RMSE",
          value: formatNumber(Math.sqrt(residualVariation / actual.length)),
        },
        {
          label: "R²",
          value:
            totalVariation === 0
              ? "Not defined"
              : formatNumber(1 - residualVariation / totalVariation),
        },
      ],
    };
  }

  const frequencies = new Map<string, number>();
  for (const value of values.slice(0, trainRows))
    frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  const prediction = [...frequencies.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0][0];
  const correct = testValues.filter((value) => value === prediction).length;
  return {
    task,
    trainRows,
    testRows: testValues.length,
    prediction,
    metrics: [
      {
        label: "Accuracy",
        value: `${((correct / testValues.length) * 100).toFixed(1)}%`,
      },
    ],
  };
}

export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

export function serializeCsv(table: DataTable): string {
  return [table.columns, ...table.rows]
    .map((row) =>
      row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","),
    )
    .join("\r\n");
}

function pushField(record: string[], value: string): void {
  if (value.length > MAX_CELL_LENGTH)
    throw new Error("A cell exceeds the 32,000-character limit.");
  record.push(value);
}

function makeUniqueHeaders(headers: string[]): string[] {
  const seen = new Set<string>();
  return headers.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (seen.has(candidate.toLocaleLowerCase())) {
      candidate = `${base} (${suffix})`;
      suffix += 1;
    }
    seen.add(candidate.toLocaleLowerCase());
    return candidate;
  });
}

function countDuplicateRows(rows: string[][]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

function formatNumber(value: number): string {
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 3 })
    : "Not defined";
}
