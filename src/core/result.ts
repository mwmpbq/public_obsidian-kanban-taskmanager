/**
 * Determines what happens when a document is assigned to an element as a
 * Result (002, Ergänzung 2026-10-19 "Result"; 008, Ergänzung 2026-10-19 "Ein
 * Result wandert zu seinem Ziel"). No Obsidian import: the caller resolves
 * the target's note path (ResultDialog's chosen ancestor or search hit,
 * defaulting to the task's direct parent when nothing was chosen yet) and
 * supplies an `exists` predicate backed by the vault.
 */
export type ResultPlan =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'link-only' }
  | { kind: 'occupied'; from: string; to: string }
  | { kind: 'no-target' };

/**
 * `targetNotePath` is the note of the chosen element — a feature, epic or
 * atomic element's own note — whichever level the Result-Dialog is about.
 * The target folder is simply that note's folder (K2: true for an atomic
 * element too, since its note already sits alone in its own folder); the
 * document's own file name never changes, only its folder.
 */
export function planResult(
  filePath: string,
  targetNotePath: string | undefined,
  exists: (path: string) => boolean,
): ResultPlan {
  if (!targetNotePath) return { kind: 'no-target' };
  const targetFolder = dirOf(targetNotePath);
  const fromFolder = dirOf(filePath);
  if (fromFolder === targetFolder) return { kind: 'link-only' };

  const to = joinPath(targetFolder, baseName(filePath));
  if (exists(to)) return { kind: 'occupied', from: filePath, to };
  return { kind: 'move', from: filePath, to };
}

/**
 * Entries from a task's `results` that are not yet assigned (005, Ergänzung
 * 2026-10-19 "Results für Claude"): a path counts as assigned once it sits in
 * the folder of an element that itself carries it in `notes` — one without
 * the other still counts as open. `carriersOf` resolves a path to the note
 * paths of every element whose `notes` lists it (matched by resolved file,
 * not raw text, wissen #1186); duplicate `results` entries (the same
 * resolved path twice, wissen #1178) are reported once.
 */
export function unassignedResults(resultPaths: string[], carriersOf: (path: string) => string[]): string[] {
  const seen = new Set<string>();
  const unassigned: string[] = [];
  for (const path of resultPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const folder = dirOf(path);
    const assigned = carriersOf(path).some((notePath) => dirOf(notePath) === folder);
    if (!assigned) unassigned.push(path);
  }
  return unassigned;
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}
