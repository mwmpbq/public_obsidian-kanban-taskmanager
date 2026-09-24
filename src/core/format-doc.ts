import { settingsFor, type GeneralSettings, type ProjectSettings } from './settings';

export const FORMAT_NOTE_PATH = '_Tasks/Aufgabenformat.md';

// The fields of spec 008, in the order the description lists them. They are the
// interface to Claude and are named verbatim in the note below, so a single
// source keeps note and test in step.
export const TASK_FIELDS = [
  'type',
  'status',
  'title',
  'project',
  'priority',
  'planned',
  'due',
  'completed',
  'ticket',
  'summary',
  'tags',
] as const;

export const FORMAT_NOTE = `# Aufgabenformat

Diese Notiz beschreibt, wie eine Aufgabe im Vault abgelegt wird, damit sie ohne die
Oberfläche angelegt werden kann und trotzdem korrekt auf dem Board erscheint. Alles ist
Markdown, die Ordnerstruktur ist das Datenmodell.

## Zwei Formen

**Eingeordnete Aufgabe:** ein Ordner unterhalb des Root-Ordners eines Projekts (Standard
\`02_Projects/<Projekt>/Deliverables/\`). Der Ordner heißt \`YYYY-MM-DD_[TicketID_]<slug>/\`
und enthält eine Notiz \`_<ordnername>.md\`. Übergeordnete Ebenen (Epic, Feature) sind
selbst solche Ordner; die Aufgabe liegt als Unterordner darin oder direkt unter dem
Root-Ordner. Weitere Dateien im Ordner (Skripte, Arbeitsnotizen) erscheinen nicht auf dem
Board.

**Atomare Aufgabe:** eine einzelne Notiz \`YYYY-MM-DD_<slug>.md\` im Ordner
\`_Tasks/Atomic/\`, ohne Ordner und ohne Hierarchie. Das Frontmatter ist identisch zur
Notiz einer eingeordneten Aufgabe; die Projektzuordnung steht im Feld \`project\`.

## Felder des Frontmatters

Ein Feld steht nur in der Notiz, wenn es einen Wert hat. Kein leeres \`completed:\`.

| Feld | Typ | Pflicht | Werte |
|---|---|---|---|
| \`type\` | Text | ja | Ebenenschlüssel aus den Einstellungen, Standard \`epic\`, \`feature\` oder \`task\`; die aktuellen Schlüssel je Projekt stehen im Abschnitt „Aktuelle Ebenen und Verknüpfungsarten" unten |
| \`status\` | Text | ja | Slug einer Spalte des Boards, etwa \`backlog\`, \`doing\`, \`wont-do\` |
| \`title\` | Text | nein | eine Zeile; fehlt es, gilt die erste H1, sonst der Dateiname ohne Datumspräfix |
| \`project\` | Text | bedingt | Kürzel; bei eingeordneten Aufgaben aus dem Pfad abgeleitet, bei atomaren Pflicht |
| \`priority\` | Zahl | nein | \`1\` hoch bis \`4\` niedrig, ohne Angabe \`3\` |
| \`planned\` | Datum | nein | \`YYYY-MM-DD\` ohne Anführungszeichen |
| \`due\` | Datum | nein | \`YYYY-MM-DD\` |
| \`completed\` | Datum | nein | \`YYYY-MM-DD\`, nur solange die Aufgabe abgeschlossen ist; das Board setzt es |
| \`ticket\` | Zahl | nein | Work-Item-ID aus Azure DevOps; macht die Karte zur ADO-Karte |
| \`summary\` | Text | nein | ein Satz |
| \`tags\` | Liste | nein | Obsidians Standardfeld, etwa \`st/termin\`; erscheinen als Chips |

Unbekannte Felder bleiben unangetastet. Fehlt \`type\`, oder ist sein Wert kein bekannter
Ebenenschlüssel, gilt die Notiz als ungültig und erscheint als ungültige Karte. Fehlt nur
\`status\`, oder ist er kein bekannter Spaltenschlüssel, erscheint stattdessen ein Hinweis
mit dem Pfad der Notiz; die Karte selbst bleibt ungültig, bis \`status\` einen gültigen Wert
trägt.

## Hierarchie, Kurzname und eigener Ordner

\`parent\` ist ein Wikilink auf die Notiz des übergeordneten Elements, etwa
\`parent: "[[_feature]]"\`, und die Wahrheit über die Hierarchie; die Ordnerlage darunter ist
nur die Standardablage und gilt, solange \`parent\` fehlt.

\`short\` ist der Kurzname des Elements, der in den Ebenen-Chips seiner Kinder erscheint;
ohne \`short\` zeigt der Chip den vollen Titel.

Eine Notiz darf auch außerhalb eines Root-Ordners in einem eigenen Ordner liegen, als
\`_<ordner>.md\` in einem beliebigen Unterordner des Vaults. Dafür ist \`project\` Pflicht,
sonst wird die Notiz nicht gelesen; \`parent\` trägt in diesem Fall die Hierarchie.

## Minimale gültige Notiz

\`\`\`yaml
---
type: task
status: backlog
---
\`\`\`

## Vollständiges Beispiel

\`\`\`yaml
---
type: task
title: Tooltip verbessern
status: doing
project: ovb
priority: 2
planned: 2026-09-10
due: 2026-09-12
ticket: 1234
summary: Tooltip im Radar-Chart zeigt Rohwerte statt Prozent.
tags:
  - st/termin
---
Beschreibung als Text.

- [ ] Abhakpunkt
\`\`\`
`;

export const LEVEL_SECTION_START = '<!-- ktm:levels:start -->';
export const LEVEL_SECTION_END = '<!-- ktm:levels:end -->';

function levelSectionBlock(
  title: string,
  general: GeneralSettings,
  project?: ProjectSettings,
): string {
  const resolved = settingsFor(general, project);
  const levels = resolved.levels.map((level) => `\`${level.key}\` ${level.name}`).join(', ');
  const linkKinds = resolved.linkKinds.map((kind) => `\`${kind.key}\` ${kind.label}`).join(', ');
  return `### ${title}\n\n- Ebenen: ${levels}\n- Verknüpfungsfelder: ${linkKinds}`;
}

/**
 * Renders the maintained section (005 addendum 2026-09-20): the current level
 * keys and free-link fields, resolved per project the same way the board
 * itself resolves them (settingsFor, Wissen #536), so this never re-implements
 * the merge between general and per-project settings.
 */
export function renderLevelSection(general: GeneralSettings, projects: ProjectSettings[]): string {
  const blocks = [
    levelSectionBlock('Allgemein', general),
    ...projects.map((project) => levelSectionBlock(project.name, general, project)),
  ];
  return (
    `${LEVEL_SECTION_START}\n` +
    '## Aktuelle Ebenen und Verknüpfungsarten\n\n' +
    `${blocks.join('\n\n')}\n` +
    LEVEL_SECTION_END
  );
}

/**
 * Replaces everything between the marker lines, markers included, with
 * `section`; text before the start marker and after the end marker stays
 * byte-identical, including its line endings, because this operates on raw
 * string offsets and never splits the content by `\n` (Wissen #297). Missing
 * markers append the section at the end instead of failing.
 */
export function replaceLevelSection(content: string, section: string): string {
  const startIdx = content.indexOf(LEVEL_SECTION_START);
  const endIdx = content.indexOf(LEVEL_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    return `${content}${separator}\n${section}\n`;
  }
  return content.slice(0, startIdx) + section + content.slice(endIdx + LEVEL_SECTION_END.length);
}
