import { describe, expect, it } from 'vitest';
import {
  absoluteDate,
  dueState,
  fullDate,
  monthGrid,
  parseDateInput,
  priorityIcon,
  priorityLabel,
  relativeDate,
  visibleTags,
} from './dates';

const TODAY = '2026-09-09';

describe('relativeDate', () => {
  it('names today, tomorrow and near future', () => {
    expect(relativeDate('2026-09-09', TODAY)).toBe('heute');
    expect(relativeDate('2026-09-10', TODAY)).toBe('morgen');
    expect(relativeDate('2026-09-12', TODAY)).toBe('in 3 Tagen');
    expect(relativeDate('2026-09-15', TODAY)).toBe('in 6 Tagen');
  });

  it('names overdue days', () => {
    expect(relativeDate('2026-09-07', TODAY)).toBe('vor 2 Tagen');
    expect(relativeDate('2026-09-08', TODAY)).toBe('vor 1 Tag');
  });

  it('falls back to an absolute date from seven days on', () => {
    expect(relativeDate('2026-09-22', TODAY)).toBe('Di 22.09.');
    expect(relativeDate('2026-09-30', TODAY)).toBe('Mi 30.09.');
    expect(relativeDate('2027-01-12', TODAY)).toBe('12.01.2027');
  });

  it('returns the raw value for an unparsable date', () => {
    expect(relativeDate('irgendwann', TODAY)).toBe('irgendwann');
  });
});

describe('absoluteDate', () => {
  it('carries the weekday within the current year', () => {
    expect(absoluteDate('2026-09-22', TODAY)).toBe('Di 22.09.');
  });

  it('drops the weekday and adds the year in another year', () => {
    expect(absoluteDate('2027-01-12', TODAY)).toBe('12.01.2027');
  });
});

describe('fullDate', () => {
  it('carries the weekday and the full date with year', () => {
    expect(fullDate('2026-09-09')).toBe('Mi 09.09.2026');
  });

  it('returns the raw value for an unparsable date', () => {
    expect(fullDate('irgendwann')).toBe('irgendwann');
  });
});

describe('dueState', () => {
  it('marks overdue and today, nothing else', () => {
    expect(dueState('2026-09-07', TODAY)).toBe('overdue');
    expect(dueState('2026-09-09', TODAY)).toBe('today');
    expect(dueState('2026-09-12', TODAY)).toBeUndefined();
  });
});

describe('priorityIcon', () => {
  it('maps only 1, 2 and 4 to an icon', () => {
    expect(priorityIcon(1)).toBe('chevrons-up');
    expect(priorityIcon(2)).toBe('chevron-up');
    expect(priorityIcon(3)).toBeUndefined();
    expect(priorityIcon(4)).toBe('chevron-down');
  });
});

describe('priorityLabel', () => {
  it('labels the extremes and leaves the middle as the number', () => {
    expect(priorityLabel(1)).toBe('1 hoch');
    expect(priorityLabel(2)).toBe('2');
    expect(priorityLabel(3)).toBe('3');
    expect(priorityLabel(4)).toBe('4 niedrig');
  });
});

describe('visibleTags', () => {
  it('shows up to three tags and counts the rest', () => {
    expect(visibleTags(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c'], rest: 1 });
    expect(visibleTags(['a', 'b'])).toEqual({ shown: ['a', 'b'], rest: 0 });
    expect(visibleTags([])).toEqual({ shown: [], rest: 0 });
  });
});

describe('parseDateInput', () => {
  it('accepts ISO and the German day-first form', () => {
    expect(parseDateInput('2026-12-03')).toBe('2026-12-03');
    expect(parseDateInput('03.12.2026')).toBe('2026-12-03');
  });

  it('trims surrounding whitespace', () => {
    expect(parseDateInput('  2026-12-03  ')).toBe('2026-12-03');
  });

  it('rejects unparsable and non-existent dates', () => {
    expect(parseDateInput('irgendwann')).toBeUndefined();
    expect(parseDateInput('31.02.2026')).toBeUndefined();
    expect(parseDateInput('2026-13-01')).toBeUndefined();
    expect(parseDateInput('')).toBeUndefined();
  });
});

describe('monthGrid', () => {
  it('covers September 2026 with week 36 to 40, Monday to Sunday', () => {
    const weeks = monthGrid(2026, 9, '2026-09-09', '2026-09-07');
    expect(weeks.map((w) => w.week)).toEqual([36, 37, 38, 39, 40]);
    expect(weeks[0].days[0]).toMatchObject({ date: '2026-08-31', day: 31, otherMonth: true });
    expect(weeks[0].days[6]).toMatchObject({ date: '2026-09-06', day: 6, otherMonth: false });
    expect(weeks[4].days[6]).toMatchObject({ date: '2026-10-04', day: 4, otherMonth: true });
  });

  it('marks today and the selected day, mutually independent', () => {
    const weeks = monthGrid(2026, 9, '2026-09-09', '2026-09-07');
    const flat = weeks.flatMap((w) => w.days);
    expect(flat.find((d) => d.date === '2026-09-09')).toMatchObject({ isToday: true, isSelected: false });
    expect(flat.find((d) => d.date === '2026-09-07')).toMatchObject({ isToday: false, isSelected: true });
    expect(flat.filter((d) => d.isSelected)).toHaveLength(1);
  });
});
