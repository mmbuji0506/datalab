import type { ColumnInsight } from "./analytics.ts";
import { MiniHistogram } from "./MiniHistogram.tsx";

function compact(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Extra profile detail: spread, outliers, a distribution sketch, and hygiene flags. */
export function ColumnDetail({ insight }: { insight: ColumnInsight | undefined }) {
  if (!insight) return null;
  const flags: string[] = [];
  if (insight.whitespaceValues > 0) flags.push("stray spaces");
  if (insight.missingTokens > 0) flags.push("“N/A” markers");
  if (insight.caseVariantGroups > 0) flags.push("mixed spellings");
  if (insight.looseNumeric) flags.push("numbers as text");
  const stats = insight.stats;
  if (!stats && flags.length === 0) return null;
  return (
    <div className="column-detail">
      {stats && (
        <>
          <p>
            Median <b>{compact(stats.median)}</b>
            <span>Std dev</span>
            <b>{stats.std === null ? "—" : compact(stats.std)}</b>
            {stats.outliers > 0 && <em>{stats.outliers} outlier{stats.outliers === 1 ? "" : "s"}</em>}
          </p>
          <MiniHistogram bins={insight.histogram} label={insight.name} />
        </>
      )}
      {flags.length > 0 && (
        <div className="hygiene-flags">
          {flags.map((flag) => (
            <span key={flag}>{flag}</span>
          ))}
        </div>
      )}
    </div>
  );
}
