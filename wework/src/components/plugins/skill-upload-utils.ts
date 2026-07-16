export interface SkillPackageInfo {
  name: string
  description: string
  version?: string
  author?: string
  tags: string[]
}

interface ZipEntry {
  fileName: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

interface DecompressionStreamConstructor {
  new (format: string): TransformStream<Uint8Array, Uint8Array>
}

const textDecoder = new TextDecoder()

function readUInt16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function readUInt32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - 0xffff - 22)
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (readUInt32(view, offset) === 0x06054b50) {
      return offset
    }
  }
  return -1
}

function readCentralDirectory(view: DataView): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(view)
  if (eocdOffset < 0) {
    throw new Error('ZIP central directory not found')
  }

  const entryCount = readUInt16(view, eocdOffset + 10)
  let offset = readUInt32(view, eocdOffset + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32(view, offset) !== 0x02014b50) break

    const method = readUInt16(view, offset + 10)
    const compressedSize = readUInt32(view, offset + 20)
    const fileNameLength = readUInt16(view, offset + 28)
    const extraLength = readUInt16(view, offset + 30)
    const commentLength = readUInt16(view, offset + 32)
    const localHeaderOffset = readUInt32(view, offset + 42)
    const fileNameBytes = new Uint8Array(
      view.buffer,
      view.byteOffset + offset + 46,
      fileNameLength,
    )

    entries.push({
      fileName: textDecoder.decode(fileNameBytes),
      method,
      compressedSize,
      localHeaderOffset,
    })

    offset += 46 + fileNameLength + extraLength + commentLength
  }

  return entries
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DecompressionStreamCtor = (
    globalThis as unknown as {
      DecompressionStream?: DecompressionStreamConstructor
    }
  ).DecompressionStream

  if (!DecompressionStreamCtor) {
    throw new Error('Deflate decompression is not supported')
  }

  const payload = new Uint8Array(data.byteLength)
  payload.set(data)
  const stream = new Blob([payload.buffer]).stream().pipeThrough(
    new DecompressionStreamCtor('deflate-raw'),
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function isSkillMarkdownEntry(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/').toLowerCase()
  return normalized === 'skill.md' || normalized.endsWith('/skill.md')
}

async function readSkillMarkdownText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const view = new DataView(buffer)
  const entries = readCentralDirectory(view)
  const entry = entries.find(
    (candidate) =>
      !candidate.fileName.endsWith('/') &&
      isSkillMarkdownEntry(candidate.fileName),
  )

  if (!entry) {
    throw new Error('SKILL.md not found')
  }
  if (readUInt32(view, entry.localHeaderOffset) !== 0x04034b50) {
    throw new Error('ZIP local header not found')
  }

  const fileNameLength = readUInt16(view, entry.localHeaderOffset + 26)
  const extraLength = readUInt16(view, entry.localHeaderOffset + 28)
  const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraLength
  const compressed = new Uint8Array(
    buffer,
    dataOffset,
    entry.compressedSize,
  )

  if (entry.method === 0) {
    return textDecoder.decode(compressed)
  }
  if (entry.method === 8) {
    return textDecoder.decode(await inflateRaw(compressed))
  }

  throw new Error(`Unsupported ZIP compression method ${entry.method}`)
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseScalarArray(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []

  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item))
    .filter(Boolean)
}

function parseSkillFrontmatter(markdown: string): Partial<SkillPackageInfo> {
  if (!markdown.startsWith('---')) return {}

  const endMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!endMatch) return {}

  const result: Partial<SkillPackageInfo> = {}
  const lines = endMatch[1].split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue

    const key = match[1]
    const value = match[2]

    if (key === 'description') result.description = stripQuotes(value)
    if (key === 'version') result.version = stripQuotes(value)
    if (key === 'author') result.author = stripQuotes(value)
    if (key === 'name') result.name = stripQuotes(value)
    if (key === 'tags') {
      const inlineTags = parseScalarArray(value)
      if (inlineTags.length > 0) {
        result.tags = inlineTags
        continue
      }

      const tags: string[] = []
      let cursor = index + 1
      while (cursor < lines.length && lines[cursor].trim().startsWith('-')) {
        tags.push(stripQuotes(lines[cursor].trim().replace(/^-\s*/, '')))
        cursor += 1
      }
      result.tags = tags.filter(Boolean)
      index = cursor - 1
    }
  }

  return result
}

export async function readSkillPackageInfo(
  file: File,
): Promise<SkillPackageInfo> {
  const defaultName = file.name.replace(/\.zip$/i, '').trim()
  const skillMarkdown = await readSkillMarkdownText(file)
  const frontmatter = parseSkillFrontmatter(skillMarkdown)

  return {
    name: frontmatter.name || defaultName,
    description: frontmatter.description || '',
    version: frontmatter.version,
    author: frontmatter.author,
    tags: frontmatter.tags ?? [],
  }
}
