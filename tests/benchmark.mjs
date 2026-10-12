import { performance } from 'node:perf_hooks'
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  aggregateBy,
  evaluateBaseline,
  fillMissing,
  filterRows,
  parseDelimitedFile,
  profileTable,
  removeColumn,
  renameColumn,
  serializeCsv,
} from '../src/workbench.ts'

const headers = ['id', 'week', 'region', 'sessions', 'orders', 'revenue']
const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, index) => {
  const sessions = index % 997 === 0 ? '' : String(500 + (index * 37) % 5000)
  const orders = String(10 + (index * 13) % 240)
  const revenue = String(Number(orders) * (15 + index % 40))
  return [String(index + 1), `2026-W${String((Math.floor(index / 7) % 52) + 1).padStart(2, '0')}`, `Region-${String(index % 20).padStart(2, '0')}`, sessions, orders, revenue].join(',')
})
const contents = [headers.join(','), ...rows].join('\n')
const fixtureBytes = Buffer.byteLength(contents)

if (fixtureBytes > MAX_IMPORT_BYTES) {
  throw new Error(`Benchmark fixture is ${fixtureBytes} bytes, above the ${MAX_IMPORT_BYTES}-byte import ceiling.`)
}

function measure(operation, iterations = 5) {
  operation()
  const samples = []
  let result
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now()
    result = operation()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  return { result, medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(1)), iterations }
}

const parsed = measure(() => parseDelimitedFile(contents, 'benchmark.csv'))
const profiled = measure(() => profileTable(parsed.result))
const filtered = measure(() => filterRows(parsed.result, 'region', 'equals', 'Region-03'))
const aggregated = measure(() => aggregateBy(parsed.result, 'region', 'revenue', 'sum'))
const highCardinality = measure(() => aggregateBy(parsed.result, 'id', 'revenue', 'sum'))
const exported = measure(() => serializeCsv(filtered.result))
const prepared = measure(() => removeColumn(
  renameColumn(fillMissing(parsed.result, 'sessions', '0'), 'week', 'period'),
  'id',
))
const regression = measure(() => evaluateBaseline(parsed.result, 'revenue', 'regression'))

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

const dirtyHeaders = ['record_id', 'region', 'class', 'amount', 'note']
const dirtyRows = Array.from({ length: 20_000 }, (_, index) => {
  const sourceIndex = index % 200 === 199 ? index - 1 : index
    const region = ['Nord, coast', 'South', 'East', 'West'][sourceIndex % 4]
  const label = sourceIndex % 3 === 0 ? 'positive' : 'negative'
  const amount = sourceIndex % 13 === 0 ? '' : String((sourceIndex * 19) % 10_000)
  const note = sourceIndex % 53 === 0 ? 'quoted, "review"\nsecond line' : 'standard'
  return [sourceIndex % 19_500, region, label, amount, note].map(quote).join(',')
})
const dirtyContents = [dirtyHeaders.map(quote).join(','), ...dirtyRows].join('\r\n')
const dirtyBytes = Buffer.byteLength(dirtyContents)
if (dirtyBytes > MAX_IMPORT_BYTES) throw new Error('Dirty fixture exceeds the supported import byte ceiling.')
const dirtyParsed = measure(() => parseDelimitedFile(dirtyContents, 'dirty-mixed.csv'))
const dirtyProfile = measure(() => profileTable(dirtyParsed.result))
const dirtyFilled = fillMissing(dirtyParsed.result, 'amount', '0')
const dirtyPrepared = measure(() => filterRows(dirtyFilled, 'region', 'contains', 'o'))
const dirtyClassification = measure(() => evaluateBaseline(dirtyParsed.result, 'class', 'classification'))

const wideHeaders = Array.from({ length: MAX_IMPORT_COLUMNS }, (_, index) => `feature_${index + 1}`)
const wideRows = Array.from({ length: 2_500 }, (_, rowIndex) =>
  wideHeaders.map((_, columnIndex) => String((rowIndex * (columnIndex + 3)) % 100_003)).join(','),
)
const wideContents = [wideHeaders.join(','), ...wideRows].join('\n')
const wideBytes = Buffer.byteLength(wideContents)
if (wideBytes > MAX_IMPORT_BYTES) throw new Error('Wide fixture exceeds the supported import byte ceiling.')
const wideParsed = measure(() => parseDelimitedFile(wideContents, 'wide-100-columns.csv'))
const wideProfile = measure(() => profileTable(wideParsed.result))

console.log(JSON.stringify({
  fixture: {
    rows: parsed.result.rows.length,
    columns: parsed.result.columns.length,
    bytes: fixtureBytes,
    limitBytes: MAX_IMPORT_BYTES,
    rowLimit: MAX_IMPORT_ROWS,
  },
  dirtyFixture: {
    rows: dirtyParsed.result.rows.length,
    columns: dirtyParsed.result.columns.length,
    bytes: dirtyBytes,
    duplicateRows: dirtyProfile.result.duplicateRows,
    missingAmountCells: dirtyProfile.result.columns.find((column) => column.name === 'amount').missing,
    processedRows: dirtyPrepared.result.rows.length,
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
    dirtyParseMedian: dirtyParsed.medianMs,
    dirtyProfileMedian: dirtyProfile.medianMs,
    dirtyFillFilterMedian: dirtyPrepared.medianMs,
    dirtyClassificationMedian: dirtyClassification.medianMs,
    wideParseMedian: wideParsed.medianMs,
    wideProfileMedian: wideProfile.medianMs,
  },
  iterationsPerOperation: parsed.iterations,
  filteredRows: filtered.result.rows.length,
  chartGroups: aggregated.result.length,
  highCardinalityGroupsExamined: MAX_IMPORT_ROWS,
  exportedBytes: Buffer.byteLength(exported.result),
  warmupAndIterationsPerOperation: parsed.iterations,
}, null, 2))