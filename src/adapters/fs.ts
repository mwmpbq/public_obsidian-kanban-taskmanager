import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { FileEntry, ProjectRoot } from '../core/model';

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
    const { frontmatter, body } = splitFrontmatter(readFileSync(abs, 'utf8'));
    entries.push({ path, frontmatter, body });

    const key = frontmatter.ktm_project;
    const root = frontmatter.ktm_root;
    if (typeof key === 'string' && typeof root === 'string') {
      roots.push({ key, root });
    }
  }

  return { entries, roots };
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

function splitFrontmatter(raw: string): {
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
