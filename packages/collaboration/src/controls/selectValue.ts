export function normalizeSelectValue(value: unknown): string {
  return value == null ? '' : String(value)
}
