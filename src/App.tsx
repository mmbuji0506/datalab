import { lazy, Suspense, useMemo, useState, type ChangeEvent } from "react";
import {
  Activity,
  ArrowDownToLine,
  BarChart3,
  Check,
  Database,
  FileUp,
  Filter,
  LayoutDashboard,
  LockKeyhole,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Undo2,
  WandSparkles,
} from "lucide-react";
import { ClusterPanel } from "./ClusterPanel";
import { ColumnDetail } from "./ColumnDetail";
import { CorrelationPanel } from "./CorrelationPanel";
import { HistoryPanel } from "./HistoryPanel";
import { IntegrationPanel } from "./IntegrationPanel";
import { ModelLab } from "./ModelLab";
import { QualityPanel } from "./QualityPanel";
import "./App.css";
import "./Lab.css";
import {
  analyzeTable,
  assessQuality,
  correlate,
  type CorrelationMethod,
  type CorrelationResult,
} from "./analytics.ts";
import { downloadText } from "./download.ts";
import {
  applyStep,
  exportRecipe,
  parseRecipe,
  replayRecipe,
  type Step,
} from "./recipe.ts";
import {
  evaluateBaseline,
  formatBytes,
  MAX_CORRELATION_COLUMNS,
  MAX_IMPORT_BYTES,
  parseDelimitedFile,
  profileTable,
  serializeCsv,
  validateImportFile,
  type BaselineEvaluation,
  type DataTable,
  type Delimiter,
  type FilterOperator,
} from "./workbench";

const Visualization = lazy(() => import("./Visualization"));

const sampleCsv = `week,region,visits,orders,revenue,channel
2026-W01,North,1240,82,4920,Organic
2026-W01,South,980,61,3660,Paid
2026-W02,North,1380,91,5460,Organic
2026-W02,West,760,44,2640,Referral
2026-W03,East,1120,73,4380,Paid
2026-W03,South,1050,68,4080,Organic
2026-W04,West,890,57,3420,Referral
2026-W04,East,1460,96,5760,Paid
2026-W05,North,1310,88,5280,Organic
2026-W05,South,1170,74,4440,Paid
2026-W06,East,1540,102,6120,Organic
2026-W06,West,930,59,3540,Referral`;

const initialTable = parseDelimitedFile(sampleCsv, "sample-orders.csv");
type View = "data" | "prepare" | "evaluate";
type Transform =
  | "rename"
  | "fill"
  | "remove"
  | "trim"
  | "drop-missing"
  | "deduplicate"
  | "normalize-min-max"
  | "normalize-z-score"
  | "impute-median"
  | "impute-mean"
  | "impute-mode"
  | "standardize-missing"
  | "convert-number"
  | "harmonize"
  | "outliers-cap"
  | "outliers-remove"
  | "one-hot"
  | "date-parts";

const views: Array<{ key: View; label: string; Icon: typeof LayoutDashboard }> =
  [
    { key: "data", label: "Data overview", Icon: LayoutDashboard },
    { key: "prepare", label: "Prepare", Icon: SlidersHorizontal },
    { key: "evaluate", label: "Evaluate", Icon: BarChart3 },
  ];

const operators: Array<{ value: FilterOperator; label: string }> = [
  { value: "equals", label: "is equal to" },
  { value: "contains", label: "contains" },
  { value: "greater", label: "is greater than" },
  { value: "less", label: "is less than" },
  { value: "empty", label: "is empty" },
  { value: "not-empty", label: "is not empty" },
];

