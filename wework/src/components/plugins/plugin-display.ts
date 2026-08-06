export function formatPluginVersion(value?: string | null): string {
  return value?.trim().replace(/-[0-9a-f]{8,}$/i, '') ?? ''
}
