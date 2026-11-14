export interface PrivateDraftPersistence {
  read(): Record<string, string>
  write(scopeKey: string, value: string): void
  writeEntries(entries: Record<string, string>): void
}

export function privateDraftPersistence(
  accountKey: string,
  conversationKey: string
): PrivateDraftPersistence {
  const key = `wework.collaboration-exp.private-drafts.v1:${JSON.stringify([accountKey, conversationKey])}`
  function read(): Record<string, string> {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every(value => typeof value === 'string')
    )
      throw new Error('Invalid private discussion drafts')
    return parsed as Record<string, string>
  }
  function writeEntries(entries: Record<string, string>) {
    const values = read()
    for (const [scopeKey, value] of Object.entries(entries)) {
      if (value) values[scopeKey] = value
      else delete values[scopeKey]
    }
    if (Object.keys(values).length) localStorage.setItem(key, JSON.stringify(values))
    else localStorage.removeItem(key)
  }
  return { read, write: (scopeKey, value) => writeEntries({ [scopeKey]: value }), writeEntries }
}
