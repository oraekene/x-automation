const MS_PER_MINUTE = 60_000;

export const DEFAULT_INTERVAL_MINUTES = 1440;

// Normalise a client-supplied interval: floor to whole minutes, default to the
// daily cadence, and reject anything below one minute.
export function coerceIntervalMinutes(raw: unknown): { minutes: number; ok: boolean } {
  const minutes = typeof raw === "number" ? Math.floor(raw) : DEFAULT_INTERVAL_MINUTES;
  return { minutes, ok: minutes >= 1 };
}

// Is this a resolvable IANA time zone? The same Intl construction the offset
// math below relies on, so one options-set lives here.
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Offset (in ms) of the given IANA time zone at the given instant, derived from
// the zone's wall clock. Workerd ships full ICU so Intl resolves IANA zones.
export function zoneOffsetMs(timeZone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const read = (type: string, fallback: string): string =>
    parts.find((p) => p.type === type)?.value ?? fallback;
  const wallAsUtc = Date.UTC(
    Number(read("year", "0")),
    Number(read("month", "1")) - 1,
    Number(read("day", "1")),
    Number(read("hour", "0")),
    Number(read("minute", "0")),
    Number(read("second", "0")),
  );
  return wallAsUtc - atMs;
}

// The next wall-clock moment `intervalMinutes` after `atMs`, expressed in the
// given zone. Handles DST by re-deriving the offset at each local anchor.
export function addIntervalInZone(atMs: number, intervalMinutes: number, timeZone: string): number {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  }
  const localNow = atMs + zoneOffsetMs(timeZone, atMs);
  const localNext = localNow + intervalMinutes * MS_PER_MINUTE;
  return localNext - zoneOffsetMs(timeZone, localNext);
}