const EXPLICIT_TIME_ZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseBackendTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = EXPLICIT_TIME_ZONE_PATTERN.test(trimmed)
    ? trimmed
    : `${trimmed}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatIssueTimestamp(value: string, timeZone?: string): string {
  const date = parseBackendTimestamp(value);
  if (!date) return "--";

  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

export function compareIssueTimestamps(left: string, right: string): number {
  const leftTime = parseBackendTimestamp(left)?.getTime();
  const rightTime = parseBackendTimestamp(right)?.getTime();

  if (leftTime === undefined) return rightTime === undefined ? 0 : -1;
  if (rightTime === undefined) return 1;
  return leftTime - rightTime;
}