const transformNotes: Partial<Record<Transform, string>> = {
  "impute-median":
    "Replaces empty cells with the column median (numeric columns only). The median is not pulled around by outliers.",
  "impute-mean":
    "Replaces empty cells with the column average (numeric columns only). Outliers pull the average, so the median is often safer.",
  "impute-mode": "Replaces empty cells with the most common value in the column.",
  "standardize-missing":
    'Turns markers such as "N/A", "null", "none", "-" and "?" into empty cells so they count as missing. Check first that "none" or "na" are not real categories here.',
  "convert-number":
    "Reads currency symbols, thousands commas, brackets for negatives and % signs as plain numbers (12% becomes 0.12). Ambiguous values such as 1,5 are refused, and nothing changes unless every value converts.",
  harmonize:
    "Merges spellings that differ only by case or spacing (Paid, paid, PAID) into the most common form.",
  "outliers-cap":
    "Limits values outside 1.5 × IQR to the nearest boundary. Every row is kept.",
  "one-hot":
    "Replaces a category column with one 0/1 column per value (up to 20 categories), ready for models.",
  "date-parts":
    "Adds year, month, day and weekday columns from an ISO date (YYYY-MM-DD).",
};

function buildTransformStep(
  transform: Transform,
  column: string,
  renameValue: string,
  replacement: string,
): Step {
  switch (transform) {
    case "rename":
      return { op: "rename", column, to: renameValue };
    case "fill":
      return { op: "fill", column, value: replacement };
    case "remove":
      return { op: "remove-column", column };
    case "trim":
      return { op: "trim", column };
    case "drop-missing":
      return { op: "drop-missing", columns: [column] };
    case "deduplicate":
      return { op: "deduplicate" };
    case "normalize-min-max":
      return { op: "normalize", column, method: "min-max" };
    case "normalize-z-score":
      return { op: "normalize", column, method: "z-score" };
    case "impute-median":
      return { op: "impute", column, strategy: "median" };
    case "impute-mean":
      return { op: "impute", column, strategy: "mean" };
    case "impute-mode":
      return { op: "impute", column, strategy: "mode" };
    case "standardize-missing":
      return { op: "standardize-missing", column };
    case "convert-number":
      return { op: "convert-number", column };
    case "harmonize":
      return { op: "harmonize-categories", column };
    case "outliers-cap":
      return { op: "outliers", column, method: "cap", multiplier: 1.5 };
    case "outliers-remove":
      return { op: "outliers", column, method: "remove", multiplier: 1.5 };
    case "one-hot":
      return { op: "one-hot", column };
    case "date-parts":
      return { op: "date-parts", column };
  }
}

function delimiterName(delimiter: Delimiter): string {
  switch (delimiter) {
    case ",":
      return "comma";
    case ";":
      return "semicolon";
    case "\t":
      return "tab";
    case "|":
      return "pipe";
  }
}

