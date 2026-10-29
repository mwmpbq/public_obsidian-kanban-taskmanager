import { type App, getFrontMatterInfo, MarkdownView, Notice, TFile, TFolder } from 'obsidian';
import { formatParentLink } from '../core/create';
import { applyFrontmatter, flowList, type FrontmatterChange } from '../core/frontmatter';
import { FORMAT_NOTE_PATH, GUIDE_NOTE_PATH } from '../core/guide';
import { classifyTarget, mergeInto, type MergeFs } from '../core/merge';
import { isLegacyNoteName, type MigrationProtocol, type MigrationProtocolItem } from '../core/migrate';
import type { FileEntry, ProjectRoot } from '../core/model';
import { insertIntoRoot, rewriteGitattributes, rewriteGitignore, rewriteQueryBlocks, rewriteQueryText, type RewriteResult } from '../core/pathfollow';
import { linksOf } from '../core/read';
import type { FileSource } from '../core/vault-index';

const ATOMIC_PREFIX = '_Tasks/Atomic/';
const ARCHIVE_SEGMENT = 'Archive';
const CLAUDE_MD_PATH = 'CLAUDE.md';
const LLM_LINK_LINE = `Anleitung für den Kanban Taskmanager: siehe ${GUIDE_NOTE_PATH}`;
const NOTICE_DURATION = 15000;

// The plugin's own recent moves (011, Ergänzung 2026-09-25, "Von Hand
// verschoben"): moveElement remembers every move it makes here, for a couple
// of seconds past its own end, so main.ts#handMoved can tell its own writes
// apart from an outside rename/move the user made in Obsidian's file
// explorer. A module-level list, not per-plugin-instance state, since the
// decision (core/placement.ts#handMoved) is pure and only needs the prefixes.
const OWN_MOVE_TTL_MS = 2000;
let ownMoves: { from: string; to: string; expires: number }[] = [];

function rememberOwnMove(from: string, to: string): void {
  const now = Date.now();
  ownMoves = ownMoves.filter((m) => m.expires > now);
  ownMoves.push({ from, to, expires: now + OWN_MOVE_TTL_MS });
}

/** Every move the plugin itself made in roughly the last two seconds. */
export function recentOwnMoves(): { from: string; to: string }[] {
  const now = Date.now();
  return ownMoves.filter((m) => m.expires > now).map(({ from, to }) => ({ from, to }));
}

/**
 * {@link FileSource} over the running app (011 S61/K30, replaces readVault):
 * `list()` reads only the MetadataCache's frontmatter of every markdown file,
 * never file content, and keeps a path only when it carries `ktm_id` or
 * `ktm_project`; `read()` loads exactly the one file asked for — frontmatter
 * from the cache, the body via `getFrontMatterInfo` plus `vault.cachedRead`
 * so a `---` inside the body is not mistaken for the frontmatter's end.
 * Obsidian is confined to this module, the core never imports it.
 */
export function obsidianFileSource(app: App): FileSource {
  return {
    async list(): Promise<string[]> {
      const paths: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
        if (typeof frontmatter?.ktm_id === 'string' || typeof frontmatter?.ktm_project === 'string') {
          paths.push(file.path);
        }
      }
      return paths;
    },
    async read(path: string): Promise<FileEntry | undefined> {
      const file = app.vault.getFileByPath(path);
      if (!file) return undefined;
      const cache = app.metadataCache.getFileCache(file);
      const frontmatter = { ...(cache?.frontmatter ?? {}) };
      delete frontmatter.position;

      // A file mid-move can fail `cachedRead` with ENOENT (Wissen #829: its
      // `TFile.path` already points at the new location, but the disk move
      // itself has not landed yet). Retried once against wherever the same
      // TFile object now reports itself; truly gone by then is not an error,
      // just nothing to read (008, Ergänzung 2026-10-18 "Lesen am neuen Ort").
      let raw: string;
      try {
        raw = await app.vault.cachedRead(file);
      } catch {
        const current = app.vault.getFileByPath(file.path);
        if (!current) return undefined;
        try {
          raw = await app.vault.cachedRead(current);
        } catch {
          return undefined;
        }
      }
      const info = getFrontMatterInfo(raw);
      const body = info.exists ? raw.slice(info.contentStart) : raw;

      // `file.path` is read again here, not the `path` this call was asked
      // for: by the time the read above actually landed, the same TFile may
      // already report a different, newer path (it moved while this ran).
      // The index (vault-index.ts#applyChange) keys its entry on exactly this
      // value, so a note that moved mid-read is never briefly indexed under
      // both its old and new path at once.
      return { path: file.path, frontmatter, body, ctime: file.stat.ctime };
    },
  };
}

