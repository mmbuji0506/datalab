import type { ChangeEvent } from "react";
import { FileDown, FileUp, History, Undo2 } from "lucide-react";
import { describeStep, needsExternalData, type Step } from "./recipe.ts";

type HistoryPanelProps = {
  steps: Step[];
  onUndo: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
};

export function HistoryPanel({ steps, onUndo, onExport, onImport }: HistoryPanelProps) {
  const external = needsExternalData(steps);

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) onImport(file);
  }

  return (
    <section className="section-panel tool-section history-panel" aria-label="Change history">
      <div className="section-heading">
        <div>
          <p className="eyebrow">REPRODUCIBLE WORKFLOW</p>
          <h2>
            <History size={18} /> Change history
          </h2>
        </div>
        <span>
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      </div>
      <p>
        Every change is recorded as a step. Undo removes the last one, and a recipe file lets you repeat the same
        preparation on next month&apos;s data.
      </p>
      {steps.length === 0 ? (
        <div className="history-empty">No changes yet. Apply an operation or a suggested fix to start a recipe.</div>
      ) : (
        <ol className="history-list">
          {steps.map((step, index) => (
            <li key={`${index}-${step.op}`}>{describeStep(step)}</li>
          ))}
        </ol>
      )}
      <div className="tool-actions history-actions">
        <button className="button button-secondary" type="button" onClick={onUndo} disabled={steps.length === 0}>
          <Undo2 size={15} /> Undo last step
        </button>
        <button
          className="button button-secondary"
          type="button"
          onClick={onExport}
          disabled={steps.length === 0 || external}
          title={external ? "Recipes cannot include a combined file" : "Download these steps as a recipe file"}
        >
          <FileDown size={15} /> Save recipe
        </button>
        <label className="button button-secondary">
          <FileUp size={15} /> Apply recipe…
          <input type="file" accept=".json,application/json" onChange={chooseFile} />
        </label>
      </div>
      {external && (
        <p className="prepare-note">
          This session combines another file, so it cannot be saved as a recipe. Export the prepared CSV instead.
        </p>
      )}
    </section>
  );
}
