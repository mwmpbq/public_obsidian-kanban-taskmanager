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
| \`type\` | Text | ja | \`epic\`, \`feature\` oder \`task\` |
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

Unbekannte Felder bleiben unangetastet. Fehlen \`type\` oder \`status\`, gilt die Notiz als
ungültig und erscheint als ungültige Karte.

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
