export const MAX_IMPORT_BYTES = 25 * 1024 * 1024
export const MAX_IMPORT_ROWS = 50_000
export const MAX_IMPORT_COLUMNS = 100
const MAX_CELL_LENGTH = 32_000

export type DataTable = {
  sourceName: string
  columns: string[]
  rows: string[][]
}

export type ColumnProfile = {
  name: string
  missing: number
  unique: number
  numeric: boolean
  minimum: number | null
  maximum: number | null
  mean: number | null
  topValues: Array<{ value: string; count: number }>
}

export type TableProfile = {
  rowCount: number
  columnCount: number
  duplicateRows: number
  columns: ColumnProfile[]
}

export type FilterOperator = 'equals' | 'contains' | 'greater' | 'less' | 'empty' | 'not-empty'

export type BaselineEvaluation = {
  task: 'regression' | 'classification'
  trainRows: number
  testRows: number
  prediction: string
  metrics: Array<{ label: string; value: string }>
}

export function validateImportFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  const extension = file.name.toLowerCase().split('.').pop()
  if (extension !== 'csv' && extension !== 'tsv') {
    return 'Choose a CSV or TSV file. Excel and Parquet import are not included in this prototype.'
  }
  if (file.size === 0) return 'The selected file is empty.'
  if (file.size > MAX_IMPORT_BYTES) {
    return `The file exceeds this prototype's ${formatBytes(MAX_IMPORT_BYTES)} import limit.`
  }
  if (file.type && !['text/csv', 'text/tab-separated-values', 'text/plain', 'application/vnd.ms-excel'].includes(file.type)) {
    return 'The file type does not match a supported text-delimited file.'
  }
  return null
}

export function parseDelimitedFile(contents: string, sourceName: string): DataTable {
  if (contents.includes('\0')) throw new Error('The file contains binary data and cannot be read as CSV or TSV.')

  const delimiter = sourceName.toLowerCase().endsWith('.tsv') ? '\t' : ','
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false

  for (let index = contents.charCodeAt(0) === 0xfeff ? 1 : 0; index < contents.length; index += 1) {
    const character = contents[index]
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"') {
      if (field.length > 0) throw new Error('A quote appeared in the middle of an unquoted field.')
      quoted = true
    } else if (character === delimiter) {
      pushField(record, field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && contents[index + 1] === '\n') index += 1
      pushField(record, field)
      field = ''
      if (record.some((value) => value.length > 0)) records.push(record)
      record = []
      if (records.length > MAX_IMPORT_ROWS + 1) throw new Error(`The file exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row limit.`)
    } else {
      field += character
      if (field.length > MAX_CELL_LENGTH) throw new Error('A cell exceeds the 32,000-character limit.')
    }
  }

  if (quoted) throw new Error('The file ends inside a quoted field. Check the CSV quoting and try again.')
  pushField(record, field)
  if (record.some((value) => value.length > 0)) records.push(record)

  if (records.length < 2) throw new Error('Include a header row and at least one data row.')
  if (records.length - 1 > MAX_IMPORT_ROWS) throw new Error(`The file exceeds the ${MAX_IMPORT_ROWS.toLocaleString()} row limit.`)

  const rawHeaders = records[0]
  if (rawHeaders.length > MAX_IMPORT_COLUMNS) throw new Error(`The file exceeds the ${MAX_IMPORT_COLUMNS}-column limit.`)
  const columns = makeUniqueHeaders(rawHeaders)
  const rows = records.slice(1).map((row, index) => {
    if (row.length !== columns.length) {
      throw new Error(`Row ${index + 2} has ${row.length} fields; expected ${columns.length}. Check the delimiter and quoting.`)
    }
    return row
  })

  return { sourceName, columns, rows }
}

export function profileTable(table: DataTable): TableProfile {
  const duplicateRows = countDuplicateRows(table.rows)
  const columns = table.columns.map((name, columnIndex): ColumnProfile => {
    const values = table.rows.map((row) => row[columnIndex] ?? '')
    const present = values.filter((value) => value.trim() !== '')
    const frequencies = new Map<string, number>()
    for (const value of present) frequencies.set(value, (frequencies.get(value) ?? 0) + 1)
    const numbers = present.map(Number)
    const numeric = present.length > 0 && numbers.every(Number.isFinite)

    return {
      name,
      missing: values.length - present.length,
      unique: frequencies.size,
      numeric,
      minimum: numeric ? Math.min(...numbers) : null,
      maximum: numeric ? Math.max(...numbers) : null,
      mean: numeric ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null,
      topValues: [...frequencies.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 3)
        .map(([value, count]) => ({ value, count })),
    }
  })

  return { rowCount: table.rows.length, columnCount: table.columns.length, duplicateRows, columns }
}