/**
 * The single sanctioned write path for a task note. Any view holding the file
 * open is flushed first so `Vault.process` does not run against a stale disk
 * copy; the change then edits only known frontmatter keys and keeps the rest of
 * the file byte-identical. A file without frontmatter is left untouched,
 * unless `allowCreate` is set (011, "Als Aufgabe übernehmen" on a note that
 * never had one): `applyFrontmatter` already knows how to prepend a fresh
 * block, this only lifts the block that otherwise refuses it here.
 */
export async function writeFrontmatter(
  app: App,
  path: string,
  change: FrontmatterChange,
  options: { allowCreate?: boolean } = {},
): Promise<void> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`Note nicht gefunden: ${path}`);

  await flushOpenViews(app, file);

  const reindexed = nextMetadataChange(app, file.path);
  await app.vault.process(file, (data) => {
    const info = getFrontMatterInfo(data);
    if (!info.exists && !options.allowCreate) return data;
    return applyFrontmatter(data, change);
  });
  await reindexed;
}

// The board reads frontmatter from the MetadataCache, which reparses a file
// only after `process` has written it. Resolving once the cache has caught up
// lets a following re-render show the new column instead of the stale one; a
// timeout keeps the promise from hanging if no reparse arrives.
function nextMetadataChange(app: App, path: string): Promise<void> {
  return new Promise((resolve) => {
    const ref = app.metadataCache.on('changed', (changed) => {
      if (changed.path !== path) return;
      app.metadataCache.offref(ref);
      resolve();
    });
    setTimeout(() => {
      app.metadataCache.offref(ref);
      resolve();
    }, 1500);
  });
}

async function flushOpenViews(app: App, file: TFile): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file === file) {
      await view.save();
    }
  }
}

/**
 * Replaces a note's body — everything below the frontmatter block — while
 * keeping the frontmatter byte-identical. The body offset comes from
 * `getFrontMatterInfo`, so a `---` inside the body is not mistaken for the
 * block's end. Any view holding the file open is flushed first. A file without
 * frontmatter becomes the new body outright.
 */
export async function writeBody(app: App, path: string, body: string): Promise<void> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`Note nicht gefunden: ${path}`);

  await flushOpenViews(app, file);

  await app.vault.process(file, (data) => {
    const info = getFrontMatterInfo(data);
    if (!info.exists) return body;
    return data.slice(0, info.contentStart) + body;
  });
}

/**
 * {@link MergeFs} over the running app: `list`/`isFolder` read straight from
 * the vault tree, `hasElementNote` asks the MetadataCache for `ktm_id` on the
 * folder's direct `.md` children, `moveFile` is `fileManager.renameFile`
 * (pulling wikilinks along per file), `createFolder` is `vault.createFolder`,
 * `removeIfEmpty` is `vault.delete` and only ever fires when the folder's own
 * `children` — read fresh, not cached, and filtered down to entries whose own
 * path still resolves under this folder (wissen #781/#782: a child a
 * `moveFile` just renamed away can briefly linger in the old parent's
 * `children` while its own path already reports the new location) — is
 * empty. A folder that is not empty on that first read gets exactly one
 * recheck after letting such a lagging event settle, before it is left
 * standing; `force: true` is needed even on an actually empty folder, since
 * `Vault.delete` otherwise tries to remove it like a file and fails with
 * `EISDIR` (measured, not in the API docs beyond "hidden children"). `onMoved`
 * fires after every successful `moveFile`, so {@link
 * moveElement} can keep renewing its `rememberOwnMove` window across a merge
 * that outlasts a single file.
 */
function obsidianMergeFs(app: App, onMoved: () => void): MergeFs {
  return {
    async list(path: string): Promise<string[]> {
      const folder = path === '' ? app.vault.getRoot() : app.vault.getAbstractFileByPath(path);
      return folder instanceof TFolder ? folder.children.map((c) => c.name) : [];
    },
    async isFolder(path: string): Promise<boolean> {
      const target = path === '' ? app.vault.getRoot() : app.vault.getAbstractFileByPath(path);
      return target instanceof TFolder;
    },
    async hasElementNote(path: string): Promise<boolean> {
      const folder = app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder)) return false;
      return folder.children.some(
        (c) => c instanceof TFile && typeof app.metadataCache.getFileCache(c)?.frontmatter?.ktm_id === 'string',
      );
    },
    async moveFile(from: string, to: string): Promise<void> {
      const file = app.vault.getAbstractFileByPath(from);
      if (!(file instanceof TFile)) throw new Error(`Element nicht gefunden: ${from}`);
      await app.fileManager.renameFile(file, to);
      onMoved();
    },
    async createFolder(path: string): Promise<void> {
      await ensureFolder(app, path);
    },
    async removeIfEmpty(path: string): Promise<void> {
      const liveChildCount = (folder: TFolder): number =>
        folder.children.filter((c) => c.path === (path === '' ? c.name : `${path}/${c.name}`)).length;
      let folder = app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder)) return;
      if (liveChildCount(folder) > 0) {
        // A child moveFile just renamed away can briefly still sit in this
        // folder's `children` (#781/#782); give that one tick to settle
        // before giving up on an otherwise-empty folder.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        folder = app.vault.getAbstractFileByPath(path);
        if (!(folder instanceof TFolder) || liveChildCount(folder) > 0) return;
      }
      await app.vault.delete(folder, true);
    },
  };
}

