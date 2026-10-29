import { setIcon } from 'obsidian';
import { dueState, priorityIcon, relativeDate, visibleTags } from '../core/dates';
import type { BoardElement } from '../core/model';
import type { CardField, TagEntry } from '../core/settings';
import { splitTagChips } from '../core/tags';

const ICON_PLANNED = 'calendar';
const ICON_DUE = 'flag';
const ICON_CHECKLIST = 'check-square';

export interface AncestorChip {
  icon: string;
  title: string;
  levelName: string;
  fullTitle: string;
  /** Element-ID des Vorfahren, für den Hervorhebungs-/Filter-Klick (001, Ergänzung 2026-10-18); fehlt in der Einstellungen-Vorschau, die ohne Klick-Handler bleibt. */
  id?: string;
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
  tagList: TagEntry[],
): void {
  const titleRow = cardEl.createDiv({ cls: 'ktm-card-titlerow', attr: { title: card.title } });
  if (card.ticket !== undefined && fields.includes('ticket')) {
    titleRow.createSpan({ cls: 'ktm-card-ticket', text: `#${card.ticket}` });
  }
  titleRow.createSpan({ cls: 'ktm-card-title', text: card.title });

  renderMeta(cardEl, card, fields, today, done);
  renderChips(cardEl, card, fields, showProject, ancestors, tagList);
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

/** Geplant-/Fällig-Feld mit Icon, Label und Signalzustand (012 "Agenda" ruft es direkt für seine Spalten auf). */
export function metaItem(
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
  tagList: TagEntry[],
): void {
  const showParents = fields.includes('parents') && ancestors.length > 0;
  const showTags = fields.includes('tags');
  // Icon-Chips (002, Ergänzung 2026-10-25) don't count toward "höchstens drei,
  // dann +n" (F006 K8): only the text part goes through visibleTags.
  const split = showTags ? splitTagChips(card.tags, tagList) : { icons: [], text: [] };
  const tags = visibleTags(split.text);
  if (!showProject && !showParents && split.icons.length === 0 && tags.shown.length === 0) return;

  const chips = parent.createDiv({ cls: 'ktm-card-chips' });
  for (const field of fields) {
    if (field === 'project' && showProject) {
      // data-project (001, Ergänzung 2026-10-25): leer für intern, der
      // intern-Chip bleibt reine Anzeige (Wissen #390).
      chips.createSpan({
        cls: 'ktm-card-chip ktm-card-project',
        text: card.project || 'intern',
        attr: { 'data-project': card.project ?? '' },
      });
    }
    if (field === 'parents' && showParents) {
      for (const ancestor of ancestors) {
        renderParentChip(chips, ancestor.icon, ancestor.title, ancestor.levelName, ancestor.fullTitle, ancestor.id);
      }
    }
    if (field === 'tags' && showTags) {
      for (const chip of split.icons) {
        const iconChip = chips.createSpan({
          cls: 'ktm-card-chip ktm-chip is-icon',
          attr: { 'aria-label': chip.tag, 'data-tag': stripHash(chip.tag) },
        });
        setIcon(iconChip, chip.icon);
      }
      for (const tag of tags.shown) {
        chips.createSpan({
          cls: 'ktm-card-chip ktm-card-tag',
          text: stripHash(tag),
          attr: { 'data-tag': stripHash(tag) },
        });
      }
      if (tags.rest > 0) {
        chips.createSpan({ cls: 'ktm-card-chip ktm-card-tagmore', text: `+${tags.rest}` });
      }
    }
  }
}

/** Ebenen-Chip (Epic, Feature, …) wie auf der Karte; die Agenda ruft ihn für ihre Spalte "Epic › Feature" direkt auf. */
export function renderParentChip(
  parent: HTMLElement,
  icon: string,
  title: string,
  levelName: string,
  fullTitle: string,
  id?: string,
): void {
  const chip = parent.createSpan({
    cls: 'ktm-card-chip ktm-card-parent',
    attr: {
      'aria-label': `${levelName}: ${fullTitle}`,
      ...(id ? { 'data-ancestor-id': id } : {}),
    },
  });
  setIcon(chip, icon);
  chip.createSpan({ text: title });
}

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/**
 * Statusmarke (012 "Statusmarke"): Punkt plus Spaltenname, angehängt an die
 * Karte in Woche, Agenda und Matrix. Trägt nur `data-status`, keinen
 * Klick-Handler — der hängt BoardView an (installAncestorChipHandlers), wie
 * bei den übrigen Chips.
 */
export function renderStatusMark(cardEl: HTMLElement, status: string, columnName: string, tone: string): void {
  const mark = cardEl.createDiv({ cls: 'ktm-status', attr: { 'data-tone': tone, 'data-status': status } });
  mark.createSpan({ cls: 'ktm-status-dot' });
  mark.createSpan({ cls: 'ktm-status-name', text: columnName });
}
