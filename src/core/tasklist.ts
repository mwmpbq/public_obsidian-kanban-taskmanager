// `.` excludes \r, so the optional fourth group captures a CRLF line's
// trailing \r without $ (end of string, not end of line in JS regex)
// having to match ahead of it.
const TASK_LINE = /^(\s*-\s+)\[([ xX])\](.*)(\r)?$/;

// Flips the nth task-list checkbox (0-based, in document order) and leaves
// every other line byte-identical, including a trailing \r, since
// split/join on '\n' alone never touches it.
export function toggleTaskLine(body: string, index: number): string {
  const lines = body.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = TASK_LINE.exec(lines[i]);
    if (!match) continue;
    seen++;
    if (seen !== index) continue;
    const next = /[xX]/.test(match[2]) ? ' ' : 'x';
    lines[i] = `${match[1]}[${next}]${match[3]}${match[4] ?? ''}`;
    break;
  }
  return lines.join('\n');
}
