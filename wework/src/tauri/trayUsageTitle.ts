export function buildTrayUsageTitle({
  codex,
  compactCodex,
  wegent,
}: {
  codex: string | null
  compactCodex: string | null
  wegent: string | null
}): string | null {
  if (!codex) return wegent
  if (!wegent) return codex
  return `${compactCodex ?? codex.split('\n')[0]}\n${wegent}`
}