/**
 * Moves an element to `to` (008, Ergänzung 2026-10-19 "Der berechnete Ort ist
 * schon belegt", replacing the collision handling from 008 S47/F068 K3): what
 * happens is {@link classifyTarget}'s call against an {@link obsidianMergeFs}
 * built over this app, decided up front, before anything moves, so a move is
 * always either complete or entirely untouched (K5, "ganz oder gar nicht").
 *
 * `'free'` renames `from` to `to` in one call via `FileManager.renameFile`,
 * the only move that pulls the vault's wikilinks along (011, Ergänzung
 * 2026-09-25, "Der Ordner wandert als Ganzes"); `'merge'` — only ever offered
 * by `classifyTarget` when `allowMerge` says so, decided by the caller from
 * core/placement.ts#isInDoneMirror — runs {@link mergeInto} instead, moving
 * every file of `from` to the same relative place under `to` and removing
 * `from` only once it is actually empty; `'occupied'` throws with the reason
 * `classifyTarget` found, naming the blocking path, and nothing moves at all.
 * `renameFile` does not create the target's parent, so that parent is
 * ensured to exist first either way.
 *
 * Every move this makes is remembered for a couple of seconds ({@link
 * recentOwnMoves}), renewed after each file a merge moves, so a rename event
 * it causes is never mistaken for one the user made by hand (011 K20/K21). If
 * a plain `renameFile` itself fails, the source folder's own files are
 * checked one by one via `readBinary` and the first unreadable one is named
 * in the error (011 S92, a file locked open elsewhere) — Obsidian gives no
 * better reason on its own.
 *
 * Once the element itself has landed at `to`, {@link followPaths} pulls
 * `.gitignore`, `.gitattributes` and query paths pointing at `from` along
 * (008, Ergänzung 2026-10-19); the inner `renameFile` calls of a merge do not
 * get this treatment, a failure there does not abort the move. Every message
 * `followPaths` returns becomes its own Notice, same duration as the
 * plugin's other write-failure hints.
 */
export async function moveElement(app: App, from: string, to: string, parent: string, allowMerge: boolean): Promise<void> {
  const file = app.vault.getAbstractFileByPath(from);
  if (!file) throw new Error(`Element nicht gefunden: ${from}`);

  const fs = obsidianMergeFs(app, () => rememberOwnMove(from, to));
  const classification = await classifyTarget(fs, from, to, allowMerge);
  if (classification.kind === 'occupied') throw new Error(classification.reason);

  await ensureFolder(app, parent);
  rememberOwnMove(from, to);

  const runMove =
    classification.kind === 'merge' ? () => mergeInto(fs, from, to) : () => app.fileManager.renameFile(file, to);
  try {
    await runMove();
  } catch (err) {
    const locked = file instanceof TFolder ? await firstUnreadableFile(app, file) : undefined;
    throw new Error(locked ? `Gesperrte Datei: ${locked}` : errorMessage(err));
  }

  for (const message of await followPaths(app, from, to)) new Notice(message, NOTICE_DURATION);
}

/**
 * Moves a document — not an element, no `ktm_id`, no ablageregel — to `to`
 * (008, Ergänzung 2026-10-19 "Ein Result wandert zu seinem Ziel"): a plain
 * `fileManager.renameFile` so the vault's wikilinks follow, then {@link
 * followPaths} so `.gitignore`, `.gitattributes` and queries pointing at
 * `from` follow too, same as {@link moveElement}. The target folder is
 * created first if missing. Returns `followPaths`'s messages for the caller
 * to show as Notices; throws only if the rename itself fails (occupied names
 * are the caller's job via `planResult`'s `exists` predicate, checked before
 * this runs).
 */
export async function moveDocument(app: App, from: string, to: string): Promise<string[]> {
  const file = app.vault.getAbstractFileByPath(from);
  if (!(file instanceof TFile)) throw new Error(`Datei nicht gefunden: ${from}`);
  const cut = to.lastIndexOf('/');
  if (cut !== -1) await ensureFolder(app, to.slice(0, cut));
  await app.fileManager.renameFile(file, to);
  return followPaths(app, from, to);
}

