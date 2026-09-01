import type {
  DeviceInfo,
  RuntimeFileChangesSummary,
  RuntimeHistoryCapability,
  RuntimeHistoryTurn,
  RuntimeChatBlock,
  RuntimeTranscriptMessage,
} from '@/types/runtime'

export function runtimeHistoryV2Capability(
  device: DeviceInfo | null | undefined
): RuntimeHistoryCapability | null {
  const capability = device?.runtime_features?.runtimeHistory
  return capability?.schemaVersions.includes(2) ? capability : null
}

export function runtimeHistoryTurnsToMessages(
  turns: RuntimeHistoryTurn[]
): RuntimeTranscriptMessage[] {
  return turns.flatMap(turn => {
    const userMessages = turn.items.flatMap(item =>
      item.type === 'user_message'
        ? [
            {
              ...item.message,
              turnId: item.message.turnId ?? turn.id,
            },
          ]
        : []
    )
    const assistantText = turn.items
      .flatMap(item => (item.type === 'assistant_text' ? [item.content] : []))
      .join('')
    const rawBlocks = turn.items.flatMap(item => (item.type === 'block' ? [item.block] : []))
    const fileChanges = turn.fileChanges ?? fileChangesFromBlocks(rawBlocks)
    const blocks = rawBlocks.filter(block => block.type !== 'file_changes')
    if (!assistantText && blocks.length === 0 && !fileChanges && !turn.error) return userMessages
    const firstCreatedAt = turn.items.find(
      item => item.type === 'assistant_text' && item.createdAt != null
    )
    return [
      ...userMessages,
      {
        id: `assistant-${turn.id}`,
        role: 'assistant',
        subtaskId: turn.id,
        turnId: turn.id,
        content: assistantText,
        status: turn.runtimeStatus ?? turn.status ?? 'done',
        ...(blocks.length > 0 && { blocks }),
        ...(fileChanges && { fileChanges }),
        ...(turn.completedAt != null && { completedAt: turn.completedAt }),
        ...(turn.error && { error: turn.error }),
        ...(turn.errorType && { errorType: turn.errorType }),
        ...(firstCreatedAt?.type === 'assistant_text' &&
          firstCreatedAt.createdAt != null && { createdAt: firstCreatedAt.createdAt }),
      } satisfies RuntimeTranscriptMessage,
    ]
  })
}

function fileChangesFromBlocks(blocks: RuntimeChatBlock[]): RuntimeFileChangesSummary | undefined {
  const summaries = blocks.flatMap(block => {
    const value = block.fileChanges ?? block.file_changes
    return isRecord(value) ? [value] : []
  })
  if (!summaries.length) return undefined

  const files = new Map<string, NonNullable<RuntimeFileChangesSummary['files']>[number]>()
  for (const summary of summaries) {
    const summaryFiles = Array.isArray(summary.files) ? summary.files : []
    for (const value of summaryFiles) {
      if (!isRecord(value) || typeof value.path !== 'string' || !value.path) continue
      const existing = files.get(value.path)
      const nextType = stringValue(value.changeType ?? value.change_type)
      const existingType = stringValue(existing?.changeType ?? existing?.change_type)
      files.set(value.path, {
        ...existing,
        ...value,
        path: value.path,
        changeType:
          existingType === 'created' && nextType === 'modified'
            ? 'created'
            : (nextType ?? existingType ?? 'modified'),
        additions: numberValue(existing?.additions) + numberValue(value.additions),
        deletions: numberValue(existing?.deletions) + numberValue(value.deletions),
      })
    }
  }
  if (!files.size) return undefined
  const mergedFiles = [...files.values()]
  return {
    fileCount: mergedFiles.length,
    additions: mergedFiles.reduce((total, file) => total + numberValue(file.additions), 0),
    deletions: mergedFiles.reduce((total, file) => total + numberValue(file.deletions), 0),
    files: mergedFiles,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
