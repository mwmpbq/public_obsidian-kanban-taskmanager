import { describe, expect, it } from 'vitest';
import { toggleTaskLine } from './tasklist';

const BODY = [
  'Die Pipeline bricht ab, sobald eine Eingabedatei 0 Byte groß ist.',
  '',
  '- [x] Fehler reproduzieren',
  '- [x] Testdatei mit 0 Byte anlegen',
  '- [ ] Parser um Leerdatei-Prüfung ergänzen',
  '- [ ] Regressionstest schreiben',
  '- [ ] Auf Staging prüfen',
].join('\n');

describe('toggleTaskLine', () => {
  it('checks the target line and leaves every other line byte-identical', () => {
    const next = toggleTaskLine(BODY, 3);
    const nextLines = next.split('\n');
    const bodyLines = BODY.split('\n');
    expect(nextLines[5]).toBe('- [x] Regressionstest schreiben');
    for (let i = 0; i < bodyLines.length; i++) {
      if (i === 5) continue;
      expect(nextLines[i]).toBe(bodyLines[i]);
    }
  });

  it('unchecks an already checked line', () => {
    const next = toggleTaskLine(BODY, 0);
    expect(next.split('\n')[2]).toBe('- [ ] Fehler reproduzieren');
  });

  it('does nothing when the index is out of range', () => {
    expect(toggleTaskLine(BODY, 5)).toBe(BODY);
  });

  it('flips the nth task line in a CRLF-terminated body and keeps every other line byte-identical, including \\r', () => {
    const crlfBody = BODY.split('\n').join('\r\n');
    const next = toggleTaskLine(crlfBody, 3);
    const nextLines = next.split('\n');
    const bodyLines = crlfBody.split('\n');
    expect(nextLines[5]).toBe('- [x] Regressionstest schreiben\r');
    for (let i = 0; i < bodyLines.length; i++) {
      if (i === 5) continue;
      expect(nextLines[i]).toBe(bodyLines[i]);
    }
  });
});
