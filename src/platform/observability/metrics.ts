export type MetricLabels = Record<string, string | number | boolean | null | undefined>;

export interface HistogramSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}

export interface MetricsSnapshot {
  generatedAt: string;
  counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  gauges: Array<{ name: string; labels: Record<string, string>; value: number }>;
  histograms: Array<{ name: string; labels: Record<string, string>; summary: HistogramSummary }>;
}

type MetricEntry = {
  labels: Record<string, string>;
  value: number;
};

type HistogramEntry = {
  labels: Record<string, string>;
  values: number[];
};

const MAX_HISTOGRAM_SAMPLES = 10_000;

const normalizeLabels = (labels: MetricLabels = {}): Record<string, string> => Object.fromEntries(
  Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, String(value)]),
);

const labelKey = (labels: Record<string, string>): string => JSON.stringify(labels);

const percentile = (sorted: number[], quantile: number): number => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
};

const prometheusLabels = (labels: Record<string, string>): string => {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
};

/**
 * In-process pilot metrics. Values are intentionally bounded and contain no request body,
 * identifiers, SQL parameter values, device tokens, or user PII.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, MetricEntry>>();
  private readonly gauges = new Map<string, Map<string, MetricEntry>>();
  private readonly histograms = new Map<string, Map<string, HistogramEntry>>();

  increment(name: string, labels: MetricLabels = {}, amount = 1): void {
    const normalized = normalizeLabels(labels);
    const key = labelKey(normalized);
    const entries = this.counters.get(name) ?? new Map<string, MetricEntry>();
    const previous = entries.get(key);
    entries.set(key, { labels: normalized, value: (previous?.value ?? 0) + amount });
    this.counters.set(name, entries);
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const normalized = normalizeLabels(labels);
    const key = labelKey(normalized);
    const entries = this.gauges.get(name) ?? new Map<string, MetricEntry>();
    entries.set(key, { labels: normalized, value });
    this.gauges.set(name, entries);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const normalized = normalizeLabels(labels);
    const key = labelKey(normalized);
    const entries = this.histograms.get(name) ?? new Map<string, HistogramEntry>();
    const entry = entries.get(key) ?? { labels: normalized, values: [] };
    entry.values.push(value);
    if (entry.values.length > MAX_HISTOGRAM_SAMPLES) entry.values.splice(0, entry.values.length - MAX_HISTOGRAM_SAMPLES);
    entries.set(key, entry);
    this.histograms.set(name, entries);
  }

  snapshot(now = new Date()): MetricsSnapshot {
    const counters = [...this.counters.entries()].flatMap(([name, entries]) => [...entries.values()].map((entry) => ({
      name,
      labels: entry.labels,
      value: entry.value,
    })));
    const gauges = [...this.gauges.entries()].flatMap(([name, entries]) => [...entries.values()].map((entry) => ({
      name,
      labels: entry.labels,
      value: entry.value,
    })));
    const histograms = [...this.histograms.entries()].flatMap(([name, entries]) => [...entries.values()].map((entry) => {
      const sorted = [...entry.values].sort((left, right) => left - right);
      const summary: HistogramSummary = {
        count: sorted.length,
        sum: sorted.reduce((total, value) => total + value, 0),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      };
      return { name, labels: entry.labels, summary };
    }));
    return { generatedAt: now.toISOString(), counters, gauges, histograms };
  }

  toPrometheus(now = new Date()): string {
    const snapshot = this.snapshot(now);
    const lines: string[] = [];
    for (const metric of snapshot.counters) lines.push(`${metric.name}${prometheusLabels(metric.labels)} ${metric.value}`);
    for (const metric of snapshot.gauges) lines.push(`${metric.name}${prometheusLabels(metric.labels)} ${metric.value}`);
    for (const metric of snapshot.histograms) {
      lines.push(`${metric.name}_count${prometheusLabels(metric.labels)} ${metric.summary.count}`);
      lines.push(`${metric.name}_sum${prometheusLabels(metric.labels)} ${metric.summary.sum}`);
      lines.push(`${metric.name}_p50${prometheusLabels(metric.labels)} ${metric.summary.p50}`);
      lines.push(`${metric.name}_p95${prometheusLabels(metric.labels)} ${metric.summary.p95}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new MetricsRegistry();
