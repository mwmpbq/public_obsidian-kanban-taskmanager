import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { FileEntry, ProjectRoot } from '../core/model';
import type { FileSource } from '../core/vault-index';

export interface LoadedVault {
  entries: FileEntry[];
  roots: ProjectRoot[];
}

/**
 * Test adapter for the core: walks a vault directory on disk, parses the
 * frontmatter of every markdown file, and collects {key, root} from notes
 * that carry the `ktm_project` marker. Obsidian is not available here, so the
 * core is exercised against the fixture files through this reader.
 */
export function loadVault(vaultDir: string): LoadedVault {
  const entries: FileEntry[] = [];
  const roots: ProjectRoot[] = [];

  for (const abs of walk(vaultDir)) {
    if (!abs.endsWith('.md')) continue;
    const path = relative(vaultDir, abs).split(sep).join('/');
    const entry = readEntry(vaultDir, path);
    entries.push(entry);

    const key = entry.frontmatter.ktm_project;
    const root = entry.frontmatter.ktm_root;
    if (typeof key === 'string' && typeof root === 'string') {
      roots.push({ key, root });
    }
  }

  return { entries, roots };
}

function readEntry(vaultDir: string, path: string): FileEntry {
  const abs = join(vaultDir, ...path.split('/'));
  const { frontmatter, body } = splitFrontmatter(readFileSync(abs, 'utf8'));
  const ctime = statSync(abs).ctimeMs;
  return { path, frontmatter, body, ctime };
}

/**
 * {@link FileSource} over a vault directory on disk (011 S61/K30): `list()`
 * walks the tree once and keeps only paths whose frontmatter carries
 * `ktm_id` or `ktm_project`, `read()` reparses exactly the one file asked
 * for. Used by the {@link ElementIndex} tests, which need to count reads.
 */
export function fsFileSource(vaultDir: string): FileSource {
  return {
    async list(): Promise<string[]> {
      const paths: string[] = [];
      for (const abs of walk(vaultDir)) {
        if (!abs.endsWith('.md')) continue;
        const path = relative(vaultDir, abs).split(sep).join('/');
        const { frontmatter } = readEntry(vaultDir, path);
        if (typeof frontmatter.ktm_id === 'string' || typeof frontmatter.ktm_project === 'string') {
          paths.push(path);
        }
      }
      return paths;
    },
    async read(path: string): Promise<FileEntry | undefined> {
      try {
        return readEntry(vaultDir, path);
      } catch {
        return undefined;
      }
    },
  };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Exported for tests that need to round-trip written content through a real YAML parser (F067). */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const norm = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(norm);
  if (!match) return { frontmatter: {}, body: norm };

  const parsed = parseYaml(match[1]);
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: norm.slice(match[0].length) };
}
