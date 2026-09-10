import type {
  WeworkConversationAttachment,
  WeworkConversationItem,
  WeworkConversationSnapshot,
  WeworkPluginBackendClient,
} from '../../app-wework/client'

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g
const REMOTE_IMAGE_TIMEOUT_MS = 15_000
const REMOTE_IMAGE_MAX_BYTES = 50 * 1024 * 1024
const IMAGE_MIME_TYPES_BY_EXTENSION = new Map([
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
])

export interface ConversationExportSelection {
  readonly body: boolean
  readonly tools: boolean
  readonly thinking: boolean
  readonly images: boolean
  readonly attachments: boolean
}

export interface ConversationExportCounts {
  readonly body: number
  readonly tools: number
  readonly thinking: number
  readonly images: number
  readonly attachments: number
}

export type ConversationExportAsset =
  | {
      readonly archivePath: string
      readonly kind: 'local'
      readonly path: string
      readonly workspacePath: string | null
    }
  | {
      readonly archivePath: string
      readonly kind: 'base64'
      readonly contentBase64: string
    }
  | {
      readonly archivePath: string
      readonly kind: 'remote'
      readonly url: string
      readonly label: string
    }

export interface PreparedConversationExport {
  readonly snapshot: WeworkConversationSnapshot
  readonly assets: readonly ConversationExportAsset[]
}

type PreparedAttachment = WeworkConversationAttachment & {
  readonly dataUrl?: string | null
  readonly exportPath?: string | null
}

export function defaultConversationExportSelection(
  format: 'markdown' | 'html'
): ConversationExportSelection {
  return {
    body: true,
    tools: false,
    thinking: false,
    images: format === 'html',
    attachments: false,
  }
}

export function countConversationExportContent(
  snapshot: WeworkConversationSnapshot
): ConversationExportCounts {
  const counts = { body: 0, tools: 0, thinking: 0, images: 0, attachments: 0 }
  for (const turn of snapshot.turns) {
    for (const item of turn.items) {
      if (item.type === 'user_message') {
        if (item.content.trim()) counts.body += 1
        counts.images += countMarkdownImages(item.content)
        for (const attachment of item.attachments) {
          if (isImageAttachment(attachment)) counts.images += 1
          else counts.attachments += 1
        }
      } else if (item.type === 'assistant_text') {
        if (item.content.trim()) counts.body += 1
        counts.images += countMarkdownImages(item.content)
      } else if (item.block.type === 'tool' || item.block.type === 'file_changes') {
        counts.tools += 1
      } else if (item.block.type === 'thinking') {
        if (item.block.content.trim()) counts.thinking += 1
        counts.images += countMarkdownImages(item.block.content)
      } else {
        if (item.block.content.trim()) counts.body += 1
        counts.images += countMarkdownImages(item.block.content)
      }
    }
  }
  return counts
}

export async function prepareConversationExport(
  snapshot: WeworkConversationSnapshot,
  format: 'markdown' | 'html',
  selection: ConversationExportSelection,
  backend: WeworkPluginBackendClient
): Promise<PreparedConversationExport> {
  const assets: ConversationExportAsset[] = []
  const reservedPaths = new Set<string>()
  const imageCache = new Map<string, Promise<string>>()
  const prepareMarkdown = (content: string) =>
    prepareMarkdownImages({
      assets,
      backend,
      content,
      format,
      imageCache,
      includeImages: selection.images,
      reservedPaths,
      workspacePath: snapshot.reference.workspacePath ?? null,
    })

  const turns = await Promise.all(
    snapshot.turns.map(async turn => ({
      ...turn,
      items: (
        await Promise.all(
          turn.items.map(item =>
            prepareItem(item, format, selection, prepareMarkdown, {
              assets,
              backend,
              imageCache,
              reservedPaths,
              workspacePath: snapshot.reference.workspacePath ?? null,
            })
          )
        )
      ).filter((item): item is WeworkConversationItem => item !== null),
    }))
  )

  return {
    snapshot: { ...snapshot, turns },
    assets,
  }
}

