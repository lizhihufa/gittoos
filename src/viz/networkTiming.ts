const KEY = "qingzhi.networkTiming";

export type TimingKind = "push" | "pull" | "fetch" | "clone";

export type TimingSample = {
  kind: TimingKind;
  ms: number;
  at: number;
  label?: string;
};

const MAX = 40;

export function loadTimings(): TimingSample[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TimingSample[];
    return Array.isArray(parsed) ? parsed.slice(-MAX) : [];
  } catch {
    return [];
  }
}

export function recordTiming(sample: TimingSample) {
  const next = [...loadTimings(), sample].slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}
