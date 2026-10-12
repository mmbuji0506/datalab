import { performance } from 'node:perf_hooks'
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  aggregateBy,
  filterRows,
  parseDelimitedFile,
  profileTable,
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

console.log(JSON.stringify({
  fixture: {
    rows: parsed.result.rows.length,
    columns: parsed.result.columns.length,
    bytes: fixtureBytes,
    limitBytes: MAX_IMPORT_BYTES,
    rowLimit: MAX_IMPORT_ROWS,
  },
  timingsMs: {
    parseMedian: parsed.medianMs,
    profileMedian: profiled.medianMs,
    filterMedian: filtered.medianMs,
    aggregateMedian: aggregated.medianMs,
    highCardinalityAggregateMedian: highCardinality.medianMs,
    exportFilteredRowsMedian: exported.medianMs,
  },
  iterationsPerOperation: parsed.iterations,
  filteredRows: filtered.result.rows.length,
  chartGroups: aggregated.result.length,
  highCardinalityGroupsExamined: MAX_IMPORT_ROWS,
  exportedBytes: Buffer.byteLength(exported.result),
}, null, 2))