/** Routing authority is significant; object property insertion order is not. */
export function boardRuntimeReadKey(value: unknown): string {
  return JSON.stringify(value, (_, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))
        )
      : entry
  )
}
