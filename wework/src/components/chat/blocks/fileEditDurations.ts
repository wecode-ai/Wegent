import type { ProcessingBlock } from '@/types/workbench'
import type { FileEditDuration, FileEditDurationsByBlock } from './ToolBlockItem'
import type { ProcessingDisplayRow } from './toolBlockActivity'
import { getFileInputPaths, isFileEditToolName } from './toolBlockKinds'

export function getFileEditDurationsBySourceBlock(
  blocks: ProcessingBlock[]
): FileEditDurationsByBlock {
  if (!blocks.some(block => block.type === 'file_changes')) return new Map()

  type FileEditActivity = FileEditDuration & {
    path: string
    isRunning: boolean
  }
  const edits: FileEditActivity[] = []
  const sourceDurations = new Map<string, ReadonlyMap<string, FileEditDuration>>()

  blocks.forEach(block => {
    if (block.type === 'tool' && isFileEditToolName(block.toolName)) {
      edits.push(
        ...getFileInputPaths(block).map(path => ({
          id: block.id,
          path: normalizeActivityPath(path),
          startedAt: block.createdAt,
          completedAt: block.completedAt,
          isRunning: block.status !== 'done' && block.status !== 'error',
        }))
      )
      return
    }
    if (block.type !== 'file_changes') return

    const blockDurations = new Map<string, FileEditDuration>()
    block.fileChanges.files.forEach(file => {
      const filePath = normalizeActivityPath(file.path)
      let durationMatch: FileEditActivity | undefined
      for (let index = edits.length - 1; index >= 0; index -= 1) {
        const edit = edits[index]
        if (
          edit.path === filePath ||
          edit.path.endsWith(`/${filePath}`) ||
          filePath.endsWith(`/${edit.path}`)
        ) {
          durationMatch = edit
          break
        }
      }
      if (!durationMatch) return
      blockDurations.set(file.path, {
        id: durationMatch.id,
        startedAt: durationMatch.startedAt,
        ...(!durationMatch.isRunning && durationMatch.completedAt !== undefined
          ? { completedAt: durationMatch.completedAt }
          : {}),
      })
    })
    if (blockDurations.size > 0) sourceDurations.set(block.id, blockDurations)
  })

  return sourceDurations
}

export function getFileEditDurationsForRows(
  sourceDurations: FileEditDurationsByBlock,
  rows: ProcessingDisplayRow[]
): FileEditDurationsByBlock {
  const durations = new Map<string, ReadonlyMap<string, FileEditDuration>>()

  rows.forEach(row => {
    if (row.type !== 'block' || row.block.type !== 'file_changes') return
    const blockDurations = new Map<string, FileEditDuration>()
    row.sourceBlockIds.forEach(sourceBlockId => {
      sourceDurations.get(sourceBlockId)?.forEach((duration, path) => {
        blockDurations.set(path, duration)
      })
    })
    if (blockDurations.size > 0) durations.set(row.block.id, blockDurations)
  })

  return durations
}

function normalizeActivityPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}
