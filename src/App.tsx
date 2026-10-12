import { lazy, Suspense, useState, type ChangeEvent } from "react";
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
  WandSparkles,
} from "lucide-react";
import { CorrelationPanel } from "./CorrelationPanel";
import { IntegrationPanel } from "./IntegrationPanel";
import "./App.css";
import {
  correlationMatrix,
  dropDuplicateRows,
  dropRowsWithMissingValues,
  evaluateBaseline,
  fillMissing,
  filterRows,
  formatBytes,
  MAX_CORRELATION_COLUMNS,
  MAX_IMPORT_BYTES,
  normalizeNumericColumn,
  parseDelimitedFile,
  profileTable,
  removeColumn,
  renameColumn,
  serializeCsv,
  trimTextColumn,
  validateImportFile,
  type BaselineEvaluation,
  type CorrelationMatrix,
  type DataTable,
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
  | "normalize-z-score";

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

function App() {
  const [table, setTable] = useState<DataTable>(initialTable);
  const [source, setSource] = useState<DataTable>(initialTable);
  const [profile, setProfile] = useState(() => profileTable(initialTable));
  const [view, setView] = useState<View>("data");
  const [isSample, setIsSample] = useState(true);
  const [modified, setModified] = useState(false);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [filterColumn, setFilterColumn] = useState(initialTable.columns[1]);
  const [filterOperator, setFilterOperator] =
    useState<FilterOperator>("equals");
  const [filterValue, setFilterValue] = useState("North");
  const [filtered, setFiltered] = useState(false);
  const [column, setColumn] = useState(initialTable.columns[0]);
  const [transform, setTransform] = useState<Transform>("rename");
  const [renameValue, setRenameValue] = useState("");
  const [replacement, setReplacement] = useState("Unknown");
  const [correlationColumns, setCorrelationColumns] = useState([
    "visits",
    "orders",
    "revenue",
  ]);
  const [correlations, setCorrelations] = useState<CorrelationMatrix | null>(
    null,
  );
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
  const needsOperand =
    filterOperator === "empty" || filterOperator === "not-empty";

  function updateTable(next: DataTable) {
    const nextProfile = profileTable(next);
    setTable(next);
    setProfile(nextProfile);
    setModified(true);
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
      setModified(false);
      setFileSize(file.size);
      setFiltered(false);
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

  function applyFilter() {
    try {
      updateTable(filterRows(table, filterColumn, filterOperator, filterValue));
      setFiltered(true);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The filter could not be applied.",
      );
    }
  }

  function applyTransform() {
    try {
      let next: DataTable;
      switch (transform) {
        case "rename":
          next = renameColumn(table, column, renameValue);
          break;
        case "fill":
          next = fillMissing(table, column, replacement);
          break;
        case "remove":
          next = removeColumn(table, column);
          break;
        case "trim":
          next = trimTextColumn(table, column);
          break;
        case "drop-missing":
          next = dropRowsWithMissingValues(table, [column]);
          break;
        case "deduplicate":
          next = dropDuplicateRows(table);
          break;
        case "normalize-min-max":
          next = normalizeNumericColumn(table, column, "min-max");
          break;
        case "normalize-z-score":
          next = normalizeNumericColumn(table, column, "z-score");
          break;
      }
      updateTable(next);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change could not be applied.",
      );
    }
  }

  function calculateCorrelations() {
    try {
      setCorrelations(correlationMatrix(table, correlationColumns));
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
    setModified(false);
    setFiltered(false);
    setEvaluation(null);
    setCorrelations(null);
    setCorrelationError("");
    setError("");
    setColumn(source.columns[0]);
    setFilterColumn(source.columns[0]);
    setTarget(source.columns[source.columns.length - 1]);
  }

  function exportCsv() {
    const csv = serializeCsv(table);
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
                  <span>Delimited text · UTF-8</span>
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
                      <small>{item.numeric ? "NUMERIC" : "TEXT"}</small>
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
                      <option value="rename">Rename a column</option>
                      <option value="fill">Fill missing values</option>
                      <option value="trim">Trim text whitespace</option>
                      <option value="drop-missing">Remove missing rows</option>
                      <option value="deduplicate">Remove duplicate rows</option>
                      <option value="normalize-min-max">
                        Normalize to 0–1
                      </option>
                      <option value="normalize-z-score">
                        Standardize (z-score)
                      </option>
                      <option value="remove">Remove a column</option>
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
                  updateTable(integrated);
                  setFiltered(false);
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
              <section className="section-panel tool-section">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">BASELINE CHECK</p>
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
                  split. This is a diagnostic, not a trained model.
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
