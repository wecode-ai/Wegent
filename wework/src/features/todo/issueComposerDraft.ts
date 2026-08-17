export function issueDraftFromText(value: string): { title: string; description: string } {
  const lines = value
    .trim()
    .split('\n')
    .map(line => line.trim())
  const title = lines.find(Boolean) ?? ''
  const titleIndex = lines.indexOf(title)
  return {
    title,
    description: lines
      .slice(titleIndex + 1)
      .filter(Boolean)
      .join('\n'),
  }
}
