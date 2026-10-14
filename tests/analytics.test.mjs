import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeColumn,
  analyzeTable,
  assessQuality,
  averageRanks,
  buildHistogram,
  convertToNumber,
  correlate,
  correlationPValue,
  extractDateParts,
  harmonizeCategories,
  imputeColumn,
  oneHotEncode,
  parseDateParts,
  parseLooseNumber,
  quantileSorted,
  standardizeMissing,
  summarizeNumbers,
  treatOutliers,
} from "../src/analytics.ts";
import { parseDelimitedFile } from "../src/workbench.ts";
import { applyStep } from "../src/recipe.ts";

const close = (actual, expected, tolerance = 1e-9, label = "") =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${label} expected ${expected}, got ${actual}`,
  );

// Oracle values below were produced by numpy 2.4 / scipy 1.17, not by this code.

test("summary statistics match numpy and scipy (quartiles, std, skew, IQR outliers)", () => {
  const summary = summarizeNumbers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50]);
  close(summary.mean, 9.545454545454545);
  close(summary.std, 13.721250936876245);
  close(summary.q1, 3.5);
  close(summary.median, 6);
  close(summary.q3, 8.5);
  close(summary.iqr, 5);
  close(summary.skewness, 3.053660958363839);
  close(summary.lowerFence, -4);
  close(summary.upperFence, 16);
  assert.equal(summary.outliers, 1);
});

test("summary statistics handle degenerate inputs without NaN", () => {
  assert.equal(summarizeNumbers([]), null);
  const single = summarizeNumbers([7]);
  assert.equal(single.std, null);
  assert.equal(single.skewness, null);
  assert.equal(single.outliers, 0);
  const flat = summarizeNumbers([3, 3, 3, 3]);
  assert.equal(flat.std, 0);
  assert.equal(flat.skewness, null);
  assert.equal(flat.outliers, 0, "zero IQR must not flag everything as an outlier");
  assert.ok(Number.isNaN(quantileSorted([], 0.5)));
  assert.equal(quantileSorted([5], 0.9), 5);
});

test("histograms conserve every value and include the maximum", () => {
  const values = [1, 2, 2, 3, 9, 10, 10, 10, 4, 5, 6];
  const bins = buildHistogram(values);
  assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), values.length);
  assert.equal(bins[0].start, 1);
  assert.equal(bins.at(-1).end, 10);
  assert.ok(bins.at(-1).count >= 3, "the maximum belongs to the last bin");
  assert.deepEqual(buildHistogram([4, 4, 4]), [{ start: 4, end: 4, count: 3 }]);
  assert.deepEqual(buildHistogram([]), []);
});

test("average ranks match scipy.stats.rankdata for ties", () => {
  assert.deepEqual(averageRanks([10, 20, 20, 30, 10, 40, 20]), [1.5, 4, 4, 6, 1.5, 7, 4]);
});

test("correlation p-values match the Student-t reference across sample sizes", () => {
  const oracle = [
    [0.5, 10, 0.14111328125000006],
    [0.9, 6, 0.014499999999999985],
    [0.1, 100, 0.32221736303061954],
    [-0.75, 8, 0.03210449218749999],
    [0.99, 30, 2.304085772340054e-25],
    [0.3, 3, 0.8060266319586435],
    [0.05, 5000, 0.00040491100765611325],
  ];
  for (const [r, n, expected] of oracle) {
    const actual = correlationPValue(r, n);
    assert.ok(
      Math.abs(actual - expected) <= 1e-7 * Math.max(expected, 1e-30) + 1e-12,
      `r=${r} n=${n}: expected ${expected}, got ${actual}`,
    );
  }
  assert.equal(correlationPValue(1, 10), 0);
  assert.equal(correlationPValue(0.5, 2), null, "two points cannot support a test");
  assert.equal(correlationPValue(Number.NaN, 10), null);
});

test("Pearson and Spearman (with ties and an outlier) match scipy", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const b = [2, 1, 4, 3, 7, 7, 8, 9, 12, 30, 11, 15];
  const table = {
    sourceName: "c.csv",
    columns: ["a", "b"],
    rows: a.map((value, index) => [String(value), String(b[index])]),
  };
  const pearson = correlate(table, ["a", "b"], "pearson");
  close(pearson.values[0][1], 0.7527282642419469);
  close(pearson.pValues[0][1], 0.004723145014031658, 1e-7);
  const spearman = correlate(table, ["a", "b"], "spearman");
  close(spearman.values[0][1], 0.9492133645984593);
  close(spearman.pValues[0][1], 2.4427417276402144e-6, 1e-6);
  assert.ok(spearman.values[0][1] > pearson.values[0][1], "Spearman resists the outlier");
  assert.equal(spearman.method, "spearman");
  close(spearman.values[0][0], 1);
});

test("Spearman ranks only complete pairs and reports constant columns as undefined", () => {
  const table = parseDelimitedFile("x,y,flat\n1,10,5\n2,,5\n3,30,5\n4,20,5\n5,50,5", "m.csv");
  const result = correlate(table, ["x", "y", "flat"], "spearman");
  assert.equal(result.counts[0][1], 4);
  assert.equal(result.values[0][2], null);
  assert.equal(result.pValues[0][2], null);
  assert.throws(() => correlate(table, ["x"], "spearman"), /at least two/);
});

test("loose number parsing handles currency, thousands, percent, and rejects ambiguity", () => {
  assert.equal(parseLooseNumber("$1,200"), 1200);
  assert.equal(parseLooseNumber("TZS 5,000"), 5000);
  assert.equal(parseLooseNumber("€ 12.50"), 12.5);
  assert.equal(parseLooseNumber("12%"), 0.12);
  assert.equal(parseLooseNumber("57%"), 0.57);
  assert.equal(parseLooseNumber("(1,200)"), -1200);
  assert.equal(parseLooseNumber("-$5"), -5);
  assert.equal(parseLooseNumber("42"), 42);
  assert.equal(parseLooseNumber("1,5"), null, "European decimals are ambiguous and rejected");
  assert.equal(parseLooseNumber("1.234.567"), null);
  assert.equal(parseLooseNumber("0x1A"), null);
  assert.equal(parseLooseNumber(""), null);
  assert.equal(parseLooseNumber("abc"), null);
});

test("ISO dates validate real calendar days and weekdays match Python", () => {
  const oracle = { "2026-10-13": 2, "2024-02-29": 4, "2000-01-01": 6, "2026-01-04": 7 };
  for (const [text, weekday] of Object.entries(oracle))
    assert.equal(parseDateParts(text).weekday, weekday, text);
  assert.deepEqual(parseDateParts("2026/03/09 14:30:05"), { year: 2026, month: 3, day: 9, weekday: 1 });
  for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "26-01-01", "2026-W01", "2026-01-01T25:00"])
    assert.equal(parseDateParts(bad), null, bad);
});

const typeOf = (name, values, rows = values.length) => analyzeColumn(name, values, rows).type;

test("column types are inferred from content and name", () => {
  assert.equal(typeOf("a", ["", " "]), "empty");
  assert.equal(typeOf("a", ["x", "x", "x"]), "constant");
  assert.equal(typeOf("a", ["yes", "no", "yes"]), "boolean");
  assert.equal(typeOf("a", ["0", "1", "1", "0"]), "boolean");
  assert.equal(typeOf("when", ["2026-01-01", "2026-01-02", "2026-02-03"]), "date");
  assert.equal(typeOf("count", ["1", "5", "9", "5"]), "integer");
  assert.equal(typeOf("price", ["1.5", "2", "9.25"]), "numeric");
  assert.equal(typeOf("customer_id", ["101", "102", "103", "101"]), "identifier");
  const names = Array.from({ length: 20 }, (_, index) => `person-${index}`);
  assert.equal(typeOf("name", names), "identifier");
  const tiers = Array.from({ length: 40 }, (_, index) => ["gold", "silver", "bronze"][index % 3]);
  assert.equal(typeOf("tier", tiers), "categorical");
  const notes = Array.from({ length: 200 }, (_, index) => `free text ${index % 80}`);
  assert.equal(typeOf("notes", notes), "text", "many repeated phrases: high-cardinality text");
  const nearUnique = Array.from({ length: 60 }, (_, index) => `free text ${index % 58}`);
  assert.equal(typeOf("notes", nearUnique, 200), "identifier", "almost every row differs");
  assert.equal(typeOf("revenue", ["4920", "3660", "5460", "2640"]), "integer", "unique measures are not identifiers");
});

test("hex-like codes are never typed as numbers", () => {
  const column = analyzeColumn("code", ["0x1A", "0b11", "0o17", "1e3"]);
  assert.equal(column.numeric, false);
  assert.equal(column.stats, null);
});

test("data-hygiene flags: whitespace, markers, spellings, formatted numbers", () => {
  const spaced = analyzeColumn("a", ["x", "y ", " z"]);
  assert.equal(spaced.whitespaceValues, 2);
  const tokens = analyzeColumn("age", ["31", "N/A", "28", "null", "40"]);
  assert.equal(tokens.missingTokens, 2);
  assert.equal(tokens.numericAfterTokenCleanup, true);
  assert.equal(tokens.numeric, false);
  const spellings = analyzeColumn("c", ["Paid", "paid", " PAID", "Free", "free", "Other"]);
  assert.equal(spellings.caseVariantGroups, 2);
  const money = analyzeColumn("price", ["$1,200", "950", "$1,050"]);
  assert.equal(money.looseNumeric, true);
  assert.equal(analyzeColumn("price", ["1200", "950"]).looseNumeric, false);
  const ambiguous = analyzeColumn("price", ["1,5", "2,5"]);
  assert.equal(ambiguous.looseNumeric, false);
});

test("imputation uses mean, median, or mode and refuses unsafe requests", () => {
  const table = parseDelimitedFile("n,t\n1,a\n,a\n3,b\n10,\n,b", "i.csv");
  const column = (result, name) => result.rows.map((row) => row[result.columns.indexOf(name)]);
  assert.deepEqual(column(imputeColumn(table, "n", "median"), "n"), ["1", "3", "3", "10", "3"]);
  assert.deepEqual(column(imputeColumn(table, "n", "mean"), "n"), ["1", "4.66666666667", "3", "10", "4.66666666667"]);
  assert.deepEqual(column(imputeColumn(table, "t", "mode"), "t"), ["a", "a", "b", "a", "b"]);
  assert.throws(() => imputeColumn(table, "t", "mean"), /numeric column/);
  assert.throws(() => imputeColumn({ ...table, rows: [[""], [""]], columns: ["x"] }, "x", "mode"), /no values/);
  assert.equal(table.rows[1][0], "", "the input table is not mutated");
});

test("missing markers become blanks; formatted numbers convert all-or-nothing", () => {
  const table = parseDelimitedFile("a\nN/A\n5\nnull\n7", "m.csv");
  assert.deepEqual(standardizeMissing(table, "a").rows, [[""], ["5"], [""], ["7"]]);
  const money = parseDelimitedFile('p,q\n"$1,200",a\n12%,b\n,c\n(5),d', "p.csv");
  assert.deepEqual(convertToNumber(money, "p").rows, [["1200", "a"], ["0.12", "b"], ["", "c"], ["-5", "d"]]);
  const mixed = parseDelimitedFile("p\n$5\nabc", "q.csv");
  assert.throws(() => convertToNumber(mixed, "p"), /"abc" cannot be read/);
});

test("spelling variants merge into the most common form", () => {
  const table = parseDelimitedFile("c\nPaid\npaid\npaid\n PAID \nFree\nfree\nOther\n", "h.csv");
  const result = harmonizeCategories(table, "c");
  assert.deepEqual(
    result.rows.map((row) => row[0]),
    ["paid", "paid", "paid", "paid", "Free", "Free", "Other"],
    "ties break alphabetically (uppercase sorts first); the most common wins otherwise",
  );
});

test("outliers can be capped or removed using IQR fences", () => {
  const table = parseDelimitedFile("v\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n50\n", "o.csv");
  const capped = treatOutliers(table, "v", "cap");
  assert.equal(capped.rows.at(-1)[0], "16");
  assert.equal(capped.rows.length, 11);
  const removed = treatOutliers(table, "v", "remove");
  assert.equal(removed.rows.length, 10);
  assert.throws(() => treatOutliers(table, "v", "cap", 0), /greater than zero/);
  const flat = parseDelimitedFile("v\n5\n5\n5\n", "f.csv");
  assert.deepEqual(treatOutliers(flat, "v", "remove").rows, flat.rows, "zero IQR changes nothing");
  assert.throws(() => treatOutliers(parseDelimitedFile("v\na\nb", "t.csv"), "v", "cap"), /numeric/);
});

test("one-hot encoding orders by frequency, handles blanks, and enforces limits", () => {
  const table = parseDelimitedFile("id,color\n1,red\n2,blue\n3,red\n4,\n5,green\n6,red", "e.csv");
  const encoded = oneHotEncode(table, "color");
  assert.deepEqual(encoded.columns, ["id", "color=red", "color=blue", "color=green"]);
  assert.deepEqual(encoded.rows[3], ["4", "0", "0", "0"], "a blank is all zeros");
  assert.deepEqual(encoded.rows[0], ["1", "1", "0", "0"]);
  assert.equal(oneHotEncode(table, "color", 20, true).columns.length, 5);
  assert.throws(() => oneHotEncode(table, "color", 2), /3 categories/);
  const clash = parseDelimitedFile("color,color=red\nred,1\nblue,2", "c.csv");
  assert.deepEqual(
    oneHotEncode(clash, "color").columns,
    ["color=red", "color=blue", "color=red (2)"],
    "equal counts sort alphabetically; a clashing name gets a suffix",
  );
});

test("date parts add four columns and reject non-dates", () => {
  const table = parseDelimitedFile("d,n\n2026-10-13,1\n,2\n2024-02-29,3", "d.csv");
  const result = extractDateParts(table, "d");
  assert.deepEqual(result.columns, ["d", "n", "d (year)", "d (month)", "d (day)", "d (weekday)"]);
  assert.deepEqual(result.rows[0], ["2026-10-13", "1", "2026", "10", "13", "2"]);
  assert.deepEqual(result.rows[1], ["", "2", "", "", "", ""]);
  assert.deepEqual(result.rows[2].slice(2), ["2024", "2", "29", "4"]);
  assert.throws(
    () => extractDateParts(parseDelimitedFile("d,n\n2026-10-13,1\nsoon,2", "x.csv"), "d"),
    /not an ISO date/,
  );
});

const DIRTY = [
  "id,region,sales,age,note,joined",
  "1,North,100,31,ok,2026-01-05",
  '2,north ,"$1,200",N/A,N/A,2026-01-06',
  "3,South,300,28,ok,2026-02-07",
  "4,South,,40,ok,2026-02-08",
  "5,South,300,29,ok,2026-02-09",
  "6,South,310,30,ok,2026-02-10",
  "6,South,310,30,ok,2026-02-10",
].join("\n");

test("a clean table scores 100 with no actionable issues", () => {
  const rows = Array.from({ length: 40 }, (_, index) => [String(index * 3 + (index % 5)), ["a", "b"][index % 2]]);
  const table = { sourceName: "clean.csv", columns: ["x", "kind"], rows };
  const report = assessQuality(table);
  assert.equal(report.score, 100);
  assert.deepEqual(report.issues.filter((issue) => issue.severity !== "info"), []);
});

test("a messy table is flagged with concrete, fixable issues and a lower score", () => {
  const table = parseDelimitedFile(DIRTY, "dirty.csv");
  const report = assessQuality(table);
  const ids = report.issues.map((issue) => issue.id);
  for (const expected of [
    "missing:sales",
    "tokens:age",
    "tokens:note",
    "loose:sales",
    "space:region",
    "case:region",
    "duplicates",
    "date:joined",
  ])
    assert.ok(ids.includes(expected), `missing issue ${expected}; got ${ids.join(", ")}`);
  assert.ok(report.score < 100 && report.score > 0);
  const severities = report.issues.map((issue) => issue.severity);
  const order = ["high", "medium", "low", "info"];
  assert.deepEqual(severities, [...severities].sort((l, r) => order.indexOf(l) - order.indexOf(r)));
  for (const part of Object.values(report.components)) assert.ok(part >= 0 && part <= 100);
});

test("every suggested fix resolves its issue, and repeated rounds converge to a clean table", () => {
  let table = parseDelimitedFile(DIRTY, "dirty.csv");
  const initial = assessQuality(table);
  let applied = 0;
  // Fixing one problem can reveal another (a cleared "N/A" becomes a real
  // blank), so run rounds until nothing actionable is left.
  for (let round = 0; round < 6; round += 1) {
    const actionable = assessQuality(table).issues.filter(
      (issue) => issue.fix && issue.severity !== "info",
    );
    if (actionable.length === 0) break;
    for (const target of actionable) {
      const current = assessQuality(table).issues.find((issue) => issue.id === target.id);
      if (!current) continue;
      table = applyStep(table, current.fix);
      applied += 1;
      const after = assessQuality(table).issues.map((issue) => issue.id);
      assert.ok(!after.includes(target.id), `fix "${target.fixLabel}" did not resolve ${target.id}`);
    }
  }
  const final = assessQuality(table);
  assert.ok(applied >= 6, `expected several fixes, applied ${applied}`);
  assert.equal(final.issues.filter((issue) => issue.fix && issue.severity !== "info").length, 0);
  assert.ok(final.score > initial.score, `score should improve: ${initial.score} -> ${final.score}`);
  assert.ok(final.score >= 95, `a fully cleaned table should score high, got ${final.score}`);
});

test("tie-breaks that rewrite data do not depend on the runtime locale", () => {
  const table = parseDelimitedFile("c\nfree\nFree\nzeta\nZeta\n", "t.csv");
  assert.deepEqual(
    harmonizeCategories(table, "c").rows.map((row) => row[0]),
    ["Free", "Free", "Zeta", "Zeta"],
    "uppercase code units sort first, in every locale",
  );
  assert.equal(imputeColumn({ sourceName: "m", columns: ["c"], rows: [["b"], ["a"], [""]] }, "c", "mode").rows[2][0], "a");
});

test("table analysis counts duplicates and reports per-column insight", () => {
  const insight = analyzeTable(parseDelimitedFile(DIRTY, "dirty.csv"));
  assert.equal(insight.rowCount, 7);
  assert.equal(insight.duplicateRows, 1);
  assert.equal(insight.columns.length, 6);
  assert.equal(insight.columns.find((column) => column.name === "id").type, "identifier");
});

test("ORACLE: Spearman on pairwise-complete rows matches scipy, and the matrix is symmetric", () => {
  const nan = "";
  const table = {
    sourceName: "p.csv",
    columns: ["x", "y", "z"],
    rows: [
      ["1", "10", "5"], ["2", nan, "4"], ["3", "30", nan], ["4", "20", "2"],
      ["5", "50", "2"], ["6", "45", "1"], ["7", nan, "0"],
    ],
  };
  const result = correlate(table, ["x", "y", "z"], "spearman");
  close(result.values[0][1], 0.7999999999999999, 1e-12, "x~y");
  close(result.values[0][2], -0.9856107606091623, 1e-12, "x~z");
  close(result.values[1][2], -0.632455532033676, 1e-12, "y~z");
  close(result.pValues[0][1], 0.10408803866182788, 1e-7, "p x~y");
  close(result.pValues[0][2], 0.00030908566784966984, 1e-6, "p x~z");
  close(result.pValues[1][2], 0.367544467966324, 1e-7, "p y~z");
  assert.deepEqual([result.counts[0][1], result.counts[0][2], result.counts[1][2]], [5, 6, 4]);
  for (let row = 0; row < 3; row += 1)
    for (let column = 0; column < 3; column += 1) {
      assert.equal(result.values[row][column], result.values[column][row], "symmetric");
      assert.equal(result.pValues[row][column], result.pValues[column][row]);
    }
  close(result.values[1][1], 1, 1e-12, "diagonal");
});

test("Spearman gives the same answer whether ranks are shared or computed per pair", () => {
  const rows = Array.from({ length: 40 }, (_, i) => [String((i * 7) % 11), String((i * 5) % 13), String(i % 6)]);
  const complete = { sourceName: "a", columns: ["a", "b", "c"], rows };
  // Adding a blank to a *fourth* column forces nothing for a/b/c; blanking a cell of c forces the pairwise path for c only.
  const blanked = { ...complete, rows: rows.map((row, i) => (i === 39 ? [row[0], row[1], ""] : row)) };
  const shared = correlate(complete, ["a", "b"], "spearman");
  const viaPairs = correlate({ ...blanked, rows: blanked.rows.map((row) => row) }, ["a", "b"], "spearman");
  assert.deepEqual(shared.values, viaPairs.values, "a~b unaffected by a blank in an unrelated column");
});

test("missing-value suggestions warn that filling a prediction target invents answers", () => {
  const table = parseDelimitedFile("n,t\n1,a\n,a\n3,b\n10,\n5,b\n", "w.csv");
  const issues = assessQuality(table).issues.filter((issue) => issue.id.startsWith("missing:"));
  assert.equal(issues.length, 2);
  for (const issue of issues) {
    assert.match(issue.detail, /column you want to predict/, issue.id);
    assert.match(issue.detail, /remove these rows instead/, issue.id);
  }
});
