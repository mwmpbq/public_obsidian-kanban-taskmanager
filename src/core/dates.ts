const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function parse(iso: string): Ymd | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return undefined;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

// UTC midnight avoids the day-shift that local-time parsing causes across DST
// and time-zone boundaries; only the calendar day matters here.
function utc(p: Ymd): number {
  return Date.UTC(p.y, p.m - 1, p.d);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Today's date, `YYYY-MM-DD`: `override` (the caller's `window.__ktmToday`,
 * F088/wissen #707) when it parses as one, otherwise the system date.
 * Deliberately takes the raw value rather than a `Window`, so this stays
 * usable from both BoardView (has one) and main.ts (a plugin, not a view).
 */
export function todayISO(override?: unknown): string {
  if (typeof override === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function dayDiff(dateISO: string, todayISO: string): number | undefined {
  const a = parse(dateISO);
  const b = parse(todayISO);
  if (!a || !b) return undefined;
  return Math.round((utc(a) - utc(b)) / 86400000);
}

export function absoluteDate(dateISO: string, todayISO: string): string {
  const a = parse(dateISO);
  if (!a) return dateISO;
  const b = parse(todayISO);
  if (b && a.y !== b.y) return `${pad(a.d)}.${pad(a.m)}.${a.y}`;
  const weekday = WEEKDAYS[new Date(utc(a)).getUTCDay()];
  return `${weekday} ${pad(a.d)}.${pad(a.m)}.`;
}

// Weekday and full date for the "Heute" header, e.g. "Mi 09.09.2026".
export function fullDate(dateISO: string): string {
  const a = parse(dateISO);
  if (!a) return dateISO;
  const weekday = WEEKDAYS[new Date(utc(a)).getUTCDay()];
  return `${weekday} ${pad(a.d)}.${pad(a.m)}.${a.y}`;
}

export function relativeDate(dateISO: string, todayISO: string): string {
  const diff = dayDiff(dateISO, todayISO);
  if (diff === undefined) return dateISO;
  if (diff < 0) return `vor ${-diff} ${-diff === 1 ? 'Tag' : 'Tagen'}`;
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  if (diff <= 6) return `in ${diff} Tagen`;
  return absoluteDate(dateISO, todayISO);
}

export type DueState = 'overdue' | 'today' | undefined;

export function dueState(dateISO: string, todayISO: string): DueState {
  const diff = dayDiff(dateISO, todayISO);
  if (diff === undefined) return undefined;
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return undefined;
}

export function priorityIcon(priority: number): string | undefined {
  if (priority === 1) return 'chevrons-up';
  if (priority === 2) return 'chevron-up';
  if (priority === 4) return 'chevron-down';
  return undefined;
}

// The detail view labels the two extremes; the middle priorities carry the
// number alone.
export function priorityLabel(priority: number): string {
  if (priority === 1) return '1 hoch';
  if (priority === 4) return '4 niedrig';
  return String(priority);
}

export interface VisibleTags {
  shown: string[];
  rest: number;
}

export function visibleTags(tags: string[], max = 3): VisibleTags {
  return { shown: tags.slice(0, max), rest: Math.max(0, tags.length - max) };
}

// Accepts what the date field types: ISO or the German day-first form. Rejects
// anything that is not a real calendar day (31.02. etc.), so a typo keeps the
// field open instead of silently storing a shifted date.
export function parseDateInput(input: string): string | undefined {
  const trimmed = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const de = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  let y: number;
  let m: number;
  let d: number;
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else if (de) {
    d = Number(de[1]);
    m = Number(de[2]);
    y = Number(de[3]);
  } else {
    return undefined;
  }
  const check = new Date(utc({ y, m, d }));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return undefined;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

export interface CalendarDay {
  date: string;
  day: number;
  otherMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
}

export interface CalendarWeek {
  week: number;
  days: CalendarDay[];
}

// ISO 8601 week number: the week of the Thursday that falls in the same
// Monday-start week as the given day (weeks.iso, RFC compatible with the "KW"
// column of the calendar popover).
function isoWeek(dayUtcMs: number): number {
  const thursday = new Date(dayUtcMs);
  const mondayOffset = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - mondayOffset + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstOffset = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstOffset + 3);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
}

// The weeks that cover a calendar month, Monday to Sunday, with the leading
// and trailing days of the neighbouring months included so every week is full
// (matches the 8-column KW/Mo-So popover from DESIGN.md).
export function monthGrid(
  year: number,
  month: number,
  todayISO: string,
  selectedISO?: string,
): CalendarWeek[] {
  const first = Date.UTC(year, month - 1, 1);
  const firstWeekday = (new Date(first).getUTCDay() + 6) % 7;
  const gridStart = first - firstWeekday * 86400000;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = Date.UTC(year, month - 1, lastDay);
  const lastWeekday = (new Date(last).getUTCDay() + 6) % 7;
  const gridEnd = last + (6 - lastWeekday) * 86400000;

  const weeks: CalendarWeek[] = [];
  for (let t = gridStart; t <= gridEnd; t += 7 * 86400000) {
    const days: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const dayMs = t + i * 86400000;
      const cell = new Date(dayMs);
      const y = cell.getUTCFullYear();
      const m = cell.getUTCMonth() + 1;
      const d = cell.getUTCDate();
      const iso = `${y}-${pad(m)}-${pad(d)}`;
      days.push({
        date: iso,
        day: d,
        otherMonth: m !== month || y !== year,
        isToday: iso === todayISO,
        isSelected: iso === selectedISO,
      });
    }
    weeks.push({ week: isoWeek(t), days });
  }
  return weeks;
}
