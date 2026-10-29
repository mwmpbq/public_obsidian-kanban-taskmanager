import { FENCE_LINE } from './markup';

// Matches a task-list line the way Obsidian's renderer draws a checkbox for
// it (002, Ergänzung 2026-10-19): optional indentation, an optional
// blockquote prefix, a `-`/`*`/`+` marker or a numbered one (`1.`/`1)`),
// whitespace, then `[` + exactly one state character + `]`. `.` excludes
// \r, so the optional fifth group captures a CRLF line's trailing \r
// without $ (end of string, not end of line in JS regex) having to match
// ahead of it.
const TASK_LINE = /^(\s*(?:>\s*)?(?:[-*+]|\d+[.)])\s+)\[(.)\](.*)(\r)?$/;

// Flips the nth task-list checkbox (0-based, in the order Obsidian's
// renderer draws them) and leaves every other line byte-identical,
// including a trailing \r, since split/join on '\n' alone never touches it.
// A line inside a fenced code block (``` or ~~~) is never counted, matching
// how the renderer shows it as plain text rather than an interactive
// checkbox.
export function toggleTaskLine(body: string, index: number): string {
  const lines = body.split('\n');
  let seen = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    seen++;
    if (seen !== index) continue;
    // Any non-space state becomes space, space becomes checked (002,
    // Ergänzung 2026-10-19): the toggle generalizes beyond `x`/`X`/` ` so a
    // line like `- [-]` flips too, without ever producing a third state.
    const next = match[2].trim() === '' ? 'x' : ' ';
    lines[i] = `${match[1]}[${next}]${match[3]}${match[4] ?? ''}`;
    break;
  }
  return lines.join('\n');
}
