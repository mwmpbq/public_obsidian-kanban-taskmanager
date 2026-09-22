import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../../styles.css'), 'utf8');

describe('K7 styles.css uses only theme variables for color', () => {
  it('contains no hex color literal', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('has every rgb/hsl function reference a variable (rgba(var(--...)) is allowed)', () => {
    const calls = css.match(/\b(?:rgba?|hsla?)\([^)]*\)/g) ?? [];
    for (const call of calls) {
      expect(call, `${call} must be built from a var(--...)`).toMatch(/var\(--/);
    }
  });
});

describe('K3 collapsed column is a 40px vertical strip', () => {
  const rule = css.match(/\.ktm-column\[data-collapsed="true"\]\s*\{[^}]*\}/)?.[0] ?? '';
  const titleRule =
    css.match(/\.ktm-column\[data-collapsed="true"\] \.ktm-column-title\s*\{[^}]*\}/)?.[0] ?? '';

  it('is 40px wide via --size-4-10', () => {
    expect(rule).toMatch(/width:\s*var\(--size-4-10\)/);
  });

  it('renders the name upright', () => {
    expect(titleRule).toMatch(/writing-mode:\s*vertical-rl/);
  });
});
