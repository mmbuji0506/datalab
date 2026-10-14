import type { HistogramBin } from "./analytics.ts";

type MiniHistogramProps = {
  bins: HistogramBin[];
  label: string;
};

/** A tiny distribution sketch: one bar per bin, scaled to the tallest bin. */
export function MiniHistogram({ bins, label }: MiniHistogramProps) {
  if (bins.length === 0) return null;
  const tallest = Math.max(...bins.map((bin) => bin.count));
  return (
    <div className="mini-histogram" role="img" aria-label={`Distribution of ${label}`}>
      {bins.map((bin, index) => (
        <i
          key={index}
          style={{ height: `${Math.max(6, (bin.count / tallest) * 100)}%` }}
          title={`${format(bin.start)} to ${format(bin.end)}: ${bin.count} row${bin.count === 1 ? "" : "s"}`}
        />
      ))}
    </div>
  );
}

function format(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
