export function hasEmbeddedHttpGitCredentials(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return Boolean(parsed.username || parsed.password)
  } catch {
    return false
  }
}
