// Pure text logic for the description field's "like Obsidian's editor"
// behaviour (002 S59-S63): no DOM, no `obsidian` import, so it stays testable
// and reusable both for the pairing-on-typing path and the bold/italic
// hotkey. All three functions take a selection as [start, end) into `text`
// and return the resulting text together with the selection that keeps
// pointing at the same inner content, the way CodeMirror leaves it selected
// after a pair or a toggle.

export interface MarkupResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

// Wraps [start, end) with `open`/`close`, keeping the original inner text
// selected (002 S59/S60: two keystrokes call this twice, nesting the pairs).
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  open: string,
  close: string,
): MarkupResult {
  const inner = text.slice(start, end);
  return {
    text: text.slice(0, start) + open + inner + close + text.slice(end),
    selectionStart: start + open.length,
    selectionEnd: start + open.length + inner.length,
  };
}

// Fett/Kursiv per Tastenkürzel (002 S62): wraps [start, end) with `marker`
// on both sides, or strips it if it is already there — either just outside
// the selection (the common case, selection still on the inner word after a
// previous toggle) or inside it (the user selected the marked-up text
// itself). Either way the inner text stays selected.
export function toggleMarkup(text: string, start: number, end: number, marker: string): MarkupResult {
  const before = text.slice(Math.max(0, start - marker.length), start);
  const after = text.slice(end, end + marker.length);
  if (marker.length > 0 && before === marker && after === marker) {
    return {
      text: text.slice(0, start - marker.length) + text.slice(start, end) + text.slice(end + marker.length),
      selectionStart: start - marker.length,
      selectionEnd: end - marker.length,
    };
  }
  const selected = text.slice(start, end);
  if (marker.length > 0 && selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  return {
    text: text.slice(0, start) + marker + selected + marker + text.slice(end),
    selectionStart: start + marker.length,
    selectionEnd: end + marker.length,
  };
}

// Exported so tasklist.ts#toggleTaskLine can skip the same fenced-code
// stretches without redefining the rule (002, Ergänzung 2026-10-19).
export const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;

function isBlankLine(line: string): boolean {
  return line.replace(/\r$/, '').trim() === '';
}

// Every blank line in the body becomes exactly one `.ktm-blank-line` block
// before the body goes to MarkdownRenderer.render (002 S63, wissen #293):
// plain CommonMark collapses any run of blank lines into a single paragraph
// break, so without this a description with one blank line looks identical
// to one with three. Each block sits between its own pair of blank lines so
// it parses as its own HTML block rather than swallowing the following
// paragraph. Blank lines inside a fenced code block are left untouched, the
// fence already preserves them visually.
export function expandBlankLines(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (!inFence && isBlankLine(line)) {
      let count = 0;
      while (i < lines.length && isBlankLine(lines[i])) {
        count++;
        i++;
      }
      out.push('');
      for (let n = 0; n < count; n++) {
        out.push('<div class="ktm-blank-line"></div>');
        out.push('');
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}
