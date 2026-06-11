export interface DiffFileSection {
  oldPath?: string
  path: string
  lines: string[]
}

const DIFF_HEADER_PATTERN = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/

export function parseUnifiedDiff(diff: string): DiffFileSection[] {
  const sections: DiffFileSection[] = []
  let current: DiffFileSection | null = null

  for (const line of diff.split('\n')) {
    const match = line.match(DIFF_HEADER_PATTERN)
    if (match) {
      current = {
        oldPath: match[1],
        path: match[2],
        lines: [line],
      }
      sections.push(current)
      continue
    }
    current?.lines.push(line)
  }

  return sections
}