async function prepareItem(
  item: WeworkConversationItem,
  format: 'markdown' | 'html',
  selection: ConversationExportSelection,
  prepareMarkdown: (content: string) => Promise<string>,
  context: {
    assets: ConversationExportAsset[]
    backend: WeworkPluginBackendClient
    imageCache: Map<string, Promise<string>>
    reservedPaths: Set<string>
    workspacePath: string | null
  }
): Promise<WeworkConversationItem | null> {
  if (item.type === 'assistant_text') {
    return selection.body ? { ...item, content: await prepareMarkdown(item.content) } : null
  }
  if (item.type === 'block') {
    if (item.block.type === 'tool' || item.block.type === 'file_changes') {
      return selection.tools ? item : null
    }
    if (item.block.type === 'thinking' && !selection.thinking) return null
    if (item.block.type !== 'thinking' && !selection.body) return null
    return {
      ...item,
      block: {
        ...item.block,
        content: await prepareMarkdown(item.block.content),
      },
    }
  }

  const attachments = (
    await Promise.all(
      item.attachments.map(attachment => prepareAttachment(attachment, format, selection, context))
    )
  ).filter((attachment): attachment is PreparedAttachment => attachment !== null)
  const content = selection.body ? await prepareMarkdown(item.content) : ''
  if (!content.trim() && attachments.length === 0) return null
  return { ...item, content, attachments }
}

async function prepareAttachment(
  attachment: WeworkConversationAttachment,
  format: 'markdown' | 'html',
  selection: ConversationExportSelection,
  context: {
    assets: ConversationExportAsset[]
    backend: WeworkPluginBackendClient
    imageCache: Map<string, Promise<string>>
    reservedPaths: Set<string>
    workspacePath: string | null
  }
): Promise<PreparedAttachment | null> {
  const image = isImageAttachment(attachment)
  if (image && !selection.images) return null
  if (!image && !selection.attachments) return null

  if (image && format === 'html') {
    return {
      ...attachment,
      dataUrl: await attachmentDataUrl(attachment, context.backend, context.imageCache),
    }
  }

  const archivePath = reserveArchivePath(
    image ? 'images' : 'attachments',
    attachment.filename,
    context.reservedPaths
  )
  context.assets.push(await attachmentAsset(attachment, archivePath, context.workspacePath))
  return { ...attachment, exportPath: archivePath }
}

async function prepareMarkdownImages(options: {
  assets: ConversationExportAsset[]
  backend: WeworkPluginBackendClient
  content: string
  format: 'markdown' | 'html'
  imageCache: Map<string, Promise<string>>
  includeImages: boolean
  reservedPaths: Set<string>
  workspacePath: string | null
}): Promise<string> {
  const matches = [...options.content.matchAll(MARKDOWN_IMAGE_PATTERN)]
  if (matches.length === 0) return options.content

  const replacements = await Promise.all(
    matches.map(async match => {
      if (!options.includeImages) return match[1]
      const { destination, titleSuffix } = splitMarkdownImageDestination(match[2])
      const mimeType = imageMimeTypeFromSource(destination)
      if (!mimeType) return match[0]
      if (options.format === 'html') {
        const dataUrl = await sourceDataUrl(
          destination,
          mimeType,
          options.workspacePath,
          options.backend,
          options.imageCache
        )
        return `![${match[1]}](${dataUrl}${titleSuffix})`
      }

      const archivePath = reserveArchivePath(
        'images',
        imageFilename(destination, match[1], mimeType),
        options.reservedPaths
      )
      options.assets.push(
        await sourceAsset(destination, archivePath, options.workspacePath, mimeType)
      )
      return `![${match[1]}](<${archivePath}>${titleSuffix})`
    })
  )

  let output = ''
  let offset = 0
  matches.forEach((match, index) => {
    output += options.content.slice(offset, match.index) + replacements[index]
    offset = (match.index ?? 0) + match[0].length
  })
  return output + options.content.slice(offset)
}

