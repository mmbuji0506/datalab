import { useMemo, useState } from "react";
import { BrainCircuit, Download, Play, TriangleAlert } from "lucide-react";
import type { TableInsight } from "./analytics.ts";
import { downloadText } from "./download.ts";
import {
  runModel,
  suggestFeatures,
  suggestTask,
  type ModelKind,
  type ModelReport,
  type SplitMode,
  type Task,
} from "./models.ts";
import { serializeCsv, type DataTable } from "./workbench.ts";

type ModelLabProps = {
  table: DataTable;
  insight: TableInsight;
  datasetName: string;
  /** Column to start with; falls back to the last column when it no longer exists. */
  defaultTarget?: string;
};

export function ModelLab({ table, insight, datasetName, defaultTarget = "" }: ModelLabProps) {
  const [targetChoice, setTargetChoice] = useState(defaultTarget);
  const [taskChoice, setTaskChoice] = useState<Task | null>(null);
  const [featureChoice, setFeatureChoice] = useState<Record<string, boolean>>({});
  const [model, setModel] = useState<ModelKind>("linear");
  const [split, setSplit] = useState<SplitMode>("random");
  const [testPercent, setTestPercent] = useState(20);
  const [folds, setFolds] = useState(5);
  const [seedText, setSeedText] = useState("42");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ report: ModelReport; table: DataTable } | null>(null);

  const target = table.columns.includes(targetChoice) ? targetChoice : (table.columns[table.columns.length - 1] ?? "");
  const task = taskChoice ?? suggestTask(table, target);
  const suggested = useMemo(() => suggestFeatures(table, target), [table, target]);
  const features = table.columns.filter((name) => name !== target && (featureChoice[name] ?? suggested.includes(name)));
  const seed = Number(seedText);
  const seedValid = seedText.trim() !== "" && Number.isInteger(seed);
  const stale = result !== null && result.table !== table;

  function typeOf(name: string): string {
    return insight.columns.find((column) => column.name === name)?.type ?? "";
  }

  function changeTarget(name: string) {
    setTargetChoice(name);
    setTaskChoice(null);
    setFeatureChoice({});
    setResult(null);
    setError("");
  }

  function run() {
    if (!seedValid) {
      setError("The random seed must be a whole number.");
      return;
    }
    setError("");
    setRunning(true);
    // Yield once so the "Training…" state paints before the synchronous work starts.
    window.setTimeout(() => {
      try {
        const report = runModel(table, {
          target,
          task,
          model,
          features,
          testFraction: testPercent / 100,
          seed,
          split,
          folds,
        });
        setResult({ report, table });
      } catch (cause) {
        setResult(null);
        setError(cause instanceof Error ? cause.message : "The model could not be trained.");
      } finally {
        setRunning(false);
      }
    }, 30);
  }

  function downloadPredictions(report: ModelReport) {
    const csv = serializeCsv({
      sourceName: "predictions.csv",
      columns: ["row", "actual", "predicted"],
      rows: report.predictions.map((entry) => [String(entry.row + 1), entry.actual, entry.predicted]),
    });
    downloadText(`${datasetName || "dataset"}-predictions.csv`, csv, "text/csv;charset=utf-8");
  }

  return (
    <section className="section-panel tool-section model-lab" aria-label="Model lab">
      <div className="section-heading">
        <div>
          <p className="eyebrow">MODEL LAB</p>
          <h2>
            <BrainCircuit size={18} /> Train and test a model
          </h2>
        </div>
        <span className="local-tag">Runs in your browser</span>
      </div>
      <p>
        Fits a real model on part of your rows and scores it on rows it never saw, beside a no-skill baseline. Cleaning
        steps you applied are already included.
      </p>
      <div className="form-grid lab-grid">
        <label>
          Target (what to predict)
          <select value={target} onChange={(event) => changeTarget(event.target.value)}>
            {table.columns.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Task
          <select
            value={task}
            onChange={(event) => {
              setTaskChoice(event.target.value as Task);
              setResult(null);
            }}
          >
            <option value="regression">Regression (predict a number)</option>
            <option value="classification">Classification (predict a category)</option>
          </select>
        </label>
        <label>
          Model
          <select value={model} onChange={(event) => setModel(event.target.value as ModelKind)}>
            <option value="linear">{task === "regression" ? "Ridge linear regression" : "Logistic regression"}</option>
            <option value="tree">Decision tree (finds interactions)</option>
          </select>
        </label>
        <label>
          Train/test split
          <select value={split} onChange={(event) => setSplit(event.target.value as SplitMode)}>
            <option value="random">Shuffled (seeded)</option>
            <option value="chronological">Keep file order (time series)</option>
          </select>
        </label>
        <label>
          Held out for testing
          <select value={testPercent} onChange={(event) => setTestPercent(Number(event.target.value))}>
            {[10, 20, 30, 40].map((value) => (
              <option key={value} value={value}>
                {value}% of rows
              </option>
            ))}
          </select>
        </label>
        <label>
          Cross-validation
          <select value={folds} onChange={(event) => setFolds(Number(event.target.value))}>
            <option value={0}>Off</option>
            {[3, 5, 10].map((value) => (
              <option key={value} value={value}>
                {value} folds
              </option>
            ))}
          </select>
        </label>
        <label>
          Random seed
          <input value={seedText} inputMode="numeric" onChange={(event) => setSeedText(event.target.value)} />
        </label>
      </div>
      <fieldset className="feature-picker">
        <legend>
          Input features <span>{features.length} selected</span>
        </legend>
        <div>
          {table.columns
            .filter((name) => name !== target)
            .map((name) => {
              const checked = features.includes(name);
              return (
                <label key={name} className={checked ? "checked" : undefined}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setFeatureChoice((current) => ({ ...current, [name]: event.target.checked }))}
                  />
                  <span>{name}</span>
                  <small>{typeOf(name)}</small>
                </label>
              );
            })}
        </div>
        <p>Identifier, date, constant and free-text columns start unchecked because they usually mislead a model.</p>
      </fieldset>
      <div className="tool-actions">
        <button className="button button-dark" type="button" onClick={run} disabled={running || features.length === 0}>
          <Play size={15} /> {running ? "Training…" : "Train and evaluate"}
        </button>
        {features.length === 0 && <span>Select at least one feature.</span>}
      </div>
      {error && (
        <p className="lab-error" role="alert">
          {error}
        </p>
      )}
      {stale && <p className="prepare-note">The data changed after this run. Train again to refresh the results.</p>}
      {result && !stale && <ModelResults report={result.report} onDownload={() => downloadPredictions(result.report)} />}
    </section>
  );
}