function wikilinkOf(link: { target: string; alias?: string }): string {
  return link.alias ? `[[${link.target}|${link.alias}]]` : `[[${link.target}]]`;
}

/**
 * Appends `file` to `key`'s free-link list on `notePath`'s own note, unless
 * it is already there (005/008, Ergänzung 2026-10-19 "Results für Claude"/"Ein
 * Result wandert zu seinem Ziel"): read fresh from the MetadataCache rather
 * than a possibly stale `BoardElement`, so two calls racing the same note's
 * own `changed` events never duplicate an entry (wissen #1178). Matches an
 * existing entry by its resolved file, not its raw text (wissen #1186), the
 * same rule {@link BoardView.appendResultLink} already follows — this is its
 * View-free counterpart for main.ts.
 */
export async function appendFreeLink(app: App, notePath: string, key: string, file: TFile): Promise<void> {
  const note = app.vault.getAbstractFileByPath(notePath);
  const frontmatter = note instanceof TFile ? (app.metadataCache.getFileCache(note)?.frontmatter ?? {}) : {};
  const existing = linksOf(frontmatter, [{ key, label: '', icon: '' }]).filter((l) => l.kind === key);
  const already = existing.some((l) => app.metadataCache.getFirstLinkpathDest(l.target, notePath)?.path === file.path);
  if (already) return;
  const target = app.metadataCache.fileToLinktext(file, notePath, true);
  const next = [...existing, { target }];
  await writeFrontmatter(app, notePath, { [key]: flowList(next.map(wikilinkOf), true) });
}

const DOTFILE_REWRITERS = [
  { name: '.gitignore', rewrite: rewriteGitignore },
  { name: '.gitattributes', rewrite: rewriteGitattributes },
] as const;

/** Every folder above `path`, root (`''`) first, not including `path` itself. */
function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  const dirs: string[] = [''];
  for (let i = 0; i < parts.length - 1; i++) dirs.push(parts.slice(0, i + 1).join('/'));
  return dirs;
}

/**
 * Pulls `.gitignore`/`.gitattributes` entries and query paths pointing at
 * `from` to `to` (008, Ergänzung 2026-10-19): `.gitignore` and
 * `.gitattributes` are dot-files the vault index never sees, so this reads
 * and writes them via `Vault.adapter`, the same documented exception
 * `writeMigrationProtocol` already uses (konventionen.md, project contract
 * F090, extended here to exactly these two names). Only the folders above
 * `from`, root included, are read — a `.gitignore` can only match a path
 * below its own folder. Notes and `.base` files go through `Vault.process`,
 * the plugin's one sanctioned write path for them. Never throws: every
 * failed write becomes a message in the returned array instead, and the
 * move itself stays valid either way.
 */
export async function followPaths(app: App, from: string, to: string): Promise<string[]> {
  const messages: string[] = [];
  for (const { name, rewrite } of DOTFILE_REWRITERS) {
    await followDotfile(app, name, rewrite, from, to, messages);
  }
  await followQueries(app, from, to, messages);
  return messages;
}

async function followDotfile(
  app: App,
  name: '.gitignore' | '.gitattributes',
  rewrite: (content: string, dir: string, from: string, to: string) => RewriteResult,
  from: string,
  to: string,
  messages: string[],
): Promise<void> {
  const perDir = new Map<
    string,
    { original: string; content: string; changed: RewriteResult['changed']; toRoot: RewriteResult['toRoot'] }
  >();
  for (const dir of ancestorDirs(from)) {
    const path = dir === '' ? name : `${dir}/${name}`;
    let exists: boolean;
    try {
      exists = await app.vault.adapter.exists(path);
    } catch {
      continue;
    }
    if (!exists) continue;
    let original: string;
    try {
      original = await app.vault.adapter.read(path);
    } catch (err) {
      messages.push(`${path}: konnte nicht gelesen werden (${errorMessage(err)})`);
      continue;
    }
    const result = rewrite(original, dir, from, to);
    perDir.set(dir, { original, content: result.content, changed: result.changed, toRoot: result.toRoot });
  }

  const toRootAll = [...perDir.entries()].filter(([dir]) => dir !== '').flatMap(([, r]) => r.toRoot);
  const root = perDir.get('');
  if (toRootAll.length > 0) {
    if (root) {
      root.content = insertIntoRoot(root.content, toRootAll);
    } else {
      for (const [dir, r] of perDir) {
        if (dir === '' || r.toRoot.length === 0) continue;
        for (const { entry } of r.toRoot) {
          messages.push(`${dir}/${name}: Eintrag "${entry.before}" konnte nicht nachgezogen werden, keine ${name} im Wurzelverzeichnis`);
        }
        perDir.delete(dir);
      }
    }
  }

  for (const [dir, r] of perDir) {
    if (r.content === r.original) continue;
    const path = dir === '' ? name : `${dir}/${name}`;
    try {
      await app.vault.adapter.write(path, r.content);
    } catch (err) {
      for (const { before } of r.changed) {
        messages.push(`${path}: Eintrag "${before}" konnte nicht geschrieben werden (${errorMessage(err)})`);
      }
      if (r.changed.length === 0) messages.push(`${path}: konnte nicht geschrieben werden (${errorMessage(err)})`);
    }
  }
}

