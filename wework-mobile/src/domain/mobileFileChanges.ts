import type { ChatFileChangeItem, ChatFileChangesSummary } from '@/types/runtime'

export function fileChangesSourceKey(summary: ChatFileChangesSummary | undefined): string {
  const source = summary?.source
  return source ? JSON.stringify([source.device_id, source.workspace_path, source.artifact_id]) : ''
}

export function mergeFileChangesSummaries(
  summaries: ChatFileChangesSummary[]
): ChatFileChangesSummary {
  const files = new Map<string, ChatFileChangeItem>()
  for (const summary of summaries) {
    for (const file of summary.files) {
      const key = `${file.oldPath ?? ''}\0${file.path}`
      const existing = files.get(key)
      files.set(
        key,
        existing
          ? {
              ...file,
              additions: existing.additions + file.additions,
              deletions: existing.deletions + file.deletions,
              binary: existing.binary || file.binary,
            }
          : file
      )
    }
  }
  return {
    source: summaries.every(
      summary => fileChangesSourceKey(summary) === fileChangesSourceKey(summaries[0])
    )
      ? summaries.at(-1)?.source
      : undefined,
    fileCount: files.size,
    additions: summaries.reduce((sum, summary) => sum + summary.additions, 0),
    deletions: summaries.reduce((sum, summary) => sum + summary.deletions, 0),
    files: [...files.values()],
  }
}
