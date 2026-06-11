/**
 * Minimal 5-field cron expression matcher.
 *
 * Replaces node-cron for the scheduler's needs: deciding whether a given
 * Date falls on an expression's schedule. Field syntax supported per field:
 * `*`, `n`, `a-b`, lists (`a,b,c`), and steps (`*​/n`, `a-b/n`) — the full
 * vocabulary used by standard crontabs. Six-field (seconds-first)
 * expressions are accepted but coarsened to minute precision: the seconds
 * field is ignored, so a seeder fires at most once per matching minute.
 *
 * Matching uses the process-local timezone, mirroring node-cron's default.
 */

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the field was `*` — needed for vixie dom/dow OR semantics. */
  domIsWildcard: boolean;
  dowIsWildcard: boolean;
}

const FIELD_RANGES: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 }, // 0 and 7 are both Sunday
];

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid step "${stepPart}" in ${name} field`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === '') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      // A bare value with a step (`5/10`) extends to the field max, per vixie.
      hi = stepPart === undefined ? lo : max;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`invalid range "${rangePart}" in ${name} field (allowed ${min}-${max})`);
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }

  return values;
}

/**
 * Parse a cron expression. Throws with a descriptive message when the
 * expression is malformed, so callers can reject a seeder at registration
 * time instead of failing silently at runtime.
 */
export function parseCron(expression: string): ParsedCron {
  let fields = expression.trim().split(/\s+/);

  if (fields.length === 6) {
    // Seconds-first form: ignore seconds, run once per matching minute.
    fields = fields.slice(1);
  }
  if (fields.length !== 5) {
    throw new Error(`expected 5 fields (or 6 with seconds), got ${fields.length}: "${expression}"`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, i) => {
    const { name, min, max } = FIELD_RANGES[i];
    return parseField(field, min, max, name);
  });

  // Normalize Sunday: 7 → 0.
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domIsWildcard: fields[2] === '*',
    dowIsWildcard: fields[4] === '*',
  };
}

/**
 * Does `date` (interpreted in local time) fall on the parsed schedule?
 *
 * Day-of-month and day-of-week follow vixie cron semantics: when both
 * fields are restricted, a date matches if EITHER matches.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());

  if (parsed.domIsWildcard && parsed.dowIsWildcard) return true;
  if (parsed.domIsWildcard) return dowMatch;
  if (parsed.dowIsWildcard) return domMatch;
  return domMatch || dowMatch;
}