async function followQueries(app: App, from: string, to: string, messages: string[]): Promise<void> {
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache?.sections?.some((s) => s.type === 'code')) continue;
    let content: string;
    try {
      content = await app.vault.cachedRead(file);
    } catch {
      continue;
    }
    if (!content.includes(from) || rewriteQueryBlocks(content, from, to) === content) continue;
    try {
      await flushOpenViews(app, file);
      await app.vault.process(file, (data) => rewriteQueryBlocks(data, from, to));
    } catch (err) {
      messages.push(`${file.path}: ${from} konnte nicht aktualisiert werden (${errorMessage(err)})`);
    }
  }

  for (const file of app.vault.getFiles()) {
    if (file.extension !== 'base') continue;
    let content: string;
    try {
      content = await app.vault.cachedRead(file);
    } catch {
      continue;
    }
    if (!content.includes(from) || rewriteQueryText(content, from, to) === content) continue;
    try {
      await app.vault.process(file, (data) => rewriteQueryText(data, from, to));
    } catch (err) {
      messages.push(`${file.path}: ${from} konnte nicht aktualisiert werden (${errorMessage(err)})`);
    }
  }
}

async function firstUnreadableFile(app: App, folder: TFolder): Promise<string | undefined> {
  for (const child of folder.children) {
    if (child instanceof TFile) {
      try {
        await app.vault.readBinary(child);
      } catch {
        return child.path;
      }
    } else if (child instanceof TFolder) {
      const found = await firstUnreadableFile(app, child);
      if (found) return found;
    }
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path || app.vault.getAbstractFileByPath(path)) return;
  const cut = path.lastIndexOf('/');
  if (cut !== -1) await ensureFolder(app, path.slice(0, cut));
  try {
    await app.vault.createFolder(path);
  } catch (err) {
    if (!app.vault.getAbstractFileByPath(path)) throw err;
  }
}

/**
 * Creates a note at `path`, ensuring its folder exists first. Waits for the
 * MetadataCache to index the new file, so a following board re-render reads the
 * fresh frontmatter instead of missing the card; a timeout keeps the promise
 * from hanging if no index event arrives.
 */
export async function createNote(app: App, path: string, content: string): Promise<void> {
  const cut = path.lastIndexOf('/');
  if (cut !== -1) await ensureFolder(app, path.slice(0, cut));
  const reindexed = nextMetadataChange(app, path);
  await app.vault.create(path, content);
  await reindexed;
}

/** True when `path` resolves to an existing folder in the vault. */
export function folderExists(app: App, path: string): boolean {
  const normalized = path.replace(/\/+$/, '');
  if (!normalized) return false;
  return app.vault.getAbstractFileByPath(normalized) instanceof TFolder;
}

/**
 * Writes the whole guide, `content` already fully rendered by {@link
 * renderGuide} (011, "Die Anleitung liegt im Vault"): unlike the old format
 * note, no section is merged into existing text — the guide is regenerated
 * whole and only written when it actually differs (wissen #763, a partial
 * merge raced two debounced writers). Creates the note when missing,
 * tolerating a concurrent creation by re-checking after a failed create;
 * otherwise a still-open view is flushed before `Vault.process` replaces the
 * content outright. The retired `_Tasks/Aufgabenformat.md`, if still present,
 * is moved to the trash (011, "sie ersetzt _Tasks/Aufgabenformat.md, die alte
 * Notiz wird entfernt").
 */
export async function syncGuide(app: App, content: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(GUIDE_NOTE_PATH);
  if (!existing) {
    const cut = GUIDE_NOTE_PATH.lastIndexOf('/');
    if (cut !== -1) await ensureFolder(app, GUIDE_NOTE_PATH.slice(0, cut));
    try {
      await app.vault.create(GUIDE_NOTE_PATH, content);
    } catch (err) {
      if (!app.vault.getAbstractFileByPath(GUIDE_NOTE_PATH)) throw err;
    }
  } else if (existing instanceof TFile) {
    const current = await app.vault.cachedRead(existing);
    if (current !== content) {
      await flushOpenViews(app, existing);
      await app.vault.process(existing, () => content);
    }
  }

  const oldFormatDoc = app.vault.getAbstractFileByPath(FORMAT_NOTE_PATH);
  if (oldFormatDoc instanceof TFile) {
    try {
      await app.fileManager.trashFile(oldFormatDoc);
    } catch (err) {
      // Two debounced syncGuideNow calls can overlap (several project notes
      // changing in the same burst); a second one finding the same stale
      // TFile reference after the first already trashed it is not a fault,
      // only a genuinely failed trash (the path still there) is.
      if (app.vault.getAbstractFileByPath(FORMAT_NOTE_PATH)) throw err;
    }
  }
}

