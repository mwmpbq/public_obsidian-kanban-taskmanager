import { setIcon } from 'obsidian';
import { dueState, priorityIcon, relativeDate, visibleTags } from '../core/dates';
import type { BoardElement } from '../core/model';
import type { CardField } from '../core/settings';

const ICON_PLANNED = 'calendar';
const ICON_DUE = 'flag';
const ICON_CHECKLIST = 'check-square';

export interface AncestorChip {
  icon: string;
  title: string;
  levelName: string;
  fullTitle: string;
}

/**
 * Renders the closed card's title row, meta row and chip row — the part the
 * board and the settings page's `.ktm-preview` must render identically (F058:
 * the preview only proves the card-fields drag order if it is the same
 * renderer as the board, K4). `fields` is the already-ordered, already-filtered
 * list from resolveCardFields/settingsFor: order within the meta row (planned,
 * due, checklist) and the chip row (project, parents, tags) follows this list;
 * the priority icon stays right-aligned via CSS regardless of its position in
 * `fields`. `ancestors` is precomputed by the caller (BoardView resolves it
 * per-project via projectSettings, the settings preview hands in a fixed
 * sample) — this module has no access to project settings.
 */
export function renderCardFace(
  cardEl: HTMLElement,
  card: Pick<BoardElement, 'title' | 'ticket' | 'planned' | 'due' | 'checklist' | 'priority' | 'project' | 'tags'>,
  fields: CardField[],
  today: string,
  done: boolean,
  showProject: boolean,
  ancestors: AncestorChip[],
): void {
  const titleRow = cardEl.createDiv({ cls: 'ktm-card-titlerow', attr: { title: card.title } });
  if (card.ticket !== undefined && fields.includes('ticket')) {
    titleRow.createSpan({ cls: 'ktm-card-ticket', text: `#${card.ticket}` });
  }
  titleRow.createSpan({ cls: 'ktm-card-title', text: card.title });

  renderMeta(cardEl, card, fields, today, done);
  renderChips(cardEl, card, fields, showProject, ancestors);
}

function renderMeta(
  parent: HTMLElement,
  card: Pick<BoardElement, 'planned' | 'due' | 'checklist' | 'priority'>,
  fields: CardField[],
  today: string,
  done: boolean,
): void {
  const priority = done ? undefined : priorityIcon(card.priority);
  const showPriority = fields.includes('priority') && !!priority;
  const metaFields = fields.filter(
    (field): field is 'planned' | 'due' | 'checklist' =>
      field === 'planned' || field === 'due' || field === 'checklist',
  );
  const hasContent =
    (metaFields.includes('planned') && !!card.planned) ||
    (metaFields.includes('due') && !!card.due) ||
    (metaFields.includes('checklist') && !!card.checklist) ||
    showPriority;
  if (!hasContent) return;

  const meta = parent.createDiv({ cls: 'ktm-card-meta' });

  for (const field of metaFields) {
    if (field === 'planned' && card.planned) {
      const state = !done && dueState(card.planned, today) === 'today' ? 'today' : undefined;
      metaItem(meta, 'ktm-card-planned', ICON_PLANNED, relativeDate(card.planned, today), {
        'data-planned': state,
      });
    }
    if (field === 'due' && card.due) {
      const state = done ? undefined : dueState(card.due, today);
      metaItem(meta, 'ktm-card-due', ICON_DUE, relativeDate(card.due, today), { 'data-due': state });
    }
    if (field === 'checklist' && card.checklist) {
      metaItem(meta, 'ktm-card-checklist', ICON_CHECKLIST, `${card.checklist.done}/${card.checklist.total}`);
    }
  }

  if (showPriority && priority) {
    const prioEl = meta.createSpan({
      cls: 'ktm-card-meta-item ktm-card-priority',
      attr: { 'data-priority': String(card.priority) },
    });
    setIcon(prioEl, priority);
  }
}

function metaItem(
  parent: HTMLElement,
  cls: string,
  icon: string,
  label: string,
  state?: Record<string, string | undefined>,
): void {
  const item = parent.createSpan({ cls: `ktm-card-meta-item ${cls}` });
  if (state) {
    for (const [name, value] of Object.entries(state)) {
      if (value) item.setAttribute(name, value);
    }
  }
  const iconEl = item.createSpan({ cls: 'ktm-card-meta-icon' });
  setIcon(iconEl, icon);
  item.createSpan({ text: label });
}

function renderChips(
  parent: HTMLElement,
  card: Pick<BoardElement, 'project' | 'tags'>,
  fields: CardField[],
  showProject: boolean,
  ancestors: AncestorChip[],
): void {
  const showParents = fields.includes('parents') && ancestors.length > 0;
  const showTags = fields.includes('tags');
  const tags = showTags ? visibleTags(card.tags) : { shown: [], rest: 0 };
  if (!showProject && !showParents && tags.shown.length === 0) return;

  const chips = parent.createDiv({ cls: 'ktm-card-chips' });
  for (const field of fields) {
    if (field === 'project' && showProject) {
      chips.createSpan({ cls: 'ktm-card-chip ktm-card-project', text: card.project || 'intern' });
    }
    if (field === 'parents' && showParents) {
      for (const ancestor of ancestors) {
        renderParentChip(chips, ancestor.icon, ancestor.title, ancestor.levelName, ancestor.fullTitle);
      }
    }
    if (field === 'tags' && showTags) {
      for (const tag of tags.shown) {
        chips.createSpan({ cls: 'ktm-card-chip ktm-card-tag', text: stripHash(tag) });
      }
      if (tags.rest > 0) {
        chips.createSpan({ cls: 'ktm-card-chip ktm-card-tagmore', text: `+${tags.rest}` });
      }
    }
  }
}

function renderParentChip(parent: HTMLElement, icon: string, title: string, levelName: string, fullTitle: string): void {
  const chip = parent.createSpan({
    cls: 'ktm-card-chip ktm-card-parent',
    attr: { 'aria-label': `${levelName}: ${fullTitle}` },
  });
  setIcon(chip, icon);
  chip.createSpan({ text: title });
}

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}
