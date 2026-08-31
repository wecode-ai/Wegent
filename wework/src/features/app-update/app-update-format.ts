export function formatAppUpdateVersion(template: string, version: string): string {
  return template.replace('{{version}}', version)
}

export function calculateAppUpdateDownloadPercent(
  downloadedBytes: number,
  totalBytes: number | null
): number | null {
  if (!totalBytes || totalBytes <= 0) return null
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
}