/** What {@link appendLlmLink} actually changed, so {@link removeLlmLink} can cut precisely that back off (011, Ergänzung 2026-09-25). */
export interface LlmLinkInfo {
  /** The exact string appended at the end of the file, including any line-ending it had to add first and its own trailing newline. */
  appended: string;
  /** Whether `CLAUDE.md` did not exist before and was created by this call. */
  created: boolean;
}

/**
 * Appends the LLM-verweis line to `CLAUDE.md` in the vault root (011, "LLM-
 * Verweis einrichten"): creates the file when it is missing, otherwise
 * appends the line after the file's own content (adding a line ending first
 * if the file did not end in one, in the file's own style, CRLF tolerated).
 * Already containing the guide's path, the file is left untouched — byte for
 * byte, a second call changes nothing (K28) — and reports nothing appended.
 * The returned {@link LlmLinkInfo} is what "LLM-Verweis entfernen" needs to
 * undo exactly this (011, Ergänzung 2026-09-25, K11).
 */
export async function appendLlmLink(app: App): Promise<LlmLinkInfo> {
  const existing = app.vault.getAbstractFileByPath(CLAUDE_MD_PATH);
  if (!existing) {
    const content = `${LLM_LINK_LINE}\n`;
    await app.vault.create(CLAUDE_MD_PATH, content);
    return { appended: content, created: true };
  }
  if (!(existing instanceof TFile)) return { appended: '', created: false };

  const current = await app.vault.cachedRead(existing);
  if (current.includes(GUIDE_NOTE_PATH)) return { appended: '', created: false };

  await flushOpenViews(app, existing);
  let appended = '';
  await app.vault.process(existing, (data) => {
    if (data.includes(GUIDE_NOTE_PATH)) return data;
    const nl = data.includes('\r\n') ? '\r\n' : '\n';
    const withNewline = data.length === 0 || data.endsWith(nl) ? data : `${data}${nl}`;
    const next = `${withNewline}${LLM_LINK_LINE}${nl}`;
    appended = next.slice(data.length);
    return next;
  });
  return { appended, created: false };
}

/**
 * Reverses {@link appendLlmLink} (011, Ergänzung 2026-09-25, "LLM-Verweis
 * entfernen"): cuts the exact remembered suffix off the file's end when it is
 * still there; otherwise falls back to removing the first line that equals
 * the verweis line exactly, together with its own line ending — the file may
 * have grown further meanwhile. A file the plugin itself created that would
 * end up empty goes to the trash instead of being left as an empty note; the
 * caller (main.ts) forgets the remembered info either way. Does nothing when
 * `CLAUDE.md` is missing or carries neither shape.
 */
export async function removeLlmLink(app: App, info: LlmLinkInfo | undefined): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(CLAUDE_MD_PATH);
  if (!(existing instanceof TFile)) return;

  await flushOpenViews(app, existing);
  const current = await app.vault.cachedRead(existing);
  const next =
    info && info.appended && current.endsWith(info.appended)
      ? current.slice(0, current.length - info.appended.length)
      : removeLine(current, LLM_LINK_LINE);
  if (next === undefined) return;

  if (info?.created && next.trim() === '') {
    await app.fileManager.trashFile(existing);
    return;
  }
  await app.vault.process(existing, () => next);
}

/** Removes the first line equal to `line`, together with the line ending that follows it; `undefined` when no such line exists. */
function removeLine(content: string, line: string): string | undefined {
  const parts = content.split(/(\r?\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] === line) {
      parts.splice(i, 2);
      return parts.join('');
    }
  }
  return undefined;
}

/**
 * The finished `parent_link` wikilink from `sourceNote` to `targetNote`, with
 * the parent's title as alias (011, Ergänzung 2026-09-25, "parent_link wird
 * mitgepflegt"): the one Obsidian-touching step every writer of a
 * `parent_link` goes through, so `fileToLinktext` is never called ad hoc at
 * four different call sites (main.ts#runKtmSet/ktm:create,
 * BoardView.ts#writeDraft/refileEnv.linkTo/changeLevel). `undefined` when
 * `targetNote` does not (yet) exist.
 */