async function attachmentAsset(
  attachment: WeworkConversationAttachment,
  archivePath: string,
  workspacePath: string | null
): Promise<ConversationExportAsset> {
  const localPath = attachment.localPath?.trim()
  if (localPath) {
    return { archivePath, kind: 'local', path: localPath, workspacePath }
  }
  const previewUrl = attachment.previewUrl?.trim()
  if (previewUrl) {
    if (previewUrl.startsWith('data:')) {
      return {
        archivePath,
        kind: 'base64',
        contentBase64: dataUrlBase64(previewUrl, attachment.mimeType),
      }
    }
    return { archivePath, kind: 'remote', url: previewUrl, label: attachment.filename }
  }
  throw new Error(`Unable to include attachment ${attachment.filename} in the export`)
}

async function sourceAsset(
  source: string,
  archivePath: string,
  workspacePath: string | null,
  mimeType: string
): Promise<ConversationExportAsset> {
  const localPath = localImagePath(source)
  if (localPath) return { archivePath, kind: 'local', path: localPath, workspacePath }
  if (source.startsWith('data:')) {
    return { archivePath, kind: 'base64', contentBase64: dataUrlBase64(source, mimeType) }
  }
  return { archivePath, kind: 'remote', url: source, label: archivePath }
}

async function attachmentDataUrl(
  attachment: WeworkConversationAttachment,
  backend: WeworkPluginBackendClient,
  imageCache: Map<string, Promise<string>>
): Promise<string> {
  const mimeType = normalizedImageMimeType(attachment.mimeType)
  const localPath = attachment.localPath?.trim()
  if (localPath) return cachedLocalDataUrl(localPath, mimeType, null, backend, imageCache)
  const previewUrl = attachment.previewUrl?.trim()
  if (previewUrl) {
    if (previewUrl.startsWith(`data:${mimeType};base64,`)) return previewUrl
    return `data:${mimeType};base64,${await fetchBase64(previewUrl, attachment.filename)}`
  }
  throw new Error(`Unable to include image ${attachment.filename} in the HTML export`)
}

async function sourceDataUrl(
  source: string,
  mimeType: string,
  workspacePath: string | null,
  backend: WeworkPluginBackendClient,
  imageCache: Map<string, Promise<string>>
): Promise<string> {
  if (source.startsWith(`data:${mimeType};base64,`)) return source
  const localPath = localImagePath(source)
  if (localPath) return cachedLocalDataUrl(localPath, mimeType, workspacePath, backend, imageCache)
  return `data:${mimeType};base64,${await fetchBase64(source, source)}`
}

function cachedLocalDataUrl(
  path: string,
  mimeType: string,
  workspacePath: string | null,
  backend: WeworkPluginBackendClient,
  imageCache: Map<string, Promise<string>>
): Promise<string> {
  const key = `${workspacePath ?? ''}:${path}`
  const cached = imageCache.get(key)
  if (cached) return cached
  const dataUrl = readLocalImageBase64(path, mimeType, workspacePath, backend).then(
    base64 => `data:${mimeType};base64,${base64}`
  )
  imageCache.set(key, dataUrl)
  return dataUrl
}

async function readLocalImageBase64(
  path: string,
  mimeType: string,
  workspacePath: string | null,
  backend: WeworkPluginBackendClient
): Promise<string> {
  const chunks: string[] = []
  let offset = 0
  let expectedSize: number | null = null
  while (expectedSize === null || offset < expectedSize) {
    const chunk = await backend.request<{
      chunkBase64: string
      bytesRead: number
      eof: boolean
      size: number
    }>('readImageChunk', { path, offset, workspacePath, mimeType })
    if (
      !Number.isSafeInteger(chunk.bytesRead) ||
      chunk.bytesRead < 0 ||
      !Number.isSafeInteger(chunk.size) ||
      chunk.size < 0 ||
      offset + chunk.bytesRead > chunk.size ||
      (chunk.bytesRead === 0 && !chunk.eof)
    ) {
      throw new Error('Conversation export received an invalid image chunk')
    }
    if (expectedSize !== null && chunk.size !== expectedSize) {
      throw new Error('Image changed while the conversation export was reading it')
    }
    if (!chunk.eof && chunk.bytesRead % 3 !== 0) {
      throw new Error('Conversation export received a misaligned image chunk')
    }
    expectedSize = chunk.size
    chunks.push(chunk.chunkBase64)
    offset += chunk.bytesRead
    if (chunk.eof) break
  }
  if (expectedSize === null || offset !== expectedSize) {
    throw new Error('Conversation export could not read the complete image')
  }
  return chunks.join('')
}

