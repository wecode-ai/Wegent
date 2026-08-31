export function normalizeGeneratedBranchName(value: string): string {
  return value
    .split(/\r?\n/, 1)[0]
    .trim()
    .replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
}

export function resolveBranchNameGenerationSource(
  composerValue: string,
  fallbackSource?: string
): string {
  return composerValue.trim() || fallbackSource?.trim() || ''
}
