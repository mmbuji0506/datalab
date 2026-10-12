import { useState, type ChangeEvent } from "react";
import { Combine, FileUp, Rows3 } from "lucide-react";
import {
  appendTables,
  joinTables,
  parseDelimitedFile,
  validateImportFile,
  type DataTable,
  type JoinMode,
} from "./workbench";

type IntegrationMode = "append" | JoinMode;

type IntegrationPanelProps = {
  table: DataTable;
  onApply: (table: DataTable) => void;
};

export function IntegrationPanel({ table, onApply }: IntegrationPanelProps) {
  const [secondary, setSecondary] = useState<DataTable | null>(null);
  const [mode, setMode] = useState<IntegrationMode>("append");
  const [leftKey, setLeftKey] = useState(table.columns[0] ?? "");
  const [rightKey, setRightKey] = useState("");
  const [error, setError] = useState("");

  async function loadSecondary(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const validationError = validateImportFile(file);
    if (validationError) {
      setError(validationError);
      setSecondary(null);
      return;
    }
    try {
      const parsed = parseDelimitedFile(await file.text(), file.name);
      setSecondary(parsed);
      setLeftKey(table.columns[0] ?? "");
      setRightKey(parsed.columns[0] ?? "");
      setError("");
    } catch (cause) {
      setSecondary(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "The second dataset could not be read.",
      );
    }
  }

  function integrate() {
    if (!secondary) return;
    try {
      const result =
        mode === "append"
          ? appendTables(table, secondary)
          : joinTables(table, secondary, leftKey, rightKey, mode);
      onApply(result);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The datasets could not be combined.",
      );
    }
  }

  return (
    <section className="section-panel integration-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DATA INTEGRATION</p>
          <h2>
            <Combine size={18} /> Combine local datasets
          </h2>
        </div>
        {secondary && (
          <span>{secondary.rows.length.toLocaleString()} second rows</span>
        )}
      </div>
      <p className="integration-description">
        Load another CSV/TSV from this device, then append aligned rows or join
        on matching keys. Output limits still apply.
      </p>
      <div className="integration-controls">
        <label
          className="button button-secondary integration-file"
          htmlFor="secondary-dataset"
        >
          <FileUp size={15} />{" "}
          {secondary ? secondary.sourceName : "Choose second dataset"}
          <input
            id="secondary-dataset"
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            onChange={loadSecondary}
          />
        </label>
        <label>
          Combine mode
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as IntegrationMode)}
          >
            <option value="append">Append rows</option>
            <option value="inner">Inner join</option>
            <option value="left">Left join</option>
          </select>
        </label>
        {mode !== "append" && secondary && (
          <>
            <label>
              Current key
              <select
                value={leftKey}
                onChange={(event) => setLeftKey(event.target.value)}
              >
                {table.columns.map((column) => (
                  <option key={column} value={column}>
                    {column}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Second key
              <select
                value={rightKey}
                onChange={(event) => setRightKey(event.target.value)}
              >
                {secondary.columns.map((column) => (
                  <option key={column} value={column}>
                    {column}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="integration-error">
          {error}
        </p>
      )}
      <div className="integration-footer">
        <span>
          <Rows3 size={14} /> {table.rows.length.toLocaleString()} current rows
          · local only
        </span>
        <button
          className="button button-dark"
          type="button"
          onClick={integrate}
          disabled={!secondary}
        >
          <Combine size={15} />{" "}
          {mode === "append"
            ? "Append datasets"
            : mode === "inner"
              ? "Inner join"
              : "Left join"}
        </button>
      </div>
    </section>
  );
}
