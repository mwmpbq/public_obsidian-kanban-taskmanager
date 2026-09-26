import { settingsFor, type GeneralSettings, type ProjectSettings } from './settings';

/** The path `_Tasks/Aufgabenformat.md` used to live at, removed on load (011 S70). */
export const FORMAT_NOTE_PATH = '_Tasks/Aufgabenformat.md';

/** Where the plugin keeps the guide in the vault (011, "Die Anleitung liegt im Vault"). */
export const GUIDE_NOTE_PATH = '_Tasks/KTM-Guide.md';

export const HEADING_ANLEITUNG = '## 1 Anleitung';
export const HEADING_KONFIGURATION = '## 2 Aktuelle Konfiguration';
const HEADING_AENDERUNGEN_PREFIX = '## 3 Änderungen in ';
export const HEADING_MIGRATION = '## 4 Migration von früheren Versionen';

export interface GuideConfig {
  general: GeneralSettings;
  projects: ProjectSettings[];
}

/**
 * Renders the LLM-facing guide (011, "Anleitung im Plugin"): the same
 * template becomes `_Tasks/KTM-Guide.md` in the vault (with `config`, so Teil
 * 2 shows the live configuration), the CLI answer to `ktm:guide` (with
 * `config`) and the build's `LLM-GUIDE.md` (without `config`, K25: Teil 2
 * never appears there). Teil 1, 3 and 4 never depend on `config`, so they
 * come out byte-identical either way (K24).
 */
export function renderGuide(options: { version: string; config?: GuideConfig }): string {
  const { version, config } = options;
  const frontmatter = `---\nktm_guide: ${options.version}\n---\n`;
  const parts = [part1(), ...(config ? [part2(config)] : []), part3(version), part4()];
  return `${frontmatter}\n${parts.join('\n\n')}\n`;
}

