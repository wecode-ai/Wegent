function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)])
  )
}

// Preserve JSON value semantics while making object property order irrelevant.
export function stableJsonStringify(value: unknown): string | undefined {
  return JSON.stringify(canonical(value))
}
