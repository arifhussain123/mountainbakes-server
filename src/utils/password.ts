import { randomInt } from 'crypto';

// Character sets exclude visually ambiguous glyphs (0/O, 1/l/I) so a temporary
// password read off a screen is less error-prone.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const NUMS = '23456789';
const SPECIAL = '!@#$%*?';

function pick(chars: string): string {
  return chars[randomInt(chars.length)]!;
}

/**
 * Generate a 12-character temporary password that always satisfies the strong
 * password policy (upper, lower, number, special) — guaranteed by seeding one of
 * each class, then filling and shuffling.
 */
export function generateTempPassword(): string {
  const all = UPPER + LOWER + NUMS + SPECIAL;
  const chars = [pick(UPPER), pick(LOWER), pick(NUMS), pick(SPECIAL)];
  while (chars.length < 12) chars.push(pick(all));

  // Fisher–Yates shuffle so the guaranteed classes aren't always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