function part1(): string {
  return `${HEADING_ANLEITUNG}

Diese Anleitung beschreibt, wie eine Aufgabe im Vault abgelegt wird, damit sie ohne die
Oberfläche angelegt und gelesen werden kann (AI-first). Alles Bedeutungstragende steht im
Frontmatter der Notiz; Dateiname und Ordner tragen keine Bedeutung und dürfen frei
geändert werden.

### Pflichtfelder

Jede Notiz, deren Frontmatter \`ktm_id\` trägt, ist ein Element des Boards. Fünf Felder sind
Pflicht:

- \`ktm_id\`: stabile Kennung, wird nie geändert.
- \`type\`: Ebenenschlüssel des Projekts (Standard \`epic\`, \`feature\`, \`task\`).
- \`title\`: der Titel der Karte.
- \`status\`: Schlüssel einer Spalte des Boards.
- \`project\`: Kürzel eines Projekts, oder \`intern\` für eine Aufgabe ohne Projekt.

Fehlt ein Pflichtfeld, oder ist \`type\`/\`project\` unbekannt, erscheint die Notiz als
ungültige Karte mit dem fehlenden Feld als Grund.

### Weitere Felder

- \`parent\`: die \`ktm_id\` des übergeordneten Elements.
- \`parent_link\`: ein Wikilink auf die Notiz des Elternteils, nur für Menschen gedacht und
  vom Plugin mitgepflegt; nie maßgeblich.
- \`created\`: Anlagedatum, \`YYYY-MM-DD\`.
- \`priority\`, \`planned\`, \`due\`, \`completed\`, \`ticket\`, \`summary\`, \`tags\`, \`short\`,
  \`order\` und die konfigurierten Verknüpfungsfelder (siehe Teil 2).

### Kennungen

\`ktm_id\` ist entweder \`t-\` plus zehn Zeichen Crockford-Base32 (vom Plugin vergeben) oder
von Hand ein beliebiger Wert aus \`[A-Za-z0-9_-]{3,64}\`, eindeutig im Vault. Der Wert \`new\`
ist ein Platzhalter: das Plugin ersetzt ihn innerhalb weniger Sekunden durch eine frische
Kennung. \`ktm:new-id n=<Anzahl>\` gibt fertige Kennungen aus, gegen den Index geprüft.

### Anlegen

Eine Aufgabe entsteht als Markdown-Datei mit den Pflichtfeldern, \`created\` und, wenn sie
ein Kind ist, \`parent\`/\`parent_link\`. Ein Kind bekommt denselben \`project\`-Wert wie sein
Elternteil und ein \`type\` einer Ebene darunter. Standardablage: eine eingeordnete Aufgabe
unter dem Root-Ordner ihres Projekts, ein Kind im Ordner seines Elternteils; eine Aufgabe
ohne Ordner unter \`_Tasks/Atomic/\`. Der Ort ist nur die Standardablage, nicht die
Wahrheit: \`parent\` bleibt gültig, auch wenn eine Notiz an anderer Stelle liegt.

Der bevorzugte Weg für ein LLM ist \`ktm:create title=<Titel> project=<Kürzel> [type=]
[status=] [parent=<ktm_id>] [due=] [planned=] [priority=]\`: ohne \`type\` gilt die unterste
Ebene, ohne \`status\` die erste Spalte, alle Werte werden vor jedem Schreiben geprüft. Bei
einem ungültigen Wert (unbekanntes Projekt, unbekannte Ebene, unbekannter Status,
unbekannter Parent, Parent auf gleicher oder tieferer Ebene) legt \`ktm:create\` nichts an;
die erste Ausgabezeile beginnt dann mit \`ktm:error <Grund>\`, sonst mit \`<ktm_id> <Pfad>\`.

\`parent_link\`, wo vorhanden, hat die Form \`[[<Notiz>|<Titel>]]\` — derselbe Wikilink, den
Obsidians eigener Alias-Mechanismus erzeugt — und wird vom Plugin selbst mitgepflegt:
ändert sich der Titel des Elternteils, oder wird seine Notiz umbenannt oder verschoben,
schreibt das Plugin \`parent_link\` jedes Kindes nach, das schon einen trägt. Ein Kind ohne
\`parent_link\` bekommt dadurch keinen neuen; \`parent\` selbst ändert sich dabei nie.

### Bestand prüfen

\`ktm:check\` sollte ein LLM nach jeder Änderung aufrufen: es
meldet ungültige Karten, doppelte Kennungen, einen \`parent\` ins Leere, einen veralteten
\`parent_link\`, Notizen mit \`type\`/\`status\` ohne \`ktm_id\`, und ob ein Element nicht am
berechneten Ort liegt. Die letzte Zeile ist immer \`ktm:check <n> Befunde\`; der Befehl
schreibt nichts.

### Was nie zu tun ist

- Keine bekannten Felder von Hand aus dem YAML-Block löschen, ohne die Notiz auf einen
  gültigen Zustand zu bringen — eine unvollständige Notiz wird zur ungültigen Karte.
- \`ktm_id\` niemals ändern oder zwischen zwei Notizen tauschen.
- Keine zweite Notiz mit derselben \`ktm_id\` anlegen; das Plugin meldet die jüngere als
  „Kennung doppelt“ und schreibt nichts.
- \`parent_link\` nicht von Hand pflegen, das Plugin tut es; nur \`parent\` ist maßgeblich.

### Ablage

Der Ort folgt dem Parent: ohne \`parent\` liegt ein Element im Root seines Projekts, mit
\`parent\` im Ordner der Notiz seines Elternteils, gleich wo diese liegt. Nach jeder
Änderung an \`parent\`, \`project\`, \`type\` oder \`status\` liegt das Element sofort woanders —
vor dem nächsten Schreiben den Pfad neu holen, mit \`ktm:where\`, bevorzugt aber gleich
\`ktm:set\` verwenden, das Felder ändert und den neuen Pfad in einem Schritt ausgibt. Der
Deliverable-Ordner ist dabei eine Einheit: direkt in ihm liegt genau eine Notiz mit
\`ktm_id\`, alles andere darin (Code, Daten, weitere Notizen) gehört zum Element und
wandert mit, wenn es umzieht. \`ktm:where\` und \`ktm:set\` enden über die Obsidian-CLI immer
mit Exitcode 0; ein Fehler ist an der ersten Ausgabezeile \`ktm:error <Grund>\` zu
erkennen, ein erfolgreicher Aufruf beginnt nie so.

\`ktm_placement\` steht auf \`auto\` oder \`manual\`. Bei \`auto\` verschiebt das Plugin den
Ordner selbsttätig; bei \`manual\` nie. Wer aus dem Ordner mit relativen oder absoluten
Pfaden nach außen verweist, setzt \`ktm_placement: manual\`, sonst würde ein Umzug diese
Pfade brechen.`;
}

