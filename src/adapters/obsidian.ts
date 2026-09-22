import { type App, getFrontMatterInfo, MarkdownView, type TFile, TFolder } from 'obsidian';
import { FORMAT_NOTE, FORMAT_NOTE_PATH } from '../core/format-doc';
import { applyFrontmatter, type FrontmatterChange } from '../core/frontmatter';
import type { FileEntry, ProjectRoot } from '../core/model';

export interface VaultData {
  entries: FileEntry[];
  roots: ProjectRoot[];
}

/**
 * Reads every markdown file of the vault into the plain shape the core expects.
 * Frontmatter comes from the MetadataCache; the body is the file content below
 * the frontmatter block, taken via `getFrontMatterInfo` so a `---` inside the
 * body is not mistaken for its end. Obsidian is confined to this module, the
 * core never imports it.
 */
export async function readVault(app: App): Promise<VaultData> {
  const entries: FileEntry[] = [];
  const roots: ProjectRoot[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter = { ...(cache?.frontmatter ?? {}) };
    delete frontmatter.position;

    const raw = await app.vault.cachedRead(file);
    const info = getFrontMatterInfo(raw);
    const body = info.exists ? raw.slice(info.contentStart) : raw;

    entries.push({ path: file.path, frontmatter, body });

    const key = frontmatter.ktm_project;
    const root = frontmatter.ktm_root;
    if (typeof key === 'string' && typeof root === 'string') {
      roots.push({ key, root });
    }
  }

  return { entries, roots };
}

/**
 * The single sanctioned write path for a task note. Any view holding the file
 * open is flushed first so `Vault.process` does not run against a stale disk
 * copy; the change then edits only known frontmatter keys and keeps the rest of
 * the file byte-identical. A file without frontmatter is left untouched.
 */
export async function writeFrontmatter(
  app: App,
  path: string,
  change: FrontmatterChange,
): Promise<void> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`Note nicht gefunden: ${path}`);

  await flushOpenViews(app, file);

  const reindexed = nextMetadataChange(app, file.path);
  await app.vault.process(file, (data) => {
    const info = getFrontMatterInfo(data);
    if (!info.exists) return data;
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
 * Moves an element to `to` via `FileManager.renameFile`, the only move that
 * pulls the vault's wikilinks along; a folder moves as a whole in one call.
 * `renameFile` does not create the target's parent, so the parent folder is
 * ensured to exist first. When `to` already exists as a folder — a container
 * whose Done mirror was seeded by an earlier child — the whole rename would
 * fail, so each remaining entry of the source is moved into the existing target
 * and the emptied source folder is trashed.
 */
export async function moveElement(app: App, from: string, to: string, parent: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(from);
  if (!file) throw new Error(`Element nicht gefunden: ${from}`);
  await ensureFolder(app, parent);

  const target = app.vault.getAbstractFileByPath(to);
  if (file instanceof TFolder && target instanceof TFolder) {
    for (const child of [...file.children]) {
      await app.fileManager.renameFile(child, `${to}/${child.name}`);
    }
    await app.fileManager.trashFile(file);
    return;
  }

  await app.fileManager.renameFile(file, to);
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
 * Writes the format description once. On a vault that already has the note this
 * is a no-op, so it can run on every load; a concurrent creation is tolerated
 * by re-checking after a failed create.
 */
export async function ensureFormatDoc(app: App): Promise<void> {
  if (app.vault.getAbstractFileByPath(FORMAT_NOTE_PATH)) return;
  const cut = FORMAT_NOTE_PATH.lastIndexOf('/');
  if (cut !== -1) await ensureFolder(app, FORMAT_NOTE_PATH.slice(0, cut));
  try {
    await app.vault.create(FORMAT_NOTE_PATH, FORMAT_NOTE);
  } catch (err) {
    if (!app.vault.getAbstractFileByPath(FORMAT_NOTE_PATH)) throw err;
  }
}