function App() {
  const [table, setTable] = useState<DataTable>(initialTable);
  const [source, setSource] = useState<DataTable>(initialTable);
  const [profile, setProfile] = useState(() => profileTable(initialTable));
  const [view, setView] = useState<View>("data");
  const [isSample, setIsSample] = useState(true);
  const [steps, setSteps] = useState<Step[]>([]);
  const [protectFormulas, setProtectFormulas] = useState(true);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [filterColumn, setFilterColumn] = useState(initialTable.columns[1]);
  const [filterOperator, setFilterOperator] =
    useState<FilterOperator>("equals");
  const [filterValue, setFilterValue] = useState("North");
  const [column, setColumn] = useState(initialTable.columns[0]);
  const [transform, setTransform] = useState<Transform>("rename");
  const [renameValue, setRenameValue] = useState("");
  const [replacement, setReplacement] = useState("Unknown");
  const [correlationColumns, setCorrelationColumns] = useState([
    "visits",
    "orders",
    "revenue",
  ]);
  const [correlations, setCorrelations] = useState<CorrelationResult | null>(
    null,
  );
  const [correlationMethod, setCorrelationMethod] =
    useState<CorrelationMethod>("pearson");
  const [correlationError, setCorrelationError] = useState("");
  const [task, setTask] = useState<"regression" | "classification">(
    "regression",
  );
  const [target, setTarget] = useState("revenue");
  const [evaluation, setEvaluation] = useState<BaselineEvaluation | null>(null);

  const datasetName = table.sourceName
    .replace(/\.(csv|tsv)/gi, "")
    .replaceAll("+", " + ");
  const missing = profile.columns.reduce((sum, item) => sum + item.missing, 0);
  const modified = steps.length > 0;
  const filtered = steps.some((step) => step.op === "filter");
  const insight = useMemo(() => analyzeTable(table), [table]);
  const insightByName = useMemo(
    () => new Map(insight.columns.map((item) => [item.name, item])),
    [insight],
  );
  const quality = useMemo(
    () => assessQuality(table, insight),
    [table, insight],
  );
  const selectedTransformNote = transformNotes[transform];
  const needsOperand =
    filterOperator === "empty" || filterOperator === "not-empty";

  function updateTable(next: DataTable) {
    const nextProfile = profileTable(next);
    setTable(next);
    setProfile(nextProfile);
    setEvaluation(null);
    setCorrelations(null);
    setCorrelationColumns((current) => {
      const valid = current.filter((name) =>
        nextProfile.columns.some((item) => item.name === name && item.numeric),
      );
      return valid.length >= 2
        ? valid.slice(0, MAX_CORRELATION_COLUMNS)
        : nextProfile.columns
            .filter((item) => item.numeric)
            .slice(0, Math.min(3, MAX_CORRELATION_COLUMNS))
            .map((item) => item.name);
    });
    setColumn((current) =>
      next.columns.includes(current) ? current : next.columns[0],
    );
    setFilterColumn((current) =>
      next.columns.includes(current) ? current : next.columns[0],
    );
    setTarget((current) =>
      next.columns.includes(current) ? current : next.columns[0],
    );
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const validationError = validateImportFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      const imported = parseDelimitedFile(await file.text(), file.name);
      const importedProfile = profileTable(imported);
      setTable(imported);
      setSource(imported);
      setProfile(importedProfile);
      setIsSample(false);
      setSteps([]);
      setFileSize(file.size);
      setFilterColumn(imported.columns[0]);
      setColumn(imported.columns[0]);
      setTarget(imported.columns[imported.columns.length - 1]);
      setCorrelationColumns(
        importedProfile.columns
          .filter((item) => item.numeric)
          .slice(0, 4)
          .map((item) => item.name),
      );
      setCorrelations(null);
      setCorrelationError("");
      setEvaluation(null);
      setError("");
      setView("data");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The selected file could not be read.",
      );
    }
  }

  function commitStep(step: Step, failure = "The change could not be applied.") {
    try {
      updateTable(applyStep(table, step));
      setSteps((current) => [...current, step]);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    }
  }

  function applyFilter() {
    commitStep(
      {
        op: "filter",
        column: filterColumn,
        operator: filterOperator,
        value: filterValue,
      },
      "The filter could not be applied.",
    );
  }

  function applyTransform() {
    commitStep(buildTransformStep(transform, column, renameValue, replacement));
  }

  function undoLastStep() {
    const remaining = steps.slice(0, -1);
    try {
      updateTable(replayRecipe(source, remaining));
      setSteps(remaining);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The step could not be undone.",
      );
    }
  }

  function saveRecipe() {
    try {
      downloadText(
        `${datasetName || "dataset"}-recipe.json`,
        exportRecipe(steps, source.sourceName),
        "application/json;charset=utf-8",
      );
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The recipe could not be saved.",
      );
    }
  }

  async function applyRecipeFile(file: File) {
    if (file.size > 1024 * 1024) {
      setError("Recipe files must be smaller than 1 MB.");
      return;
    }
    try {
      const recipe = parseRecipe(await file.text());
      updateTable(replayRecipe(table, recipe));
      setSteps((current) => [...current, ...recipe]);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The recipe could not be applied.",
      );
    }
  }

  function calculateCorrelations() {
    try {
      setCorrelations(
        correlate(table, correlationColumns, correlationMethod),
      );
      setCorrelationError("");
    } catch (cause) {
      setCorrelations(null);
      setCorrelationError(
        cause instanceof Error
          ? cause.message
          : "The correlation matrix could not be calculated.",
      );
    }
  }

  function restoreSource() {
    setTable(source);
    setProfile(profileTable(source));
    setSteps([]);
    setEvaluation(null);
    setCorrelations(null);
    setCorrelationError("");
    setError("");
    setColumn(source.columns[0]);
    setFilterColumn(source.columns[0]);
    setTarget(source.columns[source.columns.length - 1]);
  }

  function exportCsv() {
    const csv = serializeCsv(table, { neutralizeFormulas: protectFormulas });
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${datasetName || "dataset"}-prepared.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function runEvaluation() {
    try {
      setEvaluation(evaluateBaseline(table, target, task));
      setError("");
    } catch (cause) {
      setEvaluation(null);
      setError(cause instanceof Error ? cause.message : "Evaluation failed.");
    }
  }

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <a className="brand" href="#data" onClick={() => setView("data")}>
          <span className="brand-mark">
            <Database size={17} />
          </span>
          <span>
            datalab<small>WORKSPACE</small>
          </span>
        </a>
        <div className="workspace-switcher">
          <span className="workspace-avatar">D</span>
          <span>
            <b>Personal workspace</b>
            <small>Local session</small>
          </span>
          <i />
        </div>
        <p className="side-label">WORKSPACE</p>
        <nav className="side-nav" aria-label="Workbench sections">
          {views.map(({ key, label, Icon }) => (
            <button
              type="button"
              key={key}
              className={view === key ? "nav-item active" : "nav-item"}
              onClick={() => setView(key)}
              aria-current={view === key ? "page" : undefined}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-card">
            <LockKeyhole size={16} />
            <span>
              <b>On this device</b>
              <small>Files stay in this browser</small>
            </span>
          </div>
          <p>
            Imported data is processed locally and cleared when this session
            ends.
          </p>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Personal workspace <span>/</span>{" "}
            {views.find((item) => item.key === view)?.label}
          </div>
          <div className="top-actions">
            <span className="runtime-pill">
              <i /> In-browser
            </span>
            <label htmlFor="dataset-file" className="button button-primary">
              <FileUp size={16} /> Import data
              <input
                id="dataset-file"
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values"
                onChange={importFile}
              />
            </label>
          </div>
        </header>
        <div className="content-wrap">
          <section className="page-heading">
            <div>
              <p className="eyebrow">
                LOCAL WORKSPACE <span>/</span> DATASET
              </p>
              <div className="title-line">
                <h1>{datasetName}</h1>
                <span
                  className={isSample ? "source-badge sample" : "source-badge"}
                >
                  {isSample ? "SAMPLE DATA" : "LOCAL FILE"}
                </span>
              </div>
              <p>
                Inspect, prepare, and evaluate a dataset without sending it
                anywhere.
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={undoLastStep}
                disabled={!modified}
                title="Undo the last change"
              >
                <Undo2 size={15} /> Undo
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={restoreSource}
                disabled={!modified}
                title="Restore imported source"
              >
                <RotateCcw size={15} /> Restore source
              </button>
              <button
                className="button button-dark"
                type="button"
                onClick={exportCsv}
                disabled={!table.rows.length}
              >
                <ArrowDownToLine size={16} /> Export CSV
              </button>
              <label
                className="protect-toggle"
                title="Prefixes cells that start with = + - @ so spreadsheets cannot run them as formulas"
              >
                <input
                  type="checkbox"
                  checked={protectFormulas}
                  onChange={(event) => setProtectFormulas(event.target.checked)}
                />
                Protect against spreadsheet formulas
              </label>
            </div>
          </section>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button
                type="button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}
          {isSample && (
            <div className="sample-banner">
              <Sparkles size={16} />
              <span>
                <b>Sample dataset</b> — a small sales table is loaded for
                exploring the workbench.
              </span>
              <label htmlFor="dataset-file">
                Use your own CSV <span>→</span>
              </label>
            </div>
          )}
          <section className="stats-strip" aria-label="Dataset summary">
            <div>
              <span>ROWS</span>
              <strong>{profile.rowCount.toLocaleString()}</strong>
              <small>{filtered ? "after filter" : "records"}</small>
            </div>
            <div>
              <span>COLUMNS</span>
              <strong>{profile.columnCount}</strong>
              <small>fields</small>
            </div>
            <div>
              <span>MISSING VALUES</span>
              <strong className={missing ? "warning-text" : ""}>
                {missing.toLocaleString()}
              </strong>
              <small>{missing ? "need attention" : "none detected"}</small>
            </div>
            <div>
              <span>DUPLICATE ROWS</span>
              <strong>{profile.duplicateRows}</strong>
              <small>
                {profile.duplicateRows ? "review suggested" : "none detected"}
              </small>
            </div>
            <p>
              <Activity size={15} />{" "}
              {fileSize === null
                ? isSample
                  ? "Demo file"
                  : "Combined dataset"
                : `${formatBytes(fileSize)} imported`}{" "}
              <span>·</span> {modified ? "Changes not saved" : "Ready"}
            </p>
          </section>
          {view === "data" && (
            <Suspense
              fallback={
                <div className="chart-loading">Loading visualization…</div>
              }
            >
              <Visualization
                key={table.sourceName}
                table={table}
                numericColumns={profile.columns
                  .filter((item) => item.numeric)
                  .map((item) => item.name)}
                suggestedGroup={
                  profile.columns
                    .filter((item) => !item.numeric)
                    .sort((left, right) => left.unique - right.unique)[0]
                    ?.name ??
                  table.columns[0] ??
                  ""
                }
                suggestedMeasure={
                  profile.columns
                    .filter(
                      (item) => item.numeric && item.unique < profile.rowCount,
                    )
                    .sort((left, right) => left.unique - right.unique)[0]
                    ?.name ??
                  profile.columns.find((item) => item.numeric)?.name ??
                  ""
                }
              />
            </Suspense>
          )}
          <div
            className="view-tabs"
            role="tablist"
            aria-label="Dataset workflow"
          >
            {views.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                className={view === key ? "view-tab current" : "view-tab"}
                onClick={() => setView(key)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>

          {view === "data" && (
            <QualityPanel
              report={quality}
              rowCount={table.rows.length}
              onApply={(step) => commitStep(step)}
            />
          )}
          {view === "data" && (
            <div className="overview-layout">
              <section className="section-panel table-section">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">DATA PREVIEW</p>
                    <h2>
                      <Table2 size={18} /> Dataset rows
                    </h2>
                  </div>
                  <span>
                    {Math.min(8, table.rows.length)} of{" "}
                    {table.rows.length.toLocaleString()} rows
                  </span>
                </div>
                {table.rows.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th className="row-index">#</th>
                          {table.columns.map((item) => (
                            <th key={item}>
                              {item}
                              <small>
                                {profile.columns.find(
                                  (profileColumn) =>
                                    profileColumn.name === item,
                                )?.numeric
                                  ? "123"
                                  : "Aa"}
                              </small>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.slice(0, 8).map((row, rowIndex) => (
                          <tr key={`${rowIndex}-${JSON.stringify(row)}`}>
                            <td className="row-index">
                              {String(rowIndex + 1).padStart(2, "0")}
                            </td>
                            {table.columns.map((item, columnIndex) => (
                              <td key={item}>
                                {row[columnIndex] || <em>Missing</em>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-table">
                    <Filter size={20} />
                    <b>No rows match this filter.</b>
                    <button type="button" onClick={restoreSource}>
                      Restore source data
                    </button>
                  </div>
                )}
                <div className="table-footer">
                  <span>
                    Delimited text · UTF-8
                    {source.delimiter
                      ? ` · ${delimiterName(source.delimiter)}-separated`
                      : ""}
                  </span>
                  <span>Preview limited to 8 rows</span>
                </div>
              </section>
              <aside className="section-panel profile-section">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">QUICK PROFILE</p>
                    <h2>
                      <Activity size={17} /> Column health
                    </h2>
                  </div>
                  <span>{table.columns.length}</span>
                </div>
                {profile.columns.map((item) => (
                  <div className="profile-row" key={item.name}>
                    <div>
                      <b>{item.name}</b>
                      <small>
                        {(
                          insightByName.get(item.name)?.type ??
                          (item.numeric ? "numeric" : "text")
                        ).toUpperCase()}
                      </small>
                    </div>
                    <p>
                      {item.unique} unique <span>{item.missing} missing</span>
                    </p>
                    <div className="missing-track">
                      <i
                        style={{
                          width: `${profile.rowCount ? (item.missing / profile.rowCount) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <p className="profile-range">
                      {item.numeric ? (
                        <>
                          Mean{" "}
                          <b>
                            {item.mean?.toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            }) ?? "—"}
                          </b>
                          <span>Range</span>
                          <b>
                            {item.minimum}–{item.maximum}
                          </b>
                        </>
                      ) : (
                        <>
                          Most common <b>{item.topValues[0]?.value || "—"}</b>
                          <span>{item.topValues[0]?.count ?? 0} rows</span>
                        </>
                      )}
                    </p>
                    <ColumnDetail insight={insightByName.get(item.name)} />
                  </div>
                ))}
                <div className="profile-foot">
                  <Check size={14} /> Profile calculated locally
                </div>
              </aside>
            </div>
          )}
          {view === "data" && (
            <CorrelationPanel
              numericColumns={profile.columns
                .filter((item) => item.numeric)
                .map((item) => item.name)}
              selectedColumns={correlationColumns}
              matrix={correlations}
              method={correlationMethod}
              onMethodChange={(method) => {
                setCorrelationMethod(method);
                setCorrelations(null);
                setCorrelationError("");
              }}
              error={correlationError}
              maxColumns={MAX_CORRELATION_COLUMNS}
              onSelectionChange={(columns) => {
                setCorrelationColumns(columns);
                setCorrelations(null);
                setCorrelationError("");
              }}
              onCalculate={calculateCorrelations}
            />
          )}

          {view === "prepare" && (
            <div className="prepare-layout">
              <section className="section-panel tool-section">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">TRANSFORM</p>
                    <h2>
                      <WandSparkles size={18} /> Column operation
                    </h2>
                  </div>
                </div>
                <p>
                  Changes affect only this in-memory working copy. The imported
                  file is unchanged.
                </p>
                <div className="form-grid">
                  <label>
                    Operation
                    <select
                      value={transform}
                      onChange={(event) =>
                        setTransform(event.target.value as Transform)
                      }
                    >
                      <optgroup label="Clean">
                        <option value="fill">Fill missing with a value</option>
                        <option value="impute-median">
                          Fill missing with the median
                        </option>
                        <option value="impute-mean">
                          Fill missing with the mean
                        </option>
                        <option value="impute-mode">
                          Fill missing with the most common
                        </option>
                        <option value="standardize-missing">
                          Mark “N/A” markers as missing
                        </option>
                        <option value="convert-number">
                          Convert text to numbers ($, %, commas)
                        </option>
                        <option value="harmonize">Merge spelling variants</option>
                        <option value="trim">Trim text whitespace</option>
                        <option value="outliers-cap">Cap outliers</option>
                        <option value="outliers-remove">
                          Remove outlier rows
                        </option>
                        <option value="drop-missing">Remove missing rows</option>
                        <option value="deduplicate">Remove duplicate rows</option>
                      </optgroup>
                      <optgroup label="Prepare for modeling">
                        <option value="normalize-min-max">
                          Normalize to 0–1
                        </option>
                        <option value="normalize-z-score">
                          Standardize (z-score)
                        </option>
                        <option value="one-hot">One-hot encode a category</option>
                        <option value="date-parts">
                          Extract date parts
                        </option>
                      </optgroup>
                      <optgroup label="Structure">
                        <option value="rename">Rename a column</option>
                        <option value="remove">Remove a column</option>
                      </optgroup>
                    </select>
                  </label>
                  {transform !== "deduplicate" && (
                    <label>
                      Column
                      <select
                        value={column}
                        onChange={(event) => setColumn(event.target.value)}
                      >
                        {table.columns.map((item) => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {transform === "rename" && (
                    <label className="wide-field">
                      New column name
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        placeholder="Enter a unique name"
                      />
                    </label>
                  )}
                  {transform === "fill" && (
                    <label className="wide-field">
                      Replacement value
                      <input
                        value={replacement}
                        onChange={(event) => setReplacement(event.target.value)}
                      />
                    </label>
                  )}
                </div>
                {transform === "drop-missing" && (
                  <p className="warning-note">
                    Rows with an empty value in {column} will be removed from
                    the working copy.
                  </p>
                )}
                {(transform === "normalize-min-max" ||
                  transform === "normalize-z-score") && (
                  <p className="prepare-note">
                    Empty values stay empty. Non-numeric values must be cleaned
                    before normalization.
                  </p>
                )}
                {transform === "deduplicate" && (
                  <p className="prepare-note">
                    Keeps the first copy of each exact row and removes later
                    duplicates.
                  </p>
                )}
                {transform === "remove" && (
                  <p className="warning-note">
                    Removing a column changes the working copy. Restore source
                    to undo all changes.
                  </p>
                )}
                {selectedTransformNote && (
                  <p className="prepare-note">{selectedTransformNote}</p>
                )}
                {transform === "outliers-remove" && (
                  <p className="warning-note">
                    Rows with values outside 1.5 × IQR will be removed. Real
                    extreme values are lost, so inspect them first.
                  </p>
                )}
                <div className="tool-actions">
                  <button
                    className="button button-dark"
                    type="button"
                    onClick={applyTransform}
                  >
                    <Check size={15} /> Apply operation
                  </button>
                </div>
              </section>
              <IntegrationPanel
                key={`${table.sourceName}:${table.columns.join("|")}`}
                table={table}
                onApply={(integrated) => {
                  commitStep({
                    op: "replace-table",
                    table: integrated,
                    label: `Combine with another file (${integrated.rows.length.toLocaleString()} rows, ${integrated.columns.length} columns)`,
                  });
                  setIsSample(false);
                  setFileSize(null);
                }}
              />
              <section className="section-panel tool-section">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">FILTER</p>
                    <h2>
                      <Filter size={18} /> Keep matching rows
                    </h2>
                  </div>
                  {filtered && <span className="active-filter">ACTIVE</span>}
                </div>
                <p>
                  Filter the current working data before export or evaluation.
                </p>
                <div className="form-grid filter-grid">
                  <label>
                    Column
                    <select
                      value={filterColumn}
                      onChange={(event) => setFilterColumn(event.target.value)}
                    >
                      {table.columns.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Condition
                    <select
                      value={filterOperator}
                      onChange={(event) =>
                        setFilterOperator(event.target.value as FilterOperator)
                      }
                    >
                      {operators.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Value
                    <input
                      disabled={needsOperand}
                      value={filterValue}
                      onChange={(event) => setFilterValue(event.target.value)}
                      placeholder={
                        needsOperand ? "Not needed" : "Enter a value"
                      }
                    />
                  </label>
                </div>
                <div className="tool-actions">
                  <button
                    className="button button-dark"
                    type="button"
                    onClick={applyFilter}
                  >
                    <Filter size={15} /> Apply filter
                  </button>
                  <span>
                    {table.rows.length.toLocaleString()} rows in current data
                  </span>
                </div>
              </section>
              <HistoryPanel
                steps={steps}
                onUndo={undoLastStep}
                onExport={saveRecipe}
                onImport={(file) => void applyRecipeFile(file)}
              />
              <div className="prepare-footer">
                <RotateCcw size={16} />
                <span>
                  {modified
                    ? "Working copy has changes."
                    : "No changes applied yet."}{" "}
                  Restoring source resets filters and column edits.
                </span>
                <button
                  type="button"
                  onClick={restoreSource}
                  disabled={!modified}
                >
                  Restore source
                </button>
              </div>
            </div>
          )}

          {view === "evaluate" && (
            <div className="evaluate-layout">
              <ModelLab
                table={table}
                insight={insight}
                datasetName={datasetName}
                defaultTarget={target}
              />
              <ClusterPanel
                table={table}
                insight={insight}
                onAdd={(step) => commitStep(step)}
              />
              <section className="section-panel tool-section">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">QUICK BASELINE</p>
                    <h2>
                      <BarChart3 size={18} /> Evaluate a simple baseline
                    </h2>
                  </div>
                  <span className="local-tag">
                    <LockKeyhole size={13} /> LOCAL ONLY
                  </span>
                </div>
                <p>
                  A mean-value or majority-class baseline with an ordered 80/20
                  split. This is a diagnostic, not a trained model. Use the
                  Model lab above for a shuffled, seeded test of a real model.
                </p>
                <div className="form-grid evaluation-form">
                  <label>
                    Prediction task
                    <select
                      value={task}
                      onChange={(event) => {
                        setTask(
                          event.target.value as "regression" | "classification",
                        );
                        setEvaluation(null);
                      }}
                    >
                      <option value="regression">Regression</option>
                      <option value="classification">Classification</option>
                    </select>
                  </label>
                  <label>
                    Target column
                    <select
                      value={target}
                      onChange={(event) => {
                        setTarget(event.target.value);
                        setEvaluation(null);
                      }}
                    >
                      {table.columns.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <div className="field-action">
                    <span>Evaluation</span>
                    <button
                      className="button button-dark"
                      type="button"
                      onClick={runEvaluation}
                      disabled={table.rows.length < 2}
                    >
                      <Sparkles size={15} /> Run baseline
                    </button>
                  </div>
                </div>
              </section>
              {evaluation ? (
                <section
                  className="section-panel results-section"
                  aria-live="polite"
                >
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">RESULTS</p>
                      <h2>
                        <Check size={18} /> Baseline complete
                      </h2>
                    </div>
                    <span>{evaluation.task}</span>
                  </div>
                  <div className="result-summary">
                    <div>
                      <span>TRAIN ROWS</span>
                      <strong>{evaluation.trainRows}</strong>
                    </div>
                    <div>
                      <span>TEST ROWS</span>
                      <strong>{evaluation.testRows}</strong>
                    </div>
                    <div>
                      <span>CONSTANT PREDICTION</span>
                      <strong>{evaluation.prediction}</strong>
                    </div>
                  </div>
                  {evaluation.metrics.map((metric) => (
                    <div className="metric-row" key={metric.label}>
                      <span>{metric.label}</span>
                      <b>{metric.value}</b>
                    </div>
                  ))}
                  <p className="result-note">
                    This baseline predicts one constant value from the first 80%
                    of rows. It does not fit features or establish model
                    quality.
                  </p>
                </section>
              ) : (
                <div className="evaluation-note">
                  <Activity size={18} />
                  <div>
                    <b>Start with a baseline</b>
                    <p>
                      Choose a numeric target for regression or a category for
                      classification. Evaluation runs locally on the current
                      data.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <footer className="page-footer">
            <span>
              <LockKeyhole size={13} /> No data egress by default
            </span>
            <span>
              CSV/TSV · {formatBytes(MAX_IMPORT_BYTES)} per file · 50,000 rows
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