export function parentLinkTo(app: App, targetNote: string, sourceNote: string, title: string): string | undefined {
  const file = app.vault.getFileByPath(targetNote);
  if (!file) return undefined;
  const linktext = app.metadataCache.fileToLinktext(file, sourceNote, true);
  return formatParentLink(linktext, title);
}

const PROTOCOL_DIR = '_Tasks';
const PROTOCOL_PREFIX = '.ktm-migration-';
const PROTOCOL_SUFFIX = '.json';

function protocolPath(date: string): string {
  return `${PROTOCOL_DIR}/${PROTOCOL_PREFIX}${date}${PROTOCOL_SUFFIX}`;
}

async function readProtocolFile(app: App, path: string): Promise<MigrationProtocol | undefined> {
  try {
    if (!(await app.vault.adapter.exists(path))) return undefined;
    return JSON.parse(await app.vault.adapter.read(path)) as MigrationProtocol;
  } catch {
    return undefined;
  }
}

/**
 * Writes (or merges into) today's übernahmeprotokoll (011, Ergänzung
 * 2026-09-25, "Übernahme rückgängig"): the one sanctioned use of
 * `Vault.adapter` in this plugin, because `_Tasks/.ktm-migration-<Datum>.json`
 * is a dot-file the Vault API's own index never sees (konventionen.md forbids
 * `Vault.adapter` generally; this is the documented exception, project
 * contract F090). An entry from an earlier run the same day, at the same
 * path, is replaced by the fresher one; an empty plan writes nothing at all.
 */
export async function writeMigrationProtocol(app: App, date: string, protocol: MigrationProtocol): Promise<void> {
  if (protocol.items.length === 0) return;
  const path = protocolPath(date);
  const existing = await readProtocolFile(app, path);
  const byPath = new Map((existing?.items ?? []).map((item) => [item.path, item]));
  for (const item of protocol.items) byPath.set(item.path, item);
  await app.vault.adapter.write(path, JSON.stringify({ items: [...byPath.values()] }));
}

/** The newest `_Tasks/.ktm-migration-*.json` protocol, or `undefined` when there is none (011 K1/K9). */
export async function latestMigrationProtocol(
  app: App,
): Promise<{ path: string; protocol: MigrationProtocol } | undefined> {
  let names: string[];
  try {
    names = (await app.vault.adapter.list(PROTOCOL_DIR)).files;
  } catch {
    return undefined;
  }
  const candidate = names
    .map((full) => full.split('/').pop() ?? full)
    .filter((name) => name.startsWith(PROTOCOL_PREFIX) && name.endsWith(PROTOCOL_SUFFIX))
    .sort()
    .pop();
  if (!candidate) return undefined;
  const path = `${PROTOCOL_DIR}/${candidate}`;
  const protocol = await readProtocolFile(app, path);
  return protocol ? { path, protocol } : undefined;
}

/** Removes a protocol file once its undo is fully done (011 K2, "und entfernen sie"). */
export async function removeMigrationProtocol(app: App, path: string): Promise<void> {
  try {
    await app.vault.adapter.remove(path);
  } catch {
    // already gone, nothing to do
  }
}

/**
 * Shrinks a protocol to only the items whose undo write failed (011,
 * umsetzung, "auf die Dateien mit Schreibfehlern kürzen"), so a retry later
 * only touches what is still outstanding; removes the file outright once
 * nothing remains.
 */
export async function shrinkMigrationProtocol(
  app: App,
  path: string,
  remaining: MigrationProtocolItem[],
): Promise<void> {
  if (remaining.length === 0) {
    await removeMigrationProtocol(app, path);
    return;
  }
  await app.vault.adapter.write(path, JSON.stringify({ items: remaining }));
}

/**
 * File entries {@link planMigration} needs to plan the 0.0.1 adoption (011
 * S67): every markdown file whose path matches the legacy candidate rule —
 * an underscore-prefixed note below a project root (skipping `Archive/` and
 * the project's own note), or any note under `_Tasks/Atomic/` — regardless of
 * whether it already carries `ktm_id` (an already-migrated ancestor is still
 * needed to resolve a not-yet-migrated child's parent). `cachedRead` runs
 * only for these candidates, never the whole vault.
 */
export async function legacyEntries(app: App, roots: ProjectRoot[]): Promise<FileEntry[]> {
  const normRoots = normalizedRoots(roots);
  const entries: FileEntry[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isLegacyCandidatePath(file, app, normRoots)) continue;
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter = { ...(cache?.frontmatter ?? {}) };
    delete frontmatter.position;
    const raw = await app.vault.cachedRead(file);
    const info = getFrontMatterInfo(raw);
    const body = info.exists ? raw.slice(info.contentStart) : raw;
    entries.push({ path: file.path, frontmatter, body, ctime: file.stat.ctime });
  }
  return entries;
}

