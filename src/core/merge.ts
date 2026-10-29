/**
 * Decides what happens to a move's target and, when it is a pre-existing
 * `Done/` mirror without its own element note, carries the merge out (008,
 * Ergänzung 2026-10-19 "Der berechnete Ort ist schon belegt"). Pure
 * TypeScript against the async {@link MergeFs} instead of the Obsidian API
 * directly, so the whole walk is provable with Vitest against a nachgebildetes
 * filesystem (008 S66-S70); adapters/obsidian.ts supplies the real one.
 */
export interface MergeFs {
  /** Names of the direct children of `path`; empty when nothing is there. */
  list(path: string): Promise<string[]>;
  /** Whether a folder sits at `path` (false for a file or for nothing at all). */
  isFolder(path: string): Promise<boolean>;
  /** Whether the folder `path` directly holds a note carrying `ktm_id`. */
  hasElementNote(path: string): Promise<boolean>;
  /** Moves exactly one file; throws when `to` already exists. */
  moveFile(from: string, to: string): Promise<void>;
  /** Creates `path` if it is not already there. */
  createFolder(path: string): Promise<void>;
  /** Removes `path`, but only when a fresh read finds it with no children left. */
  removeIfEmpty(path: string): Promise<void>;
}

export type ClassifyResult = { kind: 'free' } | { kind: 'merge' } | { kind: 'occupied'; reason: string };

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

async function kindOf(fs: MergeFs, path: string): Promise<'missing' | 'file' | 'folder'> {
  if (await fs.isFolder(path)) return 'folder';
  const siblings = await fs.list(dirOf(path));
  return siblings.includes(baseName(path)) ? 'file' : 'missing';
}

/**
 * The first path where a file of `from` would already have a same-named
 * entry under `to`, checked recursively through same-named subfolders (008
 * S67/S69/S70) — the up-front half of "ganz oder gar nicht" (K5): nothing
 * moves before this has run clean.
 */
async function findCollision(fs: MergeFs, from: string, to: string): Promise<string | undefined> {
  const targetNames = new Set(await fs.list(to));
  for (const name of await fs.list(from)) {
    if (!targetNames.has(name)) continue;
    const src = `${from}/${name}`;
    const dst = `${to}/${name}`;
    if ((await fs.isFolder(src)) && (await fs.isFolder(dst))) {
      const nested = await findCollision(fs, src, dst);
      if (nested) return nested;
    } else {
      return dst;
    }
  }
  return undefined;
}

/**
 * Classifies `to` as a move target for `from` (008, Ergänzung 2026-10-19):
 * missing is `'free'`; a pre-existing folder without a direct element note,
 * with no file of `from` already claimed inside it, is `'merge'` when
 * `allowMerge` allows it at all — the caller decides that from
 * core/placement.ts#isInDoneMirror, since merging is only ever allowed into a
 * `Done/` mirror (008, "ausserhalb"). Everything else is `'occupied'`, with a
 * reason naming the concrete blocking path.
 */
export async function classifyTarget(
  fs: MergeFs,
  from: string,
  to: string,
  allowMerge: boolean,
): Promise<ClassifyResult> {
  const targetKind = await kindOf(fs, to);
  if (targetKind === 'missing') return { kind: 'free' };
  if (targetKind === 'file') return { kind: 'occupied', reason: `Ziel ist eine Datei: ${to}` };

  if ((await kindOf(fs, from)) !== 'folder') {
    return { kind: 'occupied', reason: `Ziel existiert bereits: ${to}` };
  }
  if (!allowMerge || (await fs.hasElementNote(to))) {
    return { kind: 'occupied', reason: `Ziel existiert bereits: ${to}` };
  }
  const collision = await findCollision(fs, from, to);
  if (collision) return { kind: 'occupied', reason: `Ziel existiert bereits: ${collision}` };
  return { kind: 'merge' };
}

/**
 * Merges `from` into `to` file by file (008 S66): a same-named subfolder is
 * merged the same way, recursively, and a missing target folder is created
 * along the way. No file already sitting at its target is ever moved onto —
 * {@link classifyTarget} has already ruled that out for the state at the
 * start of the call, so only a file that appears in `from` afterwards (S68)
 * can still find its target name taken. `from` is removed only once {@link
 * MergeFs.removeIfEmpty} finds it empty on a fresh read, so a file that
 * appears there after this function has already listed it (the K9/S68 race)
 * keeps the folder standing.
 */
export async function mergeInto(fs: MergeFs, from: string, to: string): Promise<void> {
  if (!(await fs.isFolder(to))) await fs.createFolder(to);
  const dstNames = new Set(await fs.list(to));
  for (const name of await fs.list(from)) {
    const src = `${from}/${name}`;
    const dst = `${to}/${name}`;
    if (await fs.isFolder(src)) {
      await mergeInto(fs, src, dst);
    } else if (!dstNames.has(name)) {
      await fs.moveFile(src, dst);
    }
  }
  await fs.removeIfEmpty(from);
}
