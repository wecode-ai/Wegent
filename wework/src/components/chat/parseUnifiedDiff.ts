export interface DiffFileSection {
  oldPath?: string
  path: string
  lines: string[]
}

const DIFF_HEADER_PATTERN = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/

export function parseUnifiedDiff(diff: string): DiffFileSection[] {
  const sections: DiffFileSection[] = []
  const sectionsByPath = new Map<string, DiffFileSection>()
  let current: DiffFileSection | null = null

  for (const line of diff.split('\n')) {
    const match = line.match(DIFF_HEADER_PATTERN)
    if (match) {
      const path = match[2]
      const existing = sectionsByPath.get(path)
      if (existing) {
        // Merge multiple diff blocks for the same file into a single section
        // so the file shows up once with all of its hunks.
        existing.lines.push(line)
        current = existing
        continue
      }
      current = {
        oldPath: match[1],
        path,
        lines: [line],
      }
      sectionsByPath.set(path, current)
      sections.push(current)
      continue
    }
    current?.lines.push(line)
  }

  return sections
}
