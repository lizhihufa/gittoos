import type { CommitInfo } from "../types";

export type CalendarDay = {
  date: string;
  count: number;
  /** 0–4 intensity bucket */
  level: number;
};

function dayKey(dateStr: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(dateStr);
  return m ? m[1]! : null;
}

/** Last `weeks` weeks of contribution density from commit dates. */
export function buildContribCalendar(
  commits: CommitInfo[],
  weeks = 26,
): CalendarDay[] {
  const map = new Map<string, number>();
  for (const c of commits) {
    const key = dayKey(c.date);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - weeks * 7 + 1);
  // align to Sunday
  start.setDate(start.getDate() - start.getDay());

  const days: CalendarDay[] = [];
  const cursor = new Date(start);
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));

  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${d}`;
    const count = map.get(key) ?? 0;
    const level =
      count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
    days.push({ date: key, count, level });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
