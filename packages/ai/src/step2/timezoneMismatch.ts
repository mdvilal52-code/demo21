/**
 * Lightweight detector for an explicit timezone mention that conflicts with
 * the timezone the pickup location resolved to. Deliberately simple: a
 * fixed abbreviation → offset map (documented ambiguity: e.g. "IST" here
 * means India Standard Time, not Israel) rather than a full tz-abbreviation
 * resolver, which is out of scope for Phase 2's Dubai/UAE-only service.
 */
const ABBREVIATION_OFFSET_MINUTES: Record<string, number> = {
  utc: 0,
  gmt: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
  ist: 330,
  cet: 60,
  cest: 120,
};

const ABBREVIATION_RE = new RegExp(
  `\\b(${Object.keys(ABBREVIATION_OFFSET_MINUTES).join('|')})\\b`,
  'i',
);
const EXPLICIT_OFFSET_RE = /\b(?:UTC|GMT)\s*([+-]\d{1,2})(?::?(\d{2}))?\b/i;

export interface ExplicitTimezoneMention {
  raw: string;
  offsetMinutes: number;
}

export function findExplicitTimezoneMention(text: string): ExplicitTimezoneMention | null {
  const offsetMatch = EXPLICIT_OFFSET_RE.exec(text);
  if (offsetMatch?.[1]) {
    const hours = Number(offsetMatch[1]);
    const minutes = offsetMatch[2] ? Number(offsetMatch[2]) : 0;
    return { raw: offsetMatch[0], offsetMinutes: hours * 60 + (hours < 0 ? -minutes : minutes) };
  }

  const abbrevMatch = ABBREVIATION_RE.exec(text);
  if (abbrevMatch?.[1]) {
    const key = abbrevMatch[1].toLowerCase();
    return { raw: abbrevMatch[0], offsetMinutes: ABBREVIATION_OFFSET_MINUTES[key]! };
  }

  return null;
}

/** UTC offset (in minutes) of `timeZone` at `at`, DST-aware via Intl. */
export function getUtcOffsetMinutesAt(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(at);
  const offsetLabel = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(offsetLabel);
  if (!match?.[1]) return 0;
  const hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}