async function fetchBase64(source: string, label: string): Promise<string> {
  const response = await fetch(source, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Unable to read ${label}: HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > REMOTE_IMAGE_MAX_BYTES) {
    throw new Error(`Unable to read ${label}: the image exceeds 50 MB`)
  }
  const bytes = await readResponseBytes(response, REMOTE_IMAGE_MAX_BYTES, label)
  return encodeBase64(bytes)
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`Unable to read ${label}: file is too large`)
    return bytes
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error(`Unable to read ${label}: file is too large`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function dataUrlBase64(source: string, expectedMimeType: string): string {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(source)
  if (!match || match[1].trim().toLowerCase() !== expectedMimeType.trim().toLowerCase()) {
    throw new Error('Conversation export data URL is invalid')
  }
  return match[2]
}

function isImageAttachment(attachment: WeworkConversationAttachment): boolean {
  return attachment.mimeType.trim().toLowerCase().startsWith('image/')
}

function normalizedImageMimeType(value: string): string {
  const mimeType = value.trim().toLowerCase()
  return mimeType.startsWith('image/') ? mimeType : 'image/png'
}

function imageMimeTypeFromSource(value: string): string | null {
  if (value.startsWith('data:')) {
    const match = /^data:([^;,]+)/i.exec(value)
    return match?.[1]?.startsWith('image/') ? match[1].toLowerCase() : null
  }
  const pathname = value.split(/[?#]/, 1)[0]
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1].toLowerCase()
  return extension ? (IMAGE_MIME_TYPES_BY_EXTENSION.get(extension) ?? null) : null
}

function imageFilename(source: string, alt: string, mimeType: string): string {
  const pathname = source.split(/[?#]/, 1)[0]
  const sourceName = pathname.split(/[\\/]/).at(-1)
  if (sourceName && sourceName.includes('.')) return decodePath(sourceName)
  const extension =
    [...IMAGE_MIME_TYPES_BY_EXTENSION].find(([, value]) => value === mimeType)?.[0] ?? 'png'
  return `${alt.trim() || 'image'}.${extension}`
}

function reserveArchivePath(directory: string, filename: string, reserved: Set<string>): string {
  const printableFilename = Array.from(filename, character =>
    character.charCodeAt(0) <= 31 ? '-' : character
  ).join('')
  const safeName =
    printableFilename
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/[. ]+$/g, '')
      .trim() || 'file'
  const extensionIndex = safeName.lastIndexOf('.')
  const stem = extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName
  const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : ''
  let index = 1
  let candidate = `${directory}/${safeName}`
  while (reserved.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${directory}/${stem}-${index}${extension}`
  }
  reserved.add(candidate.toLowerCase())
  return candidate
}

function countMarkdownImages(content: string): number {
  return [...content.matchAll(MARKDOWN_IMAGE_PATTERN)].length
}

function splitMarkdownImageDestination(rawHref: string): {
  destination: string
  titleSuffix: string
} {
  const href = rawHref.trim()
  if (href.startsWith('<')) {
    const closingBracket = href.indexOf('>')
    if (closingBracket > 0) {
      return {
        destination: href.slice(1, closingBracket),
        titleSuffix: href.slice(closingBracket + 1),
      }
    }
  }
  const titledDestination = href.match(/^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/)
  return titledDestination
    ? {
        destination: titledDestination[1].trim(),
        titleSuffix: titledDestination[2],
      }
    : { destination: href, titleSuffix: '' }
}

function localImagePath(value: string): string | null {
  if (
    /^(?:blob:|data:|https?:)/i.test(value) ||
    /^\/(?:api\/)?attachments\/\d+\/download(?:[?#].*)?$/i.test(value)
  ) {
    return null
  }
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith('/')) return decodePath(value)
  if (value.startsWith('file://')) {
    try {
      const pathname = decodeURIComponent(new URL(value).pathname)
      return pathname.match(/^\/[a-z]:\//i) ? pathname.slice(1) : pathname
    } catch {
      return value
    }
  }
  return decodePath(value)
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024)))
  }
  return btoa(chunks.join(''))
}
