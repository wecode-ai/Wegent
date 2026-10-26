import type { Nodes, Root } from 'mdast'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { unified } from 'unified'

export interface AssistantFileCitation {
  kind: 'file'
  path: string
  purpose: 'source' | 'output'
  lineStart?: number
  lineEnd?: number
  label?: string
  artifact?:
    | { kind: 'document'; page: number }
    | {
        kind: 'presentation'
        slide?: number
        slideId?: string
        objectId?: string
      }
    | { kind: 'workbook'; sheet: string; range?: string; objectId?: string }
}

export type AssistantAnnotation =
  | AssistantFileCitation
  | { kind: 'followup'; label: string; prompt?: string }
  | { kind: 'hidden' }

export interface AnnotationSpan {
  start: number
  end: number
  annotation: AssistantAnnotation
}

interface Directive {
  end: number
  name: string
  label?: string
  attributes: Record<string, string>
}

const markdownParser = unified().use(remarkParse).use(remarkGfm)
const literalTypes = new Set([
  'code',
  'inlineCode',
  'html',
  'link',
  'image',
  'linkReference',
  'imageReference',
  'definition',
])
const candidatePattern =
  /:+[a-zA-Z][\w-]*(?:\{|\[)|【[^\n†】]+†L|\uE200(?:cite|filecite|filenav)(?:\uE202|$)/g

export function stripUnsupportedContentReferenceCitations(content: string): string {
  return projectUnsupportedContentReferenceCitations(content).content
}

/** Retain original offsets while excluding opaque markers or all non-prose annotations. */
export function projectUnsupportedContentReferenceCitations(content: string, proseOnly = false) {
  const hasAnnotations = proseOnly
    ? /codex-file-citation|codex-followup|†L|\uE200/.test(content)
    : content.includes('\uE200')
  const spans =
    hasAnnotations
      ? collectAssistantAnnotations(content, undefined, true).filter(span =>
          span.annotation.kind === 'hidden'
            ? content[span.start] === '\uE200'
            : proseOnly
        )
      : []
  let cursor = 0
  let text = ''
  const sources: Array<{ start: number; end: number; sourceStart: number; sourceEnd: number }> = []
  const append = (end: number) => {
    if (end <= cursor) return
    const start = text.length
    text += content.slice(cursor, end)
    sources.push({ start, end: text.length, sourceStart: cursor, sourceEnd: end })
  }
  for (const span of spans) {
    append(span.start)
    cursor = span.end
  }
  append(content.length)
  return { content: text, sources }
}

export function collectAssistantAnnotations(
  source: string,
  tree: Root = markdownParser.parse(source),
  isStreaming = false
): AnnotationSpan[] {
  const protectedRanges: { start: number; end: number }[] = []
  const visit = (node: Nodes) => {
    if (literalTypes.has(node.type) && node.position) {
      protectedRanges.push({
        start: node.position.start.offset!,
        end: node.position.end.offset!,
      })
    } else if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
  protectedRanges.sort((a, b) => a.start - b.start)
  const spans: AnnotationSpan[] = []
  let protectedIndex = 0
  let consumed = 0
  // Directives are single-line. Bound malformed scans per line without letting
  // an invalid paragraph exhaust the budget for later valid references.
  const budgets = [0, 0]
  let budgetLineEnd = -1
  for (const match of source.matchAll(candidatePattern)) {
    const start = match.index
    if (start < consumed) continue
    while (protectedRanges[protectedIndex]?.end <= start) protectedIndex++
    if (protectedRanges[protectedIndex]?.start <= start) continue
    let escapes = 0
    for (let i = start - 1; source[i] === '\\'; i--) escapes++
    if (escapes % 2) continue
    if (source[start] === '\uE200') {
      const end = source.indexOf('\uE201', start)
      if (end >= 0 || isStreaming) {
        consumed = end < 0 ? source.length : end + 1
        spans.push({ start, end: consumed, annotation: { kind: 'hidden' } })
      }
      continue
    }
    if (source[start] === '【') {
      const legacy = parseLegacyCitation(source.slice(start))
      if (legacy) {
        consumed = start + legacy.length
        spans.push({ start, end: consumed, annotation: legacy.citation })
      }
      continue
    }
    if (start >= budgetLineEnd) {
      const newline = source.indexOf('\n', start)
      budgetLineEnd = newline < 0 ? source.length : newline
      budgets.fill((budgetLineEnd - start) * 4)
    }
    const name = match[0].replace(/^:+/, '').slice(0, -1)
    const preferEscapes = name !== 'codex-file-citation'
    const directive =
      parseDirective(source, start, preferEscapes, budgets, 0) ??
      parseDirective(source, start, !preferEscapes, budgets, 1)
    if (directive) {
      // Unknown outer directives own their contents, including any nested markers.
      consumed = directive.end
      const annotation = interpretDirective(directive)
      if (annotation) spans.push({ start, end: consumed, annotation })
    } else if (
      isStreaming &&
      ['codex-file-citation', 'codex-followup'].includes(name) &&
      !source.slice(start).includes('\n') &&
      !source.slice(start).includes('}')
    ) {
      spans.push({ start, end: source.length, annotation: { kind: 'hidden' } })
      break
    }
  }
  return spans
}

export function extractAssistantFileCitations(source: string): AssistantFileCitation[] {
  if (!/codex-file-citation|†L/.test(source)) return []
  return collectAssistantAnnotations(source).flatMap(({ annotation }) =>
    annotation.kind === 'file' ? [annotation] : []
  )
}

function parseDirective(
  source: string,
  start: number,
  escapedQuotes: boolean,
  budgets: number[],
  mode: number
): Directive | null {
  let cursor = start
  const step = () => --budgets[mode] >= 0
  const space = () => {
    while ((source[cursor] === ' ' || source[cursor] === '\t') && step()) cursor++
  }
  while (source[cursor] === ':' && step()) cursor++
  if (cursor - start > 3) return null
  const nameStart = cursor
  while (/[\w-]/.test(source[cursor] ?? '') && step()) cursor++
  const name = source.slice(nameStart, cursor)
  let label: string | undefined
  if (source[cursor] === '[') {
    if (name !== 'codex-followup') return null
    const labelStart = ++cursor
    let depth = 1
    let codeTicks = 0
    let codeStart = -1
    while (step()) {
      if (cursor >= source.length || /[\r\n]/.test(source[cursor])) {
        if (codeStart < 0) return null
        // An unmatched backtick is literal Markdown; replay its contents.
        cursor = codeStart
        codeStart = -1
        codeTicks = 0
      }
      const character = source[cursor++]
      if (character === '`') {
        let ticks = 1
        while (source[cursor] === '`' && step()) {
          ticks++
          cursor++
        }
        if (codeTicks === 0) {
          codeTicks = ticks
          codeStart = cursor
        } else if (codeTicks === ticks) {
          codeTicks = 0
          codeStart = -1
        }
        continue
      }
      if (codeTicks > 0) continue
      if (character === '\\') cursor++
      else if (character === '[') depth++
      else if (character === ']' && --depth === 0) break
    }
    if (depth !== 0) return null
    label = source.slice(labelStart, cursor - 1)
  }
  if (source[cursor++] !== '{') return null
  const attributes: Record<string, string> = Object.create(null)
  while (cursor < source.length && step()) {
    space()
    if (source[cursor] === '}') return { end: cursor + 1, name, label, attributes }
    const keyStart = cursor
    while (/[\w-]/.test(source[cursor] ?? '') && step()) cursor++
    const key = source.slice(keyStart, cursor)
    if (!key || Object.hasOwn(attributes, key)) return null
    space()
    if (source[cursor++] !== '=') return null
    space()
    const quote = source[cursor]
    const quoted = quote === '"' || quote === "'"
    if (quoted) cursor++
    let value = ''
    let closed = !quoted
    while (cursor < source.length && step()) {
      const character = source[cursor]
      if (character === '\n' || character === '\r') return null
      if (quoted && character === quote) {
        cursor++
        closed = true
        break
      }
      if (!quoted && /[\s}]/.test(character)) break
      if (quoted && escapedQuotes && character === '\\' && source[cursor + 1] === quote) cursor++
      value += source[cursor++]
    }
    if (!closed || (!quoted && !value)) return null
    attributes[key] = value
  }
  return null
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function citationPath(value: string | undefined): string | undefined {
  // Reject control characters in file paths deliberately.
  // eslint-disable-next-line no-control-regex
  if (!value?.trim() || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  let path = value.trim()
  if (/^file:\/\//i.test(path)) {
    // Directive paths are literal, including %, #, ? and colon suffixes.
    path = path.replace(/^file:\/\/(?:localhost(?=\/))?/i, '')
    if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1)
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return undefined
  return path
}

function interpretDirective({ name, label, attributes: a }: Directive): AssistantAnnotation | null {
  if (name === 'codex-followup' && label?.trim()) {
    return { kind: 'followup', label, prompt: a.prompt?.trim() || undefined }
  }
  if (name !== 'codex-file-citation') return null
  const path = citationPath(a.path)
  if (!path || (a.purpose && !['source', 'output'].includes(a.purpose))) return null
  const lineStart = positiveInteger(a.lineRangeStart ?? a.line_range_start)
  const lineEnd = positiveInteger(a.lineRangeEnd ?? a.line_range_end)
  const citation: AssistantFileCitation = {
    kind: 'file',
    path,
    purpose: a.purpose === 'source' ? 'source' : 'output',
    lineStart,
    lineEnd: lineStart && lineEnd && lineEnd >= lineStart ? lineEnd : undefined,
    label: a.label?.trim() || undefined,
  }
  const page = positiveInteger(a.page_number)
  const slide = positiveInteger(a.slide_number)
  if (a.artifact_kind === 'document' && page) citation.artifact = { kind: 'document', page }
  if (a.artifact_kind === 'presentation' && (slide || a.slide_id?.trim())) {
    citation.artifact = {
      kind: 'presentation',
      slide,
      slideId: a.slide_id,
      objectId: a.object_id,
    }
  }
  if (
    a.artifact_kind === 'workbook' &&
    a.sheet?.trim() &&
    (a.range?.trim() || a.object_id?.trim())
  ) {
    citation.artifact = {
      kind: 'workbook',
      sheet: a.sheet,
      range: a.range,
      objectId: a.object_id,
    }
  }
  return citation
}

function parseLegacyCitation(
  source: string
): { length: number; citation: AssistantFileCitation } | null {
  const match = /^【([^†】\n]+)†L(\d+)(?:-L(\d+))?】/.exec(source)
  if (!match) return null
  const explicit = match[1].startsWith('F:')
  let path = match[1].slice(explicit ? 2 : 0).trim()
  try {
    path = decodeURI(path)
  } catch {
    /* Preserve malformed URI escapes as literal paths. */
  }
  if (!explicit && !/^(?:\/|[a-z]:[\\/]|file:\/\/)/i.test(path)) return null
  const citation = interpretDirective({
    name: 'codex-file-citation',
    end: match[0].length,
    attributes: {
      path,
      purpose: 'source',
      line_range_start: match[2],
      line_range_end: match[3] ?? '',
    },
  })
  return citation?.kind === 'file' ? { length: match[0].length, citation } : null
}
