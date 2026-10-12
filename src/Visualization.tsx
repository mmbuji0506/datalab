import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { aggregateBy, type Aggregation, type DataTable } from './workbench'

const chartColors = ['#4e7ca8', '#d6765e', '#7b9f69', '#d0ad50', '#877aa1', '#4b9b8b', '#d38d53', '#526c77', '#a9bd59', '#cf7690', '#6d8c52', '#6e75ad']

type VisualizationProps = {
  table: DataTable
  numericColumns: string[]
  suggestedGroup: string
  suggestedMeasure: string
}

export default function Visualization({ table, numericColumns, suggestedGroup, suggestedMeasure }: VisualizationProps) {
  const [groupBy, setGroupBy] = useState(suggestedGroup)
  const [measure, setMeasure] = useState(suggestedMeasure)
  const [aggregation, setAggregation] = useState<Aggregation>('sum')
  const [chartType, setChartType] = useState<'bar' | 'donut'>('bar')

  const activeGroup = table.columns.includes(groupBy) ? groupBy : table.columns[0] ?? ''
  const activeMeasure = numericColumns.includes(measure) ? measure : numericColumns[0] ?? ''
  const activeAggregation = numericColumns.length ? aggregation : 'count'
  const points = activeGroup
    ? aggregateBy(table, activeGroup, activeMeasure || activeGroup, activeAggregation, 12)
    : []
  const label = activeAggregation === 'count' ? 'Rows' : `${activeAggregation === 'mean' ? 'Mean' : 'Sum'} of ${activeMeasure}`

  return (
    <section className="section-panel visualization-panel" aria-label="Data visualization">
      <div className="visualization-heading">
        <div>
          <p className="eyebrow">VISUAL EXPLORATION</p>
          <h2>Compare grouped values</h2>
          <p>Top 12 groups, calculated from the current working data.</p>
        </div>
        <div className="chart-switch" role="group" aria-label="Chart type">
          <button type="button" className={chartType === 'bar' ? 'selected' : ''} onClick={() => setChartType('bar')}>Bars</button>
          <button type="button" className={chartType === 'donut' ? 'selected' : ''} onClick={() => setChartType('donut')}>Donut</button>
        </div>
      </div>
      <div className="chart-controls">
        <label>Group by<select value={activeGroup} onChange={(event) => setGroupBy(event.target.value)}>{table.columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>
        <label>Measure<select value={activeMeasure} disabled={!numericColumns.length} onChange={(event) => setMeasure(event.target.value)}>{numericColumns.length ? numericColumns.map((column) => <option key={column} value={column}>{column}</option>) : <option value="">No numeric columns</option>}</select></label>
        <label>Aggregation<select value={activeAggregation} onChange={(event) => setAggregation(event.target.value as Aggregation)}><option value="sum" disabled={!numericColumns.length}>Sum</option><option value="mean" disabled={!numericColumns.length}>Mean</option><option value="count">Count rows</option></select></label>
      </div>
      {points.length ? (
        <div className={`chart-body${chartType === 'donut' ? ' donut-layout' : ''}`}>
          <div className="chart-canvas" role="img" aria-label={`${chartType === 'bar' ? 'Bar' : 'Donut'} chart: ${label} by ${activeGroup}`}>
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'bar' ? (
                <BarChart data={points} layout="vertical" margin={{ top: 3, right: 22, bottom: 3, left: 5 }}>
                  <CartesianGrid horizontal={false} stroke="#e8eee7" />
                  <XAxis type="number" tickLine={false} axisLine={false} tick={{ fill: '#77877d', fontSize: 10 }} />
                  <YAxis type="category" dataKey="group" width={88} tickLine={false} axisLine={false} tick={{ fill: '#53665a', fontSize: 10 }} />
                  <Tooltip cursor={{ fill: '#f2f6ef' }} contentStyle={{ border: '1px solid #dfe5de', borderRadius: 4, fontSize: 11 }} />
                  <Bar dataKey="value" name={label} fill="#4e7ca8" radius={[0, 4, 4, 0]} maxBarSize={24} />
                </BarChart>
              ) : (
                <PieChart>
                  <Tooltip contentStyle={{ border: '1px solid #dfe5de', borderRadius: 4, fontSize: 11 }} />
                  <Pie data={points} dataKey="value" nameKey="group" innerRadius="52%" outerRadius="78%" paddingAngle={2} stroke="#fff" strokeWidth={2}>
                    {points.map((point, index) => <Cell key={point.group} fill={chartColors[index % chartColors.length]} />)}
                  </Pie>
                </PieChart>
              )}
            </ResponsiveContainer>
          </div>
          {chartType === 'donut' && <ul className="chart-legend" aria-label="Chart values">{points.map((point, index) => <li key={point.group}><i style={{ backgroundColor: chartColors[index % chartColors.length] }} /><span>{point.group}</span><b>{point.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b></li>)}</ul>}
        </div>
      ) : <div className="chart-empty">Import rows with a value to visualize.</div>}
      <div className="chart-caption"><span>{label}</span><span>Grouped by {activeGroup || '—'} · local only</span></div>
    </section>
  )
}