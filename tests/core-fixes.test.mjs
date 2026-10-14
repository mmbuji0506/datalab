import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateBy,
  correlationMatrix,
  detectDelimiter,
  evaluateBaseline,
  filterRows,
  looksLikeFormula,
  normalizeNumericColumn,
  parseDelimitedFile,
  parseNumber,
  profileTable,
  serializeCsv,
} from "../src/workbench.ts";

test("strict number parsing accepts decimals and rejects JavaScript number quirks", () => {
  const accepted = { "42": 42, " 12 ": 12, "-3.5": -3.5, "+3": 3, ".5": 0.5, "5.": 5, "1e3": 1000, "-2.5E-2": -0.025 };
  for (const [text, value] of Object.entries(accepted)) assert.equal(parseNumber(text), value, text);
  for (const text of ["0x1A", "0b11", "0o17", "Infinity", "-Infinity", "NaN", "1e999", "1_000", "--1", "1,5", "", "  ", "1 2", "٣"])
    assert.equal(parseNumber(text), null, JSON.stringify(text));
});

test("REGRESSION: hex/binary/octal text is not silently treated as numeric anywhere", () => {
  const table = parseDelimitedFile("id,code\n1,0x1A\n2,0b11\n3,0o17\n4,1e3\n", "a.csv");
  const code = profileTable(table).columns[1];
  assert.equal(code.numeric, false);
  assert.equal(code.mean, null);
  assert.equal(filterRows(table, "code", "greater", "5").rows.length, 1, "only 1e3 is a real number");
  assert.throws(() => normalizeNumericColumn(table, "code", "min-max"), /numeric/);
  assert.throws(() => correlationMatrix(table, ["id", "code"]), /numeric columns/);
  assert.throws(() => evaluateBaseline(table, "code", "regression"), /numeric target/);
  const sums = aggregateBy(table, "id", "code", "sum");
  assert.deepEqual(sums.map((point) => point.group), ["4"], "non-numeric measures never contribute to sums");
});

test("delimiter detection finds semicolon, pipe, and tab files and keeps comma as the default", () => {
  assert.deepEqual(parseDelimitedFile("name;age;city\nAna;31;Dar\nJo;28;Arusha\n", "eu.csv").columns, ["name", "age", "city"]);
  assert.equal(parseDelimitedFile("a|b\n1|2\n", "p.csv").delimiter, "|");
  assert.equal(parseDelimitedFile("a\tb\n1\t2\n", "tabs.csv").delimiter, "\t");
  assert.equal(parseDelimitedFile("a,b\n1,2\n", "c.csv").delimiter, ",");
  assert.equal(detectDelimiter("a;b\n1;2", "x.tsv"), "\t", ".tsv is always tab-separated");
  assert.equal(detectDelimiter("solo\n1\n2", "s.csv"), ",", "single column falls back to comma");
});

test("delimiter detection ignores delimiters inside quotes and decimal commas", () => {
  const quoted = parseDelimitedFile('name;note\nAna;"a, b, c"\nJo;"x, y"\n', "q.csv");
  assert.deepEqual(quoted.rows, [["Ana", "a, b, c"], ["Jo", "x, y"]]);
  const decimals = parseDelimitedFile("price;qty\n3,5;2\n4,25;7\n", "d.csv");
  assert.deepEqual(decimals.columns, ["price", "qty"]);
  assert.deepEqual(decimals.rows[0], ["3,5", "2"], "decimal commas survive as text for explicit conversion");
});

test("ragged comma files still report the original row error instead of guessing", () => {
  assert.throws(() => parseDelimitedFile("id,note\n1,ok\n2", "bad.csv"), /Row 3 has 1 fields; expected 2/);
  assert.equal(detectDelimiter("a,b\n1\n2,3,4\n5", "r.csv"), ",");
});

test("an explicit delimiter overrides detection", () => {
  const table = parseDelimitedFile("a;b,c\n1;2,3\n", "o.csv", { delimiter: "," });
  assert.deepEqual(table.columns, ["a;b", "c"]);
});

test("looksLikeFormula only flags executable-looking text, not numbers or lone signs", () => {
  for (const risky of ["=1+1", "@SUM(A1)", "+cmd|' /C calc'!A0", "-2+3", "\tcmd", "\rcmd", "-abc", '=HYPERLINK("http://x")'])
    assert.equal(looksLikeFormula(risky), true, risky);
  for (const safe of ["-5", "+5", "-0.25", "-1e3", "-", "+", "plain", "a=b", "", " =x"])
    assert.equal(looksLikeFormula(safe), false, JSON.stringify(safe));
});

test("REGRESSION: export neutralizes spreadsheet formulas by default", () => {
  const table = { sourceName: "x.csv", columns: ["v"], rows: [["=1+1"], ["-5"], ["@x"], ["ok"]] };
  assert.equal(serializeCsv(table), '"v"\r\n"\'=1+1"\r\n"-5"\r\n"\'@x"\r\n"ok"');
  assert.equal(serializeCsv(table, { neutralizeFormulas: false }), '"v"\r\n"=1+1"\r\n"-5"\r\n"@x"\r\n"ok"');
});

function mulberry(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("FUZZ: 300 random tables survive export and re-import unchanged", () => {
  const random = mulberry(20260413);
  const pieces = ["a", "B", "7", " ", "  ", ",", ";", "|", "\t", '"', '""', "\n", "\r\n", "é", "日本", "😀", "=", "-", "x y"];
  const make = () => {
    let text = "";
    const length = Math.floor(random() * 6);
    for (let index = 0; index < length; index += 1) text += pieces[Math.floor(random() * pieces.length)];
    return text;
  };
  for (let round = 0; round < 300; round += 1) {
    const width = 1 + Math.floor(random() * 5);
    const columns = Array.from({ length: width }, (_, index) => `col${index}`);
    const rows = [];
    const height = 1 + Math.floor(random() * 8);
    while (rows.length < height) {
      const row = Array.from({ length: width }, make);
      if (row.some((value) => value.length > 0)) rows.push(row); // the parser skips all-empty rows
    }
    const original = { sourceName: "fuzz.csv", columns, rows };
    const text = serializeCsv(original, { neutralizeFormulas: false });
    const restored = parseDelimitedFile(text, "fuzz.csv");
    assert.deepEqual(restored.columns, columns, `round ${round} columns`);
    assert.deepEqual(restored.rows, rows, `round ${round}: ${JSON.stringify(text)}`);
  }
});

test("the profile of a 50,000-row column does not overflow the call stack", () => {
  const rows = Array.from({ length: 50_000 }, (_, index) => [String(index)]);
  const profile = profileTable({ sourceName: "big.csv", columns: ["n"], rows }).columns[0];
  assert.equal(profile.minimum, 0);
  assert.equal(profile.maximum, 49_999);
});
