import { useState } from "react";
import { Play, Shapes, Sparkles } from "lucide-react";
import type { TableInsight } from "./analytics.ts";
import {
  kmeans,
  MAX_CLUSTER_COLUMNS,
  scanClusterCounts,
  type ClusterResult,
  type ClusterScanPoint,
} from "./clustering.ts";
import type { Step } from "./recipe.ts";
import type { DataTable } from "./workbench.ts";

type ClusterPanelProps = {
  table: DataTable;
  insight: TableInsight;
  onAdd: (step: Step) => void;
};

export function ClusterPanel({ table, insight, onAdd }: ClusterPanelProps) {
  const candidates = insight.columns.filter((column) => column.numeric).map((column) => column.name);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [k, setK] = useState(3);
  const [seedText, setSeedText] = useState("42");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<{ points: ClusterScanPoint[]; suggested: number | null; table: DataTable } | null>(null);
  const [result, setResult] = useState<{ value: ClusterResult; table: DataTable } | null>(null);

  const columns = candidates.filter((name, index) => chosen[name] ?? index < 3);
  const seed = Number(seedText);
  const seedValid = seedText.trim() !== "" && Number.isInteger(seed);
  const stale = (result !== null && result.table !== table) || (scan !== null && scan.table !== table);

  function guard(work: () => void) {
    if (!seedValid) {
      setError("The random seed must be a whole number.");
      return;
    }
    setError("");
    setBusy(true);
    window.setTimeout(() => {
      try {
        work();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Clustering failed.");
      } finally {
        setBusy(false);
      }
    }, 30);
  }

  function suggest() {
    guard(() => {
      const outcome = scanClusterCounts(table, columns, seed);
      setScan({ ...outcome, table });
      if (outcome.suggested !== null) setK(outcome.suggested);
    });
  }

  function run() {
    guard(() => setResult({ value: kmeans(table, columns, k, seed), table }));
  }

  const current = result && result.table === table ? result.value : null;
  const currentScan = scan && scan.table === table ? scan : null;
  const bestSilhouette = currentScan
    ? Math.max(0.0001, ...currentScan.points.map((point) => point.silhouette ?? 0))
    : 1;

  return (
    <section className="section-panel tool-section cluster-panel" aria-label="Clustering">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DISCOVER GROUPS</p>
          <h2>
            <Shapes size={18} /> Cluster rows (k-means)
          </h2>
        </div>
        <span className="local-tag">Unsupervised</span>
      </div>
      <p>
        Finds groups of similar rows without a target. Columns are standardized first so large-scale columns do not
        dominate.
      </p>
      {candidates.length < 1 ? (
        <div className="correlation-empty">Clustering needs at least one numeric column.</div>
      ) : (
        <>
          <fieldset className="feature-picker">
            <legend>
              Columns to cluster on{" "}
              <span>
                {columns.length}/{MAX_CLUSTER_COLUMNS} selected
              </span>
            </legend>
            <div>
              {candidates.map((name) => {
                const checked = columns.includes(name);
                return (
                  <label key={name} className={checked ? "checked" : undefined}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && columns.length >= MAX_CLUSTER_COLUMNS}
                      onChange={(event) => {
                        setChosen((existing) => ({ ...existing, [name]: event.target.checked }));
                        setResult(null);
                        setScan(null);
                      }}
                    />
                    <span>{name}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="form-grid lab-grid">
            <label>
              Number of clusters
              <select value={k} onChange={(event) => setK(Number(event.target.value))}>
                {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Random seed
              <input value={seedText} inputMode="numeric" onChange={(event) => setSeedText(event.target.value)} />
            </label>
          </div>
          <div className="tool-actions">
            <button className="button button-secondary" type="button" onClick={suggest} disabled={busy || columns.length === 0}>
              <Sparkles size={15} /> Suggest a number
            </button>
            <button className="button button-dark" type="button" onClick={run} disabled={busy || columns.length === 0}>
              <Play size={15} /> {busy ? "Working…" : "Run clustering"}
            </button>
          </div>
          {error && (
            <p className="lab-error" role="alert">
              {error}
            </p>
          )}
          {stale && <p className="prepare-note">The data changed after the last run. Run again to refresh.</p>}
          {currentScan && (
            <div className="lab-block">
              <h3>Which number of clusters fits best?</h3>
              <p className="lab-hint">
                Silhouette measures how well separated the groups are (higher is better, above about 0.5 is strong).
                {currentScan.suggested !== null && ` Best here: ${currentScan.suggested} clusters.`}
              </p>
              <ul className="importance-list">
                {currentScan.points.map((point) => (
                  <li key={point.k}>
                    <span>k = {point.k}</span>
                    <div className="meter">
                      <i style={{ width: `${(Math.max(0, point.silhouette ?? 0) / bestSilhouette) * 100}%` }} />
                    </div>
                    <small>{point.silhouette === null ? "n/a" : point.silhouette.toFixed(3)}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {current && (
            <div className="lab-results" aria-live="polite">
              <div className="verdict neutral">
                <b>
                  {current.k} clusters · silhouette {current.silhouette === null ? "n/a" : current.silhouette.toFixed(3)}
                </b>
                <span>
                  {current.fitRows < table.rows.length
                    ? `Fitted on a seeded sample of ${current.fitRows.toLocaleString()} rows; all ${table.rows.length.toLocaleString()} rows were assigned.`
                    : `Fitted on all ${current.fitRows.toLocaleString()} rows.`}
                  {current.imputedCells > 0 && ` ${current.imputedCells} empty cell${current.imputedCells === 1 ? " was" : "s were"} filled with the column mean.`}
                </span>
              </div>
              <div className="lab-scroll">
                <table className="lab-table">
                  <thead>
                    <tr>
                      <th>Cluster</th>
                      <th>Rows</th>
                      {current.columns.map((name) => (
                        <th key={name}>Avg {name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {current.sizes.map((size, index) => (
                      <tr key={index}>
                        <th scope="row">Cluster {index + 1}</th>
                        <td>{size.toLocaleString()}</td>
                        {current.centroids[index].map((value, column) => (
                          <td key={column}>{value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="tool-actions">
                <button
                  className="button button-dark"
                  type="button"
                  onClick={() => onAdd({ op: "cluster", columns: current.columns, k: current.k, seed })}
                >
                  Add “cluster” column to the dataset
                </button>
                <span>Recorded in your change history, so it replays identically.</span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