/**
 * The number of legacy candidates {@link planMigration} would still turn into
 * an item (011 S69, "Bestand noch nicht übernommen"): the same path rule as
 * {@link legacyEntries}, but read only from the MetadataCache — never a
 * file's body — so a frequent board render can call this without touching
 * disk (main.ts#legacyCount). A candidate without `type`/`status` (011,
 * "Fremde `_`-Dateien … werden nicht übernommen") never counts: it would stay
 * a permanent "not yet adopted" that migration itself will never adopt
 * either, which is not what this hint promises (K11, "0 offene Elemente"
 * after a full migration despite `_index.md`/`_template.md` remaining). Nor
 * does a candidate whose name doesn't match {@link isLegacyNoteName} (F098):
 * a `_overview.md` directly under a root can carry `type`/`status` and still
 * never become planMigration's own element, so counting it here would make
 * the hint permanent too, same as a missing `type`/`status`.
 */
export function countLegacyCandidates(app: App, roots: ProjectRoot[]): number {
  const normRoots = normalizedRoots(roots);
  let count = 0;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isLegacyCandidatePath(file, app, normRoots)) continue;
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    const id = frontmatter?.ktm_id;
    if (typeof id === 'string' && id.trim() !== '') continue;
    if (!hasText(frontmatter?.type) || !hasText(frontmatter?.status)) continue;
    if (!file.path.startsWith(ATOMIC_PREFIX)) {
      const parts = rootRelativeParts(file.path, normRoots);
      if (!parts || !isLegacyNoteName(parts)) continue;
    }
    count++;
  }
  return count;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizedRoots(roots: ProjectRoot[]): { key: string; root: string }[] {
  return roots
    .map((r) => ({ key: r.key, root: r.root.replace(/\/+$/, '') }))
    .filter((r) => r.root !== '')
    .sort((a, b) => b.root.length - a.root.length);
}

/** Root-relative path segments of `path`, or `undefined` if it lies under no root. */
function rootRelativeParts(
  path: string,
  normRoots: { key: string; root: string }[],
): string[] | undefined {
  const root = normRoots.find((r) => path.startsWith(`${r.root}/`));
  return root ? path.slice(root.root.length + 1).split('/') : undefined;
}

function isLegacyCandidatePath(
  file: TFile,
  app: App,
  normRoots: { key: string; root: string }[],
): boolean {
  if (file.path.startsWith(ATOMIC_PREFIX)) return true;
  const parts = rootRelativeParts(file.path, normRoots);
  if (!parts) return false;
  const fileName = parts[parts.length - 1];
  if (!fileName.startsWith('_')) return false;
  if (parts[0] === ARCHIVE_SEGMENT) return false;
  if (parts.length === 1) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (typeof frontmatter?.ktm_project === 'string') return false;
  }
  return true;
}

const TASKS_PREFIX = '_Tasks/';

/**
 * Every markdown note that carries `type` and `status` but no `ktm_id`
 * (011, Ergänzung 2026-09-25, "Bestandsprüfung", ktm:check's fifth Befundart):
 * anywhere under `_Tasks/` (the atomic base and its `Done/` mirror included),
 * or under a project root outside its `Archive/` folder — the same root rule
 * {@link countLegacyCandidates} uses, but without the legacy filename
 * requirement, since this counts *any* unadopted note, not just one migration
 * could still turn into an element (wissen #819: the shared fixture's
 * `_overview.md` is exactly such a note, one root, not the atomic base).
 * Reads only frontmatter from the MetadataCache, no file body.
 */
export function unadoptedNotes(app: App, roots: ProjectRoot[]): string[] {
  const normRoots = normalizedRoots(roots);
  const paths: string[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (file.path === GUIDE_NOTE_PATH) continue;
    if (!isUnderRootOrTasks(file.path, normRoots)) continue;
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) continue;
    if (typeof frontmatter.ktm_id === 'string' && frontmatter.ktm_id.trim() !== '') continue;
    if (typeof frontmatter.ktm_project === 'string') continue;
    if (typeof frontmatter.ktm_guide !== 'undefined') continue;
    if (!hasText(frontmatter.type) || !hasText(frontmatter.status)) continue;
    paths.push(file.path);
  }
  return paths;
}

function isUnderRootOrTasks(path: string, normRoots: { key: string; root: string }[]): boolean {
  if (path.startsWith(TASKS_PREFIX)) return true;
  const root = normRoots.find((r) => path.startsWith(`${r.root}/`));
  if (!root) return false;
  const rel = path.slice(root.root.length + 1);
  return rel.split('/')[0] !== ARCHIVE_SEGMENT;
}
