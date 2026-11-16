import { diagramKind } from './diagramLayout'

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

type MarkdownCodeBlock =
  | { kind: 'text'; content: string }
  | { kind: 'code'; lineCount: number; diagram: boolean }

/** Splits markdown into the wrapped prose the renderer reflows and the fenced code it does not. */
export function splitMarkdownCodeBlocks(source: string): MarkdownCodeBlock[] {
  const blocks: MarkdownCodeBlock[] = []
  let prose = ''
  let openFence: { marker: string; length: number; code: string; language: string } | null = null
  for (const line of source.match(/.*(?:\n|$)/g) ?? []) {
    const trimmedLine = line.replace(/\r?\n$/, '')
    if (openFence) {
      const closing = trimmedLine.match(FENCE_CLOSE_PATTERN)?.[1]
      if (closing?.startsWith(openFence.marker) && closing.length >= openFence.length) {
        blocks.push({
          kind: 'code',
          lineCount: countLines(openFence.code),
          diagram: diagramKind(openFence.language) !== null,
        })
        openFence = null
        continue
      }
      openFence.code += line
      continue
    }
    const opening = trimmedLine.match(FENCE_OPEN_PATTERN)?.[1]
    if (opening) {
      if (prose) {
        blocks.push({ kind: 'text', content: prose })
        prose = ''
      }
      openFence = {
        marker: opening[0] ?? '`',
        length: opening.length,
        code: '',
        language:
          trimmedLine
            .slice(trimmedLine.indexOf(opening) + opening.length)
            .trim()
            .split(/\s/)[0] ?? '',
      }
      continue
    }
    prose += line
  }
  if (openFence) {
    blocks.push({
      kind: 'code',
      lineCount: countLines(openFence.code),
      diagram: diagramKind(openFence.language) !== null,
    })
  }
  if (prose) {
    blocks.push({ kind: 'text', content: prose })
  }
  return blocks
}

function countLines(text: string): number {
  const trimmed = text.replace(/\n$/, '')
  return trimmed ? trimmed.split('\n').length : 0
}
