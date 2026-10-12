import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  aggregateBy,
  evaluateBaseline,
  fillMissing,
  filterRows,
  formatBytes,
  parseDelimitedFile,
  profileTable,
  removeColumn,
  renameColumn,
  serializeCsv,
  validateImportFile,
} from '../src/workbench.ts'

test('validates supported text files and import bounds', () => {
  assert.equal(validateImportFile({ name: 'records.csv', size: 4, type: 'text/csv' }), null)
  assert.equal(validateImportFile({ name: 'records.tsv', size: 4, type: '' }), null)
  assert.match(validateImportFile({ name: 'records.xlsx', size: 4, type: '' }), /Choose a CSV or TSV/)
  assert.match(validateImportFile({ name: 'records.csv', size: 0, type: '' }), /empty/)
  assert.match(validateImportFile({ name: 'records.csv', size: MAX_IMPORT_BYTES + 1, type: '' }), /exceeds/)
  assert.match(validateImportFile({ name: 'records.csv', size: 4, type: 'application/json' }), /does not match/)
})

test('parses quoted fields, embedded delimiters, escaped quotes, and newlines', () => {
  const table = parseDelimitedFile('Name,Note\r\nA,"hello,\nworld"\r\nB,"said ""yes"""', 'notes.csv')
  assert.deepEqual(table.columns, ['Name', 'Note'])
  assert.deepEqual(table.rows, [['A', 'hello,\nworld'], ['B', 'said "yes"']])
})

test('parses TSV and normalizes a BOM, blank headers, and duplicate headers', () => {
  const table = parseDelimitedFile('\uFEFFName\tname\t\nA\ta\tX', 'records.tsv')
  assert.deepEqual(table.columns, ['Name', 'name (2)', 'Column 3'])
  assert.deepEqual(table.rows, [['A', 'a', 'X']])
})

test('rejects malformed, binary, ragged, and oversized delimited data', () => {
  assert.throws(() => parseDelimitedFile('id\n\0', 'bad.csv'), /binary data/)
  assert.throws(() => parseDelimitedFile('id\n"unfinished', 'bad.csv'), /inside a quoted field/)
  assert.throws(() => parseDelimitedFile('id,note\n1,ok\n2', 'bad.csv'), /expected 2/)
  assert.throws(() => parseDelimitedFile('id', 'header-only.csv'), /header row and at least one data row/)
  assert.throws(() => parseDelimitedFile(`id\n${'x'.repeat(32_001)}`, 'long.csv'), /32,000-character/)
  const manyColumns = `${Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, index) => `c${index}`).join(',')}\n${Array(MAX_IMPORT_COLUMNS + 1).fill('x').join(',')}`
  assert.throws(() => parseDelimitedFile(manyColumns, 'wide.csv'), /column limit/)
  const manyRows = `id\n${Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => index).join('\n')}`
  assert.throws(() => parseDelimitedFile(manyRows, 'long.csv'), /row limit/)
})

test('profiles missing values, unique values, numeric ranges, means, and duplicates', () => {
  const table = parseDelimitedFile('name,score\nA,1\nB,\nA,1\nA,3', 'profile.csv')
  const profile = profileTable(table)
  assert.equal(profile.rowCount, 4)
  assert.equal(profile.columnCount, 2)
  assert.equal(profile.duplicateRows, 1)
  assert.equal(profile.columns[0].unique, 2)
  assert.equal(profile.columns[0].numeric, false)
  assert.equal(profile.columns[1].missing, 1)
  assert.equal(profile.columns[1].minimum, 1)
  assert.equal(profile.columns[1].maximum, 3)
  assert.equal(profile.columns[1].mean, 5 / 3)
})

test('filters rows with every supported operator', () => {
  const table = parseDelimitedFile('id,type,score\n1,alpha,2\n2,beta,10\n3,alpha,\n4,,5', 'filter.csv')
  assert.equal(filterRows(table, 'type', 'equals', 'alpha').rows.length, 2)
  assert.equal(filterRows(table, 'type', 'contains', 'PH').rows.length, 2)
  assert.equal(filterRows(table, 'score', 'greater', '4').rows.length, 2)
  assert.equal(filterRows(table, 'score', 'less', '5').rows.length, 1)
  assert.equal(filterRows(table, 'type', 'empty', '').rows.length, 1)
  assert.equal(filterRows(table, 'type', 'not-empty', '').rows.length, 3)
  assert.throws(() => filterRows(table, 'missing', 'equals', 'x'), /column that exists/)
})

