// Crockford's Base32 alphabet, lower case, without the four letters that are
// easily confused with digits (i, l, o, u are missing, 011 S25/S62).
const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LENGTH = 10;

/** `ktm_id` format any hand-written value must match (011, Pflichtfelder). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/** Whether `value` is a syntactically valid `ktm_id`. */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/**
 * A fresh `t-` id: ten random Crockford-Base32 characters, redrawn as long as
 * `taken` already contains the result (011 S25, S59 "Neue Kennung vergeben").
 * Uses `globalThis.crypto`, available in both Electron's renderer and Node 24
 * (no dependency, per the plan).
 */
export function newId(taken: ReadonlySet<string> = new Set()): string {
  let id: string;
  do {
    id = `t-${randomSuffix()}`;
  } while (taken.has(id));
  return id;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length];
  return out;
}