export function filterRows(
  table: DataTable,
  column: string,
  operator: FilterOperator,
  operand: string,
): DataTable {
  const index = table.columns.indexOf(column)
  if (index < 0) throw new Error('Choose a column that exists in the current dataset.')
  const numericOperand = Number(operand)

  const rows = table.rows.filter((row) => {
    const value = row[index] ?? ''
    switch (operator) {
      case 'equals': return value === operand
      case 'contains': return value.toLocaleLowerCase().includes(operand.toLocaleLowerCase())
      case 'greater': return operand.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > numericOperand
      case 'less': return operand.trim() !== '' && Number.isFinite(Number(value)) && Number(value) < numericOperand
      case 'empty': return value.trim() === ''
      case 'not-empty': return value.trim() !== ''
    }
  })

  return { ...table, rows }
}

export function renameColumn(table: DataTable, currentName: string, nextName: string): DataTable {
  const cleanName = nextName.trim()
  const index = table.columns.indexOf(currentName)
  if (index < 0) throw new Error('Choose a column that exists in the current dataset.')
  if (!cleanName) throw new Error('Enter a name for the column.')
  if (table.columns.some((name, candidate) => candidate !== index && name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('Column names must be unique.')
  }
  const columns = [...table.columns]
  columns[index] = cleanName
  return { ...table, columns }
}

export function removeColumn(table: DataTable, column: string): DataTable {
  const index = table.columns.indexOf(column)
  if (index < 0) throw new Error('Choose a column that exists in the current dataset.')
  if (table.columns.length === 1) throw new Error('A dataset must keep at least one column.')
  return {
    ...table,
    columns: table.columns.filter((_, columnIndex) => columnIndex !== index),
    rows: table.rows.map((row) => row.filter((_, columnIndex) => columnIndex !== index)),
  }
}

export function fillMissing(table: DataTable, column: string, replacement: string): DataTable {
  const index = table.columns.indexOf(column)
  if (index < 0) throw new Error('Choose a column that exists in the current dataset.')
  return {
    ...table,
    rows: table.rows.map((row) => row.map((value, columnIndex) =>
      columnIndex === index && value.trim() === '' ? replacement : value,
    )),
  }
}

export function evaluateBaseline(
  table: DataTable,
  targetColumn: string,
  task: 'regression' | 'classification',
): BaselineEvaluation {
  const index = table.columns.indexOf(targetColumn)
  if (index < 0) throw new Error('Choose a target column that exists in the current dataset.')
  const values = table.rows.map((row) => row[index] ?? '').filter((value) => value.trim() !== '')
  const trainRows = Math.floor(values.length * 0.8)
  const testValues = values.slice(trainRows)
  if (trainRows === 0 || testValues.length === 0) throw new Error('Add at least two non-empty target values to evaluate a baseline.')

  if (task === 'regression') {
    const numbers = values.map(Number)
    if (!numbers.every(Number.isFinite)) throw new Error('Regression requires a numeric target column without non-numeric values.')
    const prediction = numbers.slice(0, trainRows).reduce((sum, value) => sum + value, 0) / trainRows
    const actual = numbers.slice(trainRows)
    const errors = actual.map((value) => value - prediction)
    const mean = actual.reduce((sum, value) => sum + value, 0) / actual.length
    const totalVariation = actual.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    const residualVariation = errors.reduce((sum, value) => sum + value ** 2, 0)
    return {
      task,
      trainRows,
      testRows: actual.length,
      prediction: formatNumber(prediction),
      metrics: [
        { label: 'MAE', value: formatNumber(errors.reduce((sum, value) => sum + Math.abs(value), 0) / actual.length) },
        { label: 'RMSE', value: formatNumber(Math.sqrt(residualVariation / actual.length)) },
        { label: 'R²', value: totalVariation === 0 ? 'Not defined' : formatNumber(1 - residualVariation / totalVariation) },
      ],
    }
  }

  const frequencies = new Map<string, number>()
  for (const value of values.slice(0, trainRows)) frequencies.set(value, (frequencies.get(value) ?? 0) + 1)
  const prediction = [...frequencies.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]
  const correct = testValues.filter((value) => value === prediction).length
  return {
    task,
    trainRows,
    testRows: testValues.length,
    prediction,
    metrics: [{ label: 'Accuracy', value: `${((correct / testValues.length) * 100).toFixed(1)}%` }],
  }
}

export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`
}

function pushField(record: string[], value: string): void {
  if (value.length > MAX_CELL_LENGTH) throw new Error('A cell exceeds the 32,000-character limit.')
  record.push(value)
}

function makeUniqueHeaders(headers: string[]): string[] {
  const seen = new Set<string>()
  return headers.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`
    let candidate = base
    let suffix = 2
    while (seen.has(candidate.toLocaleLowerCase())) {
      candidate = `${base} (${suffix})`
      suffix += 1
    }
    seen.add(candidate.toLocaleLowerCase())
    return candidate
  })
}

function countDuplicateRows(rows: string[][]): number {
  const seen = new Set<string>()
  let duplicates = 0
  for (const row of rows) {
    const key = JSON.stringify(row)
    if (seen.has(key)) duplicates += 1
    else seen.add(key)
  }
  return duplicates
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : 'Not defined'
}