test('aggregates groups by sum, mean, or row count and sorts the top groups', () => {
  const table = parseDelimitedFile('region,revenue\nNorth,10\nSouth,4\nNorth,\nSouth,6\nWest,3', 'chart.csv')
  assert.deepEqual(aggregateBy(table, 'region', 'revenue', 'sum'), [
    { group: 'North', value: 10, records: 1 },
    { group: 'South', value: 10, records: 2 },
    { group: 'West', value: 3, records: 1 },
  ])
  assert.deepEqual(aggregateBy(table, 'region', 'revenue', 'mean').map(({ group, value }) => ({ group, value })), [
    { group: 'North', value: 10 }, { group: 'South', value: 5 }, { group: 'West', value: 3 },
  ])
  assert.deepEqual(aggregateBy(table, 'region', 'unused', 'count').map(({ group, value }) => ({ group, value })), [
    { group: 'North', value: 2 }, { group: 'South', value: 2 }, { group: 'West', value: 1 },
  ])
  assert.equal(aggregateBy(table, 'region', 'revenue', 'sum', 2).length, 2)
  assert.throws(() => aggregateBy(table, 'missing', 'revenue', 'sum'), /grouping column/)
  assert.throws(() => aggregateBy(table, 'region', 'missing', 'mean'), /value column/)
  assert.throws(() => aggregateBy(table, 'region', 'revenue', 'sum', 0), /positive whole number/)
})

test('renames columns while enforcing a unique non-empty name', () => {
  const table = parseDelimitedFile('name,score\nA,1', 'rename.csv')
  assert.deepEqual(renameColumn(table, 'name', 'label').columns, ['label', 'score'])
  assert.throws(() => renameColumn(table, 'name', ' score '), /must be unique/)
  assert.throws(() => renameColumn(table, 'name', '  '), /Enter a name/)
  assert.throws(() => renameColumn(table, 'absent', 'label'), /column that exists/)
})

test('fills empty cells without changing present values', () => {
  const table = parseDelimitedFile('name,score\nA,1\nB,\nC,  ', 'fill.csv')
  assert.deepEqual(fillMissing(table, 'score', '0').rows, [['A', '1'], ['B', '0'], ['C', '0']])
  assert.throws(() => fillMissing(table, 'missing', '0'), /column that exists/)
})

test('removes a column and protects the final remaining column', () => {
  const table = parseDelimitedFile('name,score\nA,1', 'remove.csv')
  assert.deepEqual(removeColumn(table, 'score'), { ...table, columns: ['name'], rows: [['A']] })
  assert.throws(() => removeColumn(table, 'absent'), /column that exists/)
  assert.throws(() => removeColumn({ ...table, columns: ['name'], rows: [['A']] }, 'name'), /keep at least one column/)
})

test('evaluates a mean regression baseline over an ordered 80/20 split', () => {
  const table = parseDelimitedFile('target\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10', 'regression.csv')
  const result = evaluateBaseline(table, 'target', 'regression')
  assert.equal(result.trainRows, 8)
  assert.equal(result.testRows, 2)
  assert.equal(result.prediction, '4.5')
  assert.deepEqual(result.metrics.map((metric) => metric.label), ['MAE', 'RMSE', 'R²'])
  assert.equal(result.metrics[0].value, '5')
  assert.equal(result.metrics[1].value, '5.025')
})

test('evaluates a majority-class baseline and validates targets', () => {
  const table = parseDelimitedFile('target\nyes\nyes\nyes\nyes\nyes\nyes\nyes\nyes\nno\nno', 'classification.csv')
  const result = evaluateBaseline(table, 'target', 'classification')
  assert.equal(result.prediction, 'yes')
  assert.equal(result.metrics[0].label, 'Accuracy')
  assert.equal(result.metrics[0].value, '0.0%')
  assert.throws(() => evaluateBaseline(table, 'missing', 'classification'), /target column/)
  assert.throws(() => evaluateBaseline(table, 'target', 'regression'), /numeric target/)
  assert.throws(() => evaluateBaseline(parseDelimitedFile('target\n1', 'short.csv'), 'target', 'regression'), /at least two/)
})

test('formats file sizes for the import summary', () => {
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MiB')
  assert.equal(formatBytes(0), '0 MiB')
})

test('serializes CSV with escaped quotes and CRLF records', () => {
  const table = parseDelimitedFile('name,note\nA,"said ""yes"""', 'export.csv')
  assert.equal(serializeCsv(table), '"name","note"\r\n"A","said ""yes"""')
})