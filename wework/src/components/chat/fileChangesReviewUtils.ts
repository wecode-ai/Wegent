import type { DiffLineAnnotation, DiffLineEventBaseProps, SelectedLineRange } from '@pierre/diffs'
import type { GitPatchAction } from '@/api/environment'

export interface DiffCommentSelection {
  key: string
  path: string
  range: SelectedLineRange
  selectedText: string
  startLine: number
  endLine: number
}

export type FileChangesReviewMode = 'branch' | 'unstaged' | 'staged' | 'commit' | 'previous-turn'

export function getReviewActions(reviewMode?: FileChangesReviewMode): GitPatchAction[] {
  if (reviewMode === 'unstaged') return ['revert', 'stage']
  if (reviewMode === 'staged') return ['unstage']
  return []
}

export function getDiffSelection(
  patch: string,
  range: SelectedLineRange
): Pick<DiffCommentSelection, 'selectedText' | 'startLine' | 'endLine'> | null {
  const rows = getDiffRows(patch)
  const startSide = range.side ?? 'additions'
  const endSide = range.endSide ?? startSide
  const startIndex = rows.findIndex(row => lineMatchesSelection(row, range.start, startSide))
  const endIndex = rows.findIndex(row => lineMatchesSelection(row, range.end, endSide))
  if (startIndex < 0 || endIndex < 0) return null

  const selectedRows = rows.slice(
    Math.min(startIndex, endIndex),
    Math.max(startIndex, endIndex) + 1
  )
  const selectedText = selectedRows
    .map(row => row.text)
    .join('\n')
    .trim()
  if (!selectedText) return null
  const lineNumbers = selectedRows
    .map(row => row.additionLine ?? row.deletionLine)
    .filter((line): line is number => line !== undefined)
  return {
    selectedText,
    startLine: Math.min(...lineNumbers),
    endLine: Math.max(...lineNumbers),
  }
}

export function getFirstChangedLine(lines: string[]): number | undefined {
  for (const line of lines) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (header) return Number(header[1])
  }
  return undefined
}

export function getOpenSourceLine(
  line: Pick<DiffLineEventBaseProps, 'annotationSide' | 'lineNumber'>
): number | null {
  return line.annotationSide === 'additions' ? line.lineNumber : null
}

export function getHunkActionAnchor(
  patch: string
): Pick<DiffLineAnnotation, 'side' | 'lineNumber'> | null {
  let deletionLine = 0
  let additionLine = 0
  let inHunk = false
  let anchor: Pick<DiffLineAnnotation, 'side' | 'lineNumber'> | null = null

  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header) {
      deletionLine = Number(header[1])
      additionLine = Number(header[2])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue
    if (line.startsWith('+')) {
      anchor = { side: 'additions', lineNumber: additionLine }
      additionLine += 1
    } else if (line.startsWith('-')) {
      anchor = { side: 'deletions', lineNumber: deletionLine }
      deletionLine += 1
    } else {
      additionLine += 1
      deletionLine += 1
    }
  }

  return anchor
}

export function ensureTrailingNewline(value: string) {
  return value.endsWith('\n') ? value : `${value}\n`
}

export function fileNameFromPath(path: string) {
  return path.split('/').pop() || path
}

export function getHunkPatches(patch: string): string[] {
  const lines = patch.split('\n')
  const hunkStarts = lines.flatMap((line, index) => (line.startsWith('@@ ') ? [index] : []))
  if (hunkStarts.length === 0) return [ensureTrailingNewline(patch)]
  const header = lines.slice(0, hunkStarts[0])
  return hunkStarts.map((start, index) =>
    ensureTrailingNewline([...header, ...lines.slice(start, hunkStarts[index + 1])].join('\n'))
  )
}

interface DiffRow {
  text: string
  additionLine?: number
  deletionLine?: number
}

function getDiffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let deletionLine = 0
  let additionLine = 0
  let inHunk = false

  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header) {
      deletionLine = Number(header[1])
      additionLine = Number(header[2])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue
    if (line.startsWith('+')) {
      rows.push({ text: line.slice(1), additionLine })
      additionLine += 1
    } else if (line.startsWith('-')) {
      rows.push({ text: line.slice(1), deletionLine })
      deletionLine += 1
    } else {
      rows.push({ text: line.startsWith(' ') ? line.slice(1) : line, additionLine, deletionLine })
      additionLine += 1
      deletionLine += 1
    }
  }
  return rows
}

function lineMatchesSelection(row: DiffRow, lineNumber: number, side: 'additions' | 'deletions') {
  return side === 'additions' ? row.additionLine === lineNumber : row.deletionLine === lineNumber
}
