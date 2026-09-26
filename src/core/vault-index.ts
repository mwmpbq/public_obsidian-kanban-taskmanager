import type { FileEntry, ProjectRoot } from './model';

/**
 * The file access an {@link ElementIndex} needs, supplied once by the caller
 * (the Obsidian adapter in the app, the fs adapter in tests, 011 S61/K30):
 * `list()` names every path worth indexing — carrying `ktm_id` or
 * `ktm_project` in its frontmatter — used only by {@link ElementIndex.load};
 * `read()` loads exactly one of them, for `load()` and for {@link
 * ElementIndex.changed}. A file without either key is never named by
 * `list()` and therefore never read.
 */
export interface FileSource {
  list(): Promise<string[]>;
  read(path: string): Promise<FileEntry | undefined>;
}

/**
 * A `ktm_id`-keyed, incremental index over the vault's element and project
 * notes (011, "Erkennung und Index"). Built once via {@link load}, then kept
 * current one file at a time: {@link changed} rereads exactly the path that
 * changed, {@link renamed} only relabels an entry already held, {@link
 * deleted} drops one. No method ever rereads the whole vault, so a single
 * edit costs a single read (K30).
 */
export class ElementIndex {
  private readonly source: FileSource;
  private byPath = new Map<string, FileEntry>();
  // Monotonic "last touched" marker per path (011 K5-K8), used only by
  // {@link latestEntries}: Obsidian, for an externally renamed file, has been
  // observed to deliver `changed` for the new path a full second or more
  // before the `delete` for the old one (measured against this vault), so
  // both briefly hold the same `ktm_id`. `entries()`/`roots()` and the read.ts
  // duplicate rule (011 S59, oldest `created` wins) are unaffected; they see
  // the raw, momentarily-doubled snapshot exactly as before.
  private touchByPath = new Map<string, number>();
  private touchSeq = 0;

  constructor(source: FileSource) {
    this.source = source;
  }

  /** Reads every listed path once, replacing whatever the index held before. */
  async load(): Promise<void> {
    const paths = await this.source.list();
    const next = new Map<string, FileEntry>();
    const touch = new Map<string, number>();
    for (const path of paths) {
      const entry = await this.source.read(path);
      if (entry) {
        next.set(path, entry);
        touch.set(path, ++this.touchSeq);
      }
    }
    this.byPath = next;
    this.touchByPath = touch;
  }

  /**
   * Rereads exactly `path`, told by the fresh `frontmatter` from the change
   * event itself whether that is worth doing at all (011 umsetzung; replaces
   * the earlier `list()`-then-`read()` shape, Wissen #762): without `ktm_id`
   * or `ktm_project`, the entry is dropped without a single call to `read()`
   * (K30's Gegenprobe — a note that never had the marker, or lost it, costs
   * zero reads, and `list()` is not consulted at all). Otherwise exactly one
   * `read(path)` replaces the held entry. Never touches another path.
   */
  async changed(path: string, frontmatter: Record<string, unknown> | undefined): Promise<void> {
    const hasMarker =
      typeof frontmatter?.ktm_id === 'string' || typeof frontmatter?.ktm_project === 'string';
    if (!hasMarker) {
      this.byPath.delete(path);
      this.touchByPath.delete(path);
      return;
    }
    const entry = await this.source.read(path);
    if (entry) {
      this.byPath.set(path, entry);
      this.touchByPath.set(path, ++this.touchSeq);
    } else {
      this.byPath.delete(path);
      this.touchByPath.delete(path);
    }
  }

  /**
   * Relabels every already-indexed entry under `oldPath` to `newPath` without
   * rereading it (011 umsetzung, ElementIndex): both the entry at `oldPath`
   * itself and any entry nested under it (`oldPath/...`), so a single event
   * for a renamed folder relabels its whole subtree even if Obsidian never
   * fires one for each child individually. Idempotent: a path the index
   * no longer holds under `oldPath` (already relabeled by an earlier, more
   * specific event) is simply skipped.
   */
  renamed(oldPath: string, newPath: string): void {
    const prefix = `${oldPath}/`;
    const moves: Array<[string, string]> = [];
    for (const path of this.byPath.keys()) {
      if (path === oldPath) moves.push([path, newPath]);
      else if (path.startsWith(prefix)) moves.push([path, newPath + path.slice(oldPath.length)]);
    }
    for (const [from, to] of moves) {
      const entry = this.byPath.get(from);
      if (!entry) continue;
      this.byPath.delete(from);
      this.byPath.set(to, { ...entry, path: to });
      // A `rename` is itself a fresh, authoritative signal (bumped like
      // `changed`, not carried over): it must outrank a same-id ghost a
      // lagging `delete` elsewhere left in latestEntries()'s window.
      this.touchByPath.delete(from);
      this.touchByPath.set(to, ++this.touchSeq);
    }
  }

  /** Drops `path` from the index, if it was held. */
  deleted(path: string): void {
    this.byPath.delete(path);
    this.touchByPath.delete(path);
  }

  /** Every entry currently held, in no particular order. */
  entries(): FileEntry[] {
    return [...this.byPath.values()];
  }

  /**
   * The entry held for `path` before it is touched (011, Ergänzung
   * 2026-09-25, main.ts#onNoteChanged): read before {@link changed} replaces
   * it, so the caller can diff `parent`/`project`/`type`/`status`/
   * `ktm_placement` against the frontmatter a change event just brought in.
   * `undefined` for a path the index never held — a brand-new note, or one
   * `ktm:migrate`/"Bestand übernehmen" just gave its first `ktm_id` — which is
   * exactly the signal that nothing should be placed on this change (011,
   * "beim Laden entsteht so kein Umzug").
   */
  get(path: string): FileEntry | undefined {
    return this.byPath.get(path);
  }

  /**
   * Every entry, but keeping only the most recently touched one where several
   * share a `ktm_id` (011 K5-K8): BoardView#retargetDetail's own resolution
   * for following an open card through a rename, distinct from read.ts's
   * `created`-based "oldest wins" rule for a genuine duplicate id (011 S59),
   * which reads {@link entries} directly and is unaffected. Freshness beats
   * the vault's own `created`/`ctime` here because those describe the file,
   * not when the index last saw it — exactly the distinction that matters
   * while a stale path briefly lingers alongside its renamed replacement.
   */
  latestEntries(): FileEntry[] {
    const bestSeq = new Map<string, number>();
    const bestEntry = new Map<string, FileEntry>();
    const withoutId: FileEntry[] = [];
    for (const [path, entry] of this.byPath) {
      const id = entry.frontmatter.ktm_id;
      if (typeof id !== 'string' || !id.trim()) {
        withoutId.push(entry);
        continue;
      }
      const seq = this.touchByPath.get(path) ?? 0;
      if ((bestSeq.get(id) ?? -1) < seq) {
        bestSeq.set(id, seq);
        bestEntry.set(id, entry);
      }
    }
    return [...withoutId, ...bestEntry.values()];
  }

  /** The {key, root} of every held project note, same rule readVault used. */
  roots(): ProjectRoot[] {
    const roots: ProjectRoot[] = [];
    for (const entry of this.byPath.values()) {
      const key = entry.frontmatter.ktm_project;
      const root = entry.frontmatter.ktm_root;
      if (typeof key === 'string' && typeof root === 'string') roots.push({ key, root });
    }
    return roots;
  }
}