function part2(config: GuideConfig): string {
  const { general, projects } = config;
  const intern: ProjectSettings = { key: 'intern', name: 'Intern', root: '_Tasks/Atomic/', path: '' };
  const blocks = [intern, ...projects].map((project) => projectBlock(project, general, project.key !== 'intern'));
  return `${HEADING_KONFIGURATION}\n\n${blocks.join('\n\n')}`;
}

function projectBlock(project: ProjectSettings, general: GeneralSettings, hasOwnNote: boolean): string {
  const resolved = settingsFor(general, hasOwnNote ? project : undefined);
  const levels = resolved.levels.map((level) => `\`${level.key}\` ${level.name}`).join(', ');
  const columns = resolved.columns.map((column) => `\`${column.status}\` ${column.name}`).join(', ');
  const linkKinds = resolved.linkKinds.map((kind) => `\`${kind.key}\` ${kind.label}`).join(', ');
  return (
    `### ${project.name}\n\n` +
    `- Kürzel: \`${project.key}\`\n` +
    `- Root: \`${project.root || '(kein eigener Root)'}\`\n` +
    `- Ebenen: ${levels}\n` +
    `- Spalten: ${columns}\n` +
    `- Verknüpfungsfelder: ${linkKinds}`
  );
}

function part3(version: string): string {
  return `${HEADING_AENDERUNGEN_PREFIX}${version}

- Nur noch das Frontmatter entscheidet, ob eine Notiz ein Element ist (\`ktm_id\`); Name
  und Ordner tragen keine Bedeutung mehr und dürfen frei geändert werden.
- \`parent\` trägt jetzt die \`ktm_id\` des Elternteils statt eines Wikilinks; ein bisheriger
  Wikilink steht seither in \`parent_link\`.
- Ein bestehender Bestand aus 0.0.1 wird über „Bestand übernehmen“ oder \`ktm:migrate\`
  übernommen (Teil 4).
- Die Formatnotiz \`_Tasks/Aufgabenformat.md\` ist abgelöst durch diese Anleitung,
  \`_Tasks/KTM-Guide.md\`; für LLMs außerhalb von Obsidian gibt es zusätzlich
  \`LLM-GUIDE.md\` im Plugin-Ordner und den Befehl „LLM-Verweis einrichten“, der einen
  Verweis darauf in \`CLAUDE.md\` einträgt.
- Der Ort folgt dem Parent: nach einer Änderung an \`parent\`, \`project\`, \`type\` oder
  \`status\` liegt das Element sofort woanders (\`ktm:where\`, \`ktm:set\`). \`ktm_placement\`
  (\`auto\`/\`manual\`) schaltet das ab, für Ordner, auf die von außen mit Pfaden verwiesen
  wird.
- „Übernahme rückgängig machen“ und \`ktm:migrate undo\` nehmen eine Übernahme wieder
  zurück, anhand eines Protokolls, das die Übernahme selbst ablegt.
- \`ktm:check\` meldet ungültige Karten, doppelte Kennungen, einen
  \`parent\` ins Leere und einen veralteten \`parent_link\`.
- \`ktm:create\` legt ein Element per CLI an, mit derselben Prüfung wie \`ktm:set\`.
- \`parent_link\` trägt jetzt den Titel des Elternteils als Alias und wird vom Plugin
  nachgeführt, wenn sich Titel, Name oder Ort der Elternnotiz ändert.`;
}

function part4(): string {
  return `${HEADING_MIGRATION}

### Von 0.0.1

Ein Bestand im Format von 0.0.1 (Aufgaben als \`_\`-Notizen in Ordnern unterhalb eines
Root-Ordners, atomare Aufgaben unter \`_Tasks/Atomic/\`, alles ohne \`ktm_id\`) wird mit dem
Befehl „Bestand übernehmen“ oder per CLI mit \`ktm:migrate apply\` übernommen. Eine Vorschau
(\`ktm:migrate\` ohne \`apply\`, oder der Befehl vor der Bestätigung) nennt vorher die Zahl
der Elemente, die Zahl der Parents, die als Kennung geschrieben werden, und die Dateien,
die nicht übernommen werden (etwa \`_index.md\`, \`_template.md\` ohne \`type\`). Kein Name und
kein Ordner ändert sich dabei.

Zur Prüfung: \`obsidian vault=<Vault> ktm:migrate\` endet mit der Zeile
\`ktm:migrate 0 offene Elemente\`, sobald nichts mehr offen ist.`;
}
