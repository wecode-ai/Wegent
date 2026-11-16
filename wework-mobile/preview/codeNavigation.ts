import type {
  CodeViewItem,
  CodeViewScrollTarget,
  FileDiffMetadata,
  SelectionSide,
} from '@pierre/diffs'
import type { PreviewState } from './protocol'

function sameFile(path: string, name: string): boolean {
  const normalize = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '')
  const normalizedPath = normalize(path)
  const normalizedName = normalize(name)
  return normalizedPath === normalizedName || normalizedPath.endsWith(`/${normalizedName}`)
}

export function createCodeItems(
  state: PreviewState,
  parse: (patch: string) => { files: FileDiffMetadata[] }[]
): CodeViewItem<undefined>[] {
  const text = state.text ?? ''
  if (state.kind !== 'diff' || state.mode === 'source')
    return [
      {
        id: state.path,
        type: 'file',
        file: {
          name: state.kind === 'diff' ? `${state.name}.diff` : state.name,
          contents: text,
          cacheKey: state.url,
        },
      },
    ]
  const files = parse(text).flatMap(patch => patch.files)
  const matched = files.filter(
    file =>
      sameFile(state.path, file.name) ||
      Boolean(file.prevName && sameFile(state.path, file.prevName))
  )
  return (state.path ? matched : files).map((fileDiff, i) => ({
    id: `${state.path}:${i}`,
    type: 'diff',
    fileDiff,
  }))
}

export function initialCodeTarget(
  items: CodeViewItem<undefined>[],
  lineStart: number | undefined,
  position: number
): CodeViewScrollTarget {
  return lineStart && items[0]
    ? { type: 'line', id: items[0].id, lineNumber: lineStart, align: 'center', behavior: 'instant' }
    : { type: 'position', position, behavior: 'instant' }
}

export function findCodeMatch(
  items: CodeViewItem<undefined>[],
  query: string
):
  | {
      id: string
      lineNumber: number
      side?: SelectionSide
    }
  | undefined {
  if (!query) return undefined
  const includes = (line: string) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  for (const item of items) {
    if (item.type === 'file') {
      const index = item.file.contents.split('\n').findIndex(includes)
      if (index >= 0) return { id: item.id, lineNumber: index + 1 }
      continue
    }
    const diff = item.fileDiff
    for (const hunk of diff.hunks) {
      for (const side of ['additions', 'deletions'] as const) {
        const addition = side === 'additions'
        const lines = addition ? diff.additionLines : diff.deletionLines
        const start = addition ? hunk.additionLineIndex : hunk.deletionLineIndex
        const count = addition ? hunk.additionCount : hunk.deletionCount
        const lineStart = addition ? hunk.additionStart : hunk.deletionStart
        const index = lines.slice(start, start + count).findIndex(includes)
        if (index >= 0) return { id: item.id, lineNumber: lineStart + index, side }
      }
    }
  }
  return undefined
}