function formatMetric(value: number | null, percent: boolean): string {
  if (value === null) return "n/a";
  if (percent) return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function ModelResults({ report, onDownload }: { report: ModelReport; onDownload: () => void }) {
  const percent = report.task === "classification";
  const cv = report.crossValidation;
  const maxShare = Math.max(0.0001, ...report.importance.map((entry) => entry.share));
  const topCoefficients = report.coefficients
    ? [...report.coefficients].sort((left, right) => Math.abs(right.value) - Math.abs(left.value)).slice(0, 8)
    : null;

  return (
    <div className="lab-results" aria-live="polite">
      <div className={report.primary.significant ? "verdict good" : report.primary.beatsBaseline ? "verdict warn" : "verdict poor"}>
        <b>
          {report.primary.significant
            ? "Beats the baseline"
            : report.primary.beatsBaseline
              ? "Ahead of the baseline, but could be luck"
              : "Does not beat the baseline"}{" "}
          on {report.rows.test} held-out rows
        </b>
        <span>
          {report.primary.label}: model {formatMetric(report.primary.model, percent)} vs baseline{" "}
          {formatMetric(report.primary.baseline, percent)}. Chance check: p = {report.primary.pValue.toFixed(3)} (the
          share of 500 shuffled-answer trials that scored this well by luck; below 0.05 is convincing).
        </span>
      </div>
      <div className="result-summary lab-summary">
        <div>
          <span>TRAINED ON</span>
          <strong>{report.rows.train.toLocaleString()} rows</strong>
        </div>
        <div>
          <span>TESTED ON</span>
          <strong>{report.rows.test.toLocaleString()} rows</strong>
        </div>
        <div>
          <span>ENCODED INPUTS</span>
          <strong>{report.encodedFeatures}</strong>
        </div>
      </div>
      <table className="lab-table">
        <thead>
          <tr>
            <th>Held-out metric</th>
            <th>Model</th>
            <th>Baseline</th>
          </tr>
        </thead>
        <tbody>
          {report.metrics.map((metric) => (
            <tr key={metric.label}>
              <th scope="row">{metric.label}</th>
              <td>{formatMetric(metric.model, metric.percent)}</td>
              <td>{formatMetric(metric.baseline, metric.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cv && (
        <p className="lab-cv">
          <b>{cv.folds}-fold cross-validation</b> {cv.label}: {formatMetric(cv.model.mean, percent)}
          {cv.model.std !== null && ` ± ${formatMetric(cv.model.std, percent)}`} (baseline{" "}
          {formatMetric(cv.baseline.mean, percent)}). Scores averaged over several train/test splits are steadier than
          a single split.
        </p>
      )}
      {report.confusion && (
        <div className="lab-block">
          <h3>Confusion matrix</h3>
          <div className="lab-scroll">
            <table className="lab-table confusion">
              <thead>
                <tr>
                  <th>Actual ↓ / Predicted →</th>
                  {report.confusion.classes.map((name) => (
                    <th key={name}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.confusion.matrix.map((line, row) => {
                  const total = line.reduce((sum, value) => sum + value, 0) || 1;
                  return (
                    <tr key={report.confusion?.classes[row]}>
                      <th scope="row">{report.confusion?.classes[row]}</th>
                      {line.map((value, column) => (
                        <td
                          key={column}
                          className={row === column ? "diagonal" : undefined}
                          style={{ backgroundColor: `rgba(24, 59, 50, ${(value / total) * 0.4})` }}
                        >
                          {value}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.classReport && (
            <div className="lab-scroll">
              <table className="lab-table">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Precision</th>
                    <th>Recall</th>
                    <th>F1</th>
                    <th>Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {report.classReport.map((entry) => (
                    <tr key={entry.label}>
                      <th scope="row">{entry.label}</th>
                      <td>{formatMetric(entry.precision, true)}</td>
                      <td>{formatMetric(entry.recall, true)}</td>
                      <td>{formatMetric(entry.f1, true)}</td>
                      <td>{entry.support}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <div className="lab-block">
        <h3>What drives predictions</h3>
        <p className="lab-hint">
          Permutation importance: how much the score drops when one input is shuffled on the held-out rows. It is noisy
          on small data.
        </p>
        <ul className="importance-list">
          {report.importance.map((entry) => (
            <li key={entry.feature}>
              <span>{entry.feature}</span>
              <div className="meter">
                <i style={{ width: `${(entry.share / maxShare) * 100}%` }} />
              </div>
              <small>
                {entry.importance > 0.0005 ? `${entry.importance.toFixed(3)} ± ${entry.std.toFixed(3)}` : "no clear effect"}
              </small>
            </li>
          ))}
        </ul>
      </div>
      {topCoefficients && (
        <div className="lab-block">
          <h3>Linear coefficients</h3>
          <p className="lab-hint">Per one standard deviation of each input; positive values raise the prediction.</p>
          <ul className="coefficient-list">
            {topCoefficients.map((entry) => (
              <li key={entry.name}>
                <span>{entry.name}</span>
                <b className={entry.value >= 0 ? "up" : "down"}>
                  {entry.value >= 0 ? "+" : ""}
                  {entry.value.toLocaleString(undefined, { maximumFractionDigits: 3 })}
                </b>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="lab-warnings" role="note">
          <h3>
            <TriangleAlert size={15} /> Read these before trusting the numbers
          </h3>
          <ul>
            {report.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="lab-block">
        <div className="lab-predictions-head">
          <h3>Held-out predictions</h3>
          <button className="button button-secondary" type="button" onClick={onDownload}>
            <Download size={15} /> Download all {report.predictions.length}
          </button>
        </div>
        <div className="lab-scroll">
          <table className="lab-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Actual</th>
                <th>Predicted</th>
              </tr>
            </thead>
            <tbody>
              {report.predictions.slice(0, 8).map((entry) => (
                <tr key={entry.row} className={report.task === "classification" && entry.actual !== entry.predicted ? "miss" : undefined}>
                  <th scope="row">{entry.row + 1}</th>
                  <td>{entry.actual}</td>
                  <td>{entry.predicted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="lab-repro">
        Reproduce with seed {report.seed} · {report.split === "random" ? "shuffled split" : "file-order split"} ·{" "}
        {report.model === "tree" ? "decision tree" : report.task === "regression" ? "ridge regression" : "logistic regression"}
        {report.rows.sampledFrom ? ` · sampled ${report.rows.used.toLocaleString()} rows` : ""}
      </p>
    </div>
  );
}
