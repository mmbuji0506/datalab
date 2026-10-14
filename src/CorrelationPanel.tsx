import { BarChart3, Calculator } from "lucide-react";
import type { CorrelationMethod, CorrelationResult } from "./analytics.ts";

type CorrelationPanelProps = {
  numericColumns: string[];
  selectedColumns: string[];
  matrix: CorrelationResult | null;
  method: CorrelationMethod;
  error: string;
  maxColumns: number;
  onSelectionChange: (columns: string[]) => void;
  onMethodChange: (method: CorrelationMethod) => void;
  onCalculate: () => void;
};

export function CorrelationPanel({
  numericColumns,
  selectedColumns,
  matrix,
  method,
  error,
  maxColumns,
  onSelectionChange,
  onMethodChange,
  onCalculate,
}: CorrelationPanelProps) {
  function toggleColumn(column: string, checked: boolean) {
    if (checked) {
      if (selectedColumns.length >= maxColumns) return;
      onSelectionChange([...selectedColumns, column]);
    } else {
      onSelectionChange(
        selectedColumns.filter((selected) => selected !== column),
      );
    }
  }

  return (
    <section className="section-panel correlation-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RELATIONSHIPS</p>
          <h2>
            <BarChart3 size={17} /> Numeric correlation
          </h2>
        </div>
        <span>
          {selectedColumns.length}/{maxColumns} columns
        </span>
      </div>
      <p className="correlation-description">
        {method === "pearson"
          ? "Pearson correlation on complete pairs measures linear association."
          : "Spearman rank correlation on complete pairs measures whether values rise together, even along a curve, and resists outliers."}{" "}
        Neither shows causation. p-values test whether a relationship could be chance; with many pairs, a few will look
        significant by luck.
      </p>
      {numericColumns.length >= 2 ? (
        <>
          <div
            className="correlation-columns"
            role="group"
            aria-label="Numeric columns"
          >
            {numericColumns.map((column) => {
              const checked = selectedColumns.includes(column);
              return (
                <label key={column}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && selectedColumns.length >= maxColumns}
                    onChange={(event) =>
                      toggleColumn(column, event.target.checked)
                    }
                  />
                  <span>{column}</span>
                </label>
              );
            })}
          </div>
          <div className="correlation-method" role="group" aria-label="Correlation method">
            {(["pearson", "spearman"] as const).map((option) => (
              <label key={option} className={method === option ? "checked" : undefined}>
                <input
                  type="radio"
                  name="correlation-method"
                  checked={method === option}
                  onChange={() => onMethodChange(option)}
                />
                <span>{option === "pearson" ? "Pearson (linear)" : "Spearman (rank)"}</span>
              </label>
            ))}
          </div>
          <div className="correlation-actions">
            <button
              className="button button-dark"
              type="button"
              onClick={onCalculate}
              disabled={selectedColumns.length < 2}
            >
              <Calculator size={15} /> Calculate matrix
            </button>
            {matrix && <span>Calculated locally from current rows</span>}
          </div>
          {error && (
            <p className="correlation-error" role="alert">
              {error}
            </p>
          )}
          {matrix && (
            <div className="correlation-table-wrap">
              <table className="correlation-table">
                <thead>
                  <tr>
                    <th>Column</th>
                    {matrix.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.columns.map((rowColumn, rowIndex) => (
                    <tr key={rowColumn}>
                      <th scope="row">{rowColumn}</th>
                      {matrix.columns.map((column, columnIndex) => {
                        const coefficient =
                          matrix.values[rowIndex][columnIndex];
                        const pairs = matrix.counts[rowIndex][columnIndex];
                        const pValue = matrix.pValues[rowIndex][columnIndex];
                        return (
                          <td
                            key={column}
                            title={`${pairs.toLocaleString()} complete row pairs${pValue === null || rowIndex === columnIndex ? "" : `, ${describeP(pValue)}`}`}
                          >
                            {coefficient === null ? (
                              <span className="undefined-correlation">N/A</span>
                            ) : (
                              <span
                                className="correlation-value"
                                style={{
                                  backgroundColor:
                                    correlationColor(coefficient),
                                }}
                              >
                                {coefficient.toFixed(2)}
                              </span>
                            )}
                            <small>
                              {pairs.toLocaleString()} rows
                              {rowIndex !== columnIndex && pValue !== null && ` · ${describeP(pValue)}`}
                            </small>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="correlation-empty">
          Import at least two numeric columns to calculate relationships.
        </div>
      )}
    </section>
  );
}

function describeP(value: number): string {
  return value < 0.001 ? "p < 0.001" : `p = ${value.toFixed(3)}`;
}

function correlationColor(value: number): string {
  const intensity = Math.round(Math.abs(value) * 75);
  return value >= 0
    ? `rgb(${255 - intensity}, ${255 - intensity / 2}, ${235 - intensity})`
    : `rgb(255, ${245 - intensity}, ${235 - intensity})`;
}
