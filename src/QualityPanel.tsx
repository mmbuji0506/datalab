import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { QualityIssue, QualityReport, Severity } from "./analytics.ts";
import type { Step } from "./recipe.ts";

type QualityPanelProps = {
  report: QualityReport;
  rowCount: number;
  onApply: (step: Step) => void;
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "NOTE",
};

const VISIBLE_ISSUES = 5;

const COMPONENT_LABELS: Array<{ key: keyof QualityReport["components"]; label: string }> = [
  { key: "completeness", label: "Completeness" },
  { key: "uniqueness", label: "Uniqueness" },
  { key: "consistency", label: "Consistency" },
  { key: "validity", label: "Validity" },
];

export function QualityPanel({ report, rowCount, onApply }: QualityPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const issues = showAll ? report.issues : report.issues.slice(0, VISIBLE_ISSUES);
  const actionable = report.issues.filter((issue) => issue.fix && issue.severity !== "info").length;
  const tone = report.score >= 90 ? "good" : report.score >= 70 ? "fair" : "poor";

  return (
    <section className="section-panel quality-panel" aria-label="Data quality">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DATA QUALITY</p>
          <h2>
            <ShieldCheck size={18} /> Quality check
          </h2>
        </div>
        <span>
          {actionable} fixable issue{actionable === 1 ? "" : "s"}
        </span>
      </div>
      <div className="quality-body">
        <div className="quality-score">
          <div className={`score-ring ${tone}`} role="img" aria-label={`Quality score ${report.score} out of 100`}>
            <strong>{rowCount === 0 ? "—" : report.score}</strong>
            <small>/ 100</small>
          </div>
          <div className="quality-components">
            {COMPONENT_LABELS.map(({ key, label }) => (
              <div key={key}>
                <span>
                  {label} <b>{report.components[key]}%</b>
                </span>
                <div className="meter">
                  <i style={{ width: `${report.components[key]}%` }} />
                </div>
              </div>
            ))}
          </div>
          <details className="quality-method">
            <summary>How is the score calculated?</summary>
            <p>
              A weighted average: completeness 35% (non-empty cells), uniqueness 20% (rows that are not exact
              duplicates), consistency 25% (columns free of stray spaces, “N/A” markers, mixed spellings and
              text-formatted numbers) and validity 20% (numeric values inside the 1.5 × IQR range). It points you
              to where to look first; it is not a guarantee of correctness.
            </p>
          </details>
        </div>
        <div className="quality-issues">
          {report.issues.length === 0 ? (
            <div className="quality-clear">
              <ShieldCheck size={18} />
              <span>No issues found. Missing values, duplicates, formatting and outliers all look clean.</span>
            </div>
          ) : (
            <ul>
              {issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} onApply={onApply} />
              ))}
            </ul>
          )}
          {report.issues.length > VISIBLE_ISSUES && (
            <button type="button" className="link-button" onClick={() => setShowAll((current) => !current)}>
              {showAll ? "Show fewer" : `Show all ${report.issues.length} findings`}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function IssueRow({ issue, onApply }: { issue: QualityIssue; onApply: (step: Step) => void }) {
  const fix = issue.fix;
  return (
    <li className={`issue issue-${issue.severity}`}>
      <span className="severity">{SEVERITY_LABEL[issue.severity]}</span>
      <div>
        <b>{issue.title}</b>
        <p>{issue.detail}</p>
      </div>
      {fix && (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onApply(fix)}
          aria-label={`${issue.fixLabel}: ${issue.title}`}
        >
          {issue.fixLabel}
        </button>
      )}
    </li>
  );
}
