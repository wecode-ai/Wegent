export function issueDraftFromText(value: string): { title: string; description: string } {
  const description = value.trim()
  return {
    title: description ? description.replace(/\s+/g, ' ').trim() : '',
    description,
  }
}
