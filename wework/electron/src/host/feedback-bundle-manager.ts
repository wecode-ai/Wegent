import { ZipArchive } from 'archiver'
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

const MAX_LOG_BYTES = 200 * 1024 * 1024
const MAX_ENTRY_PREVIEW_CHARS = 20_000
const MAX_ATTACHMENT_COUNT = 20
const MAX_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_COMPOSER_DIAGNOSTICS_BYTES = 256 * 1024

interface FeedbackAttachment {
  name: string
  mimeType: string
  dataBase64: string
}

export interface FeedbackExportRequest {
  includeRuntimeLogs: boolean
  includeTaskInfo: boolean
  includeScreenshot: boolean
  includeSystemInfo: boolean
  note: string
  taskContext: unknown | null
  screenshotDataUrl: string | null
  composerDiagnostics: unknown | null
  attachments: FeedbackAttachment[]
}

interface PendingEntry {
  archivePath: string
  data: Buffer
  previewable: boolean
}

interface PendingBundle {
  reportId: string
  createdAtUnixMs: number
  entries: PendingEntry[]
  warnings: string[]
  included: string[]
  skipped: string[]
  logFiles: Array<{ archivePath: string; sourceBytes: number }>
}

export interface FeedbackEntryPreview {
  category: string
  archivePath: string
  sizeBytes: number
  previewable: boolean
  content: string | null
  truncated: boolean
}

export interface FeedbackPreviewResult {
  stagingId: string
  reportId: string
  entries: FeedbackEntryPreview[]
  skipped: string[]
  warnings: string[]
  finalFileName: string
}

interface StagedBundle {
  path: string
  reportId: string
}

export class FeedbackBundleManager {
  private readonly staged = new Map<string, StagedBundle>()

  constructor(
    private readonly options: {
      appVersion: () => string
      cacheDirectory: string
      downloadsDirectory: string
      logDirectories: string[]
    }
  ) {}

  async preview(request: FeedbackExportRequest): Promise<FeedbackPreviewResult> {
    const bundle = await this.buildBundle(request)
    const stagingId = `${Date.now().toString(16)}-${process.pid.toString(16)}-${randomToken()}`
    const stagingDirectory = join(this.options.cacheDirectory, 'feedback-staging')
    const stagingPath = join(stagingDirectory, `${stagingId}.zip`)
    await mkdir(stagingDirectory, { recursive: true })
    await writeBundleArchive(bundle, stagingPath)
    this.staged.set(stagingId, { path: stagingPath, reportId: bundle.reportId })
    return {
      stagingId,
      reportId: bundle.reportId,
      entries: bundle.entries.map(previewEntry),
      skipped: bundle.skipped,
      warnings: bundle.warnings,
      finalFileName: `wework-feedback-${bundle.reportId}.zip`,
    }
  }

  async confirm(stagingIdInput: string): Promise<{ reportId: string; path: string }> {
    const { stagingId, staged } = await this.resolveStaged(stagingIdInput)
    await mkdir(this.options.downloadsDirectory, { recursive: true })
    const destination = join(
      this.options.downloadsDirectory,
      `wework-feedback-${staged.reportId}.zip`
    )
    try {
      await rename(staged.path, destination)
    } catch (moveError) {
      try {
        await copyFile(staged.path, destination)
        await rm(staged.path)
      } catch (copyError) {
        throw new Error(`Failed to save the feedback bundle after move failed: ${moveError}`, {
          cause: copyError,
        })
      }
    }
    this.staged.delete(stagingId)
    return { reportId: staged.reportId, path: destination }
  }

  async discard(stagingIdInput: string): Promise<void> {
    const stagingId = validateStagingId(stagingIdInput)
    const staged = this.staged.get(stagingId)
    this.staged.delete(stagingId)
    const path =
      staged?.path ?? join(this.options.cacheDirectory, 'feedback-staging', `${stagingId}.zip`)
    await rm(path, { force: true }).catch(error => {
      throw new Error(`Failed to discard the feedback bundle: ${error}`)
    })
  }

  private async resolveStaged(stagingIdInput: string): Promise<{
    stagingId: string
    staged: StagedBundle
  }> {
    const stagingId = validateStagingId(stagingIdInput)
    const staged = this.staged.get(stagingId)
    if (!staged || !(await stat(staged.path).catch(() => null))?.isFile()) {
      throw new Error('The prepared feedback bundle expired; export again')
    }
    return { stagingId, staged }
  }

  private async buildBundle(request: FeedbackExportRequest): Promise<PendingBundle> {
    validateRequest(request)
    const createdAtUnixMs = Date.now()
    const reportId = `WF-${createdAtUnixMs.toString(16).toUpperCase()}`
    const included: string[] = []
    const skipped: string[] = []
    const warnings: string[] = []
    const logFiles: Array<{ archivePath: string; sourceBytes: number }> = []
    const entries: PendingEntry[] = [
      textEntry(
        'report.md',
        `# Wework feedback\n\n- Report ID: ${reportId}\n- Created: ${createdAtUnixMs}\n\n## Additional information\n\n${request.note.trim()}\n`
      ),
      textEntry(
        'redaction-report.json',
        JSON.stringify(
          { applied: true, rules: ['authorization', 'credentials', 'urlUserInfo'] },
          null,
          2
        )
      ),
    ]

    if (request.includeRuntimeLogs) {
      const entryCount = entries.length
      await this.collectLogs(entries, logFiles, warnings)
      if (request.composerDiagnostics != null) {
        const content = JSON.stringify(redactJson(request.composerDiagnostics), null, 2)
        if (Buffer.byteLength(content) <= MAX_COMPOSER_DIAGNOSTICS_BYTES) {
          entries.push(textEntry('logs/webview/composer-diagnostics.json', content))
        } else {
          warnings.push('Composer diagnostics exceeded 256 KB and were skipped')
        }
      }
      if (entries.length === entryCount) skipped.push('runtimeLogs')
      else included.push('runtimeLogs')
    }

    if (request.includeTaskInfo) {
      if (emptyValue(request.taskContext)) {
        skipped.push('taskInfo')
      } else {
        entries.push(
          textEntry('context/task.json', JSON.stringify(redactJson(request.taskContext), null, 2))
        )
        included.push('taskInfo')
      }
    }

    if (request.includeSystemInfo) {
      entries.push(
        textEntry(
          'environment.json',
          JSON.stringify(
            {
              weworkVersion: this.options.appVersion(),
              os: process.platform,
              architecture: process.arch,
              debugBuild: !process.defaultApp,
            },
            null,
            2
          )
        )
      )
      included.push('systemInfo')
    }

    if (request.includeScreenshot) {
      const screenshot = decodeDataUrl(request.screenshotDataUrl)
      if (screenshot?.length) {
        entries.push({ archivePath: 'screenshot.png', data: screenshot, previewable: false })
        included.push('screenshot')
      } else {
        skipped.push('screenshot')
      }
    }

    if (request.attachments.length > 0) {
      let totalBytes = 0
      request.attachments.forEach((attachment, index) => {
        const estimatedBytes = Math.floor((attachment.dataBase64.length * 3) / 4)
        if (totalBytes + estimatedBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
          throw new Error('Feedback attachments are larger than 100 MB')
        }
        const data = decodeBase64(attachment.dataBase64, attachment.name)
        totalBytes += data.length
        if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
          throw new Error('Feedback attachments are larger than 100 MB')
        }
        entries.push({
          archivePath: `attachments/${sanitizeAttachmentName(attachment.name, index)}`,
          data,
          previewable: isPreviewableAttachment(attachment.mimeType),
        })
      })
      included.push('attachments')
    }

    return {
      reportId,
      createdAtUnixMs,
      entries,
      warnings,
      included,
      skipped,
      logFiles,
    }
  }

  private async collectLogs(
    entries: PendingEntry[],
    logFiles: Array<{ archivePath: string; sourceBytes: number }>,
    warnings: string[]
  ): Promise<void> {
    const seen = new Set<string>()
    const archivePaths = new Set<string>()
    for (const directory of this.options.logDirectories) {
      const directoryEntries = await readdir(directory, { withFileTypes: true }).catch(error => {
        warnings.push(`Could not read ${directory}: ${error}`)
        return []
      })
      for (const entry of directoryEntries) {
        if (!entry.isFile() || extname(entry.name) !== '.log') continue
        const path = join(directory, entry.name)
        if (seen.has(path)) continue
        seen.add(path)
        const metadata = await stat(path).catch(error => {
          warnings.push(`Could not inspect ${path}: ${error}`)
          return null
        })
        if (!metadata) continue
        if (metadata.size > MAX_LOG_BYTES) {
          throw new Error(
            `Log file ${path} is larger than 200 MB; remove old logs or export it separately`
          )
        }
        const content = await readFile(path, 'utf8').catch(error => {
          warnings.push(`Could not read ${path}: ${error}`)
          return null
        })
        if (content == null) continue
        const archivePath = reserveLogArchivePath(entry.name, archivePaths)
        entries.push(textEntry(archivePath, redact(content)))
        logFiles.push({ archivePath, sourceBytes: metadata.size })
      }
    }
  }
}

async function writeBundleArchive(bundle: PendingBundle, destination: string): Promise<void> {
  const incomplete = `${destination}.incomplete`
  await rm(incomplete, { force: true })
  const output = createWriteStream(incomplete, { flags: 'wx' })
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const completed = new Promise<void>((resolveArchive, rejectArchive) => {
    output.once('close', resolveArchive)
    output.once('error', rejectArchive)
    archive.once('error', rejectArchive)
  })
  archive.pipe(output)
  for (const entry of bundle.entries) archive.append(entry.data, { name: entry.archivePath })
  archive.append(
    JSON.stringify(
      {
        schemaVersion: 1,
        reportId: bundle.reportId,
        createdAtUnixMs: bundle.createdAtUnixMs,
        included: bundle.included,
        skipped: bundle.skipped,
        logFiles: bundle.logFiles,
        warnings: bundle.warnings,
      },
      null,
      2
    ),
    { name: 'manifest.json' }
  )
  try {
    await archive.finalize()
    await completed
    await rename(incomplete, destination)
  } catch (error) {
    archive.abort()
    output.destroy()
    await rm(incomplete, { force: true })
    throw new Error('Failed to create feedback bundle', { cause: error })
  }
}

function validateRequest(request: FeedbackExportRequest): void {
  if (!request || typeof request !== 'object') throw new Error('Feedback request is required')
  if (!Array.isArray(request.attachments)) throw new Error('Feedback attachments are invalid')
  if (request.attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Feedback supports at most ${MAX_ATTACHMENT_COUNT} attachments`)
  }
}

function previewEntry(entry: PendingEntry): FeedbackEntryPreview {
  const text = entry.previewable ? entry.data.toString('utf8') : null
  const characters = text ? [...text] : []
  const truncated = characters.length > MAX_ENTRY_PREVIEW_CHARS
  return {
    category: categorizeEntry(entry.archivePath),
    archivePath: entry.archivePath,
    sizeBytes: entry.data.length,
    previewable: entry.previewable,
    content: text == null ? null : characters.slice(0, MAX_ENTRY_PREVIEW_CHARS).join(''),
    truncated,
  }
}

function textEntry(archivePath: string, content: string): PendingEntry {
  return { archivePath, data: Buffer.from(content), previewable: true }
}

function categorizeEntry(path: string): string {
  if (path === 'report.md' || path === 'redaction-report.json') return 'report'
  if (path.startsWith('logs/')) return 'logs'
  if (path === 'context/task.json') return 'task'
  if (path === 'environment.json') return 'system'
  if (path === 'screenshot.png') return 'screenshot'
  if (path.startsWith('attachments/')) return 'attachments'
  return 'other'
}

function sanitizeAttachmentName(name: string, index: number): string {
  const leaf = basename(name)
  const sanitized = [...leaf]
    .map(character =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '/\\:'.includes(character)
        ? '_'
        : character
    )
    .join('')
    .replace(/^[. ]+|[. ]+$/g, '')
  return `${index + 1}-${sanitized || `attachment-${index + 1}`}`
}

function isPreviewableAttachment(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript'].includes(mimeType)
  )
}

function decodeBase64(value: string, name: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Failed to decode attachment ${name}: invalid base64`)
  }
  return Buffer.from(value, 'base64')
}

function decodeDataUrl(value: string | null): Buffer | null {
  if (!value) return null
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  return match ? Buffer.from(match[1], 'base64') : null
}

function emptyValue(value: unknown): boolean {
  if (value == null) return true
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password)$/i.test(
          key
        )
          ? '[REDACTED]'
          : redactJson(item),
      ])
    )
  }
  return typeof value === 'string' ? redact(value) : value
}

export function redact(content: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/(authorization\s*[:=]\s*bearer\s+)[^\s,]+/gi, '$1[REDACTED]'],
    [
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*["']?)[^\s,"']+/gi,
      '$1[REDACTED]',
    ],
    [/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]'],
    [/(https?:\/\/[^\s/:]+:)[^@\s]+@/gi, '$1[REDACTED]@'],
  ]
  const redacted = patterns.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    content
  )
  const home = homedir()
  if (!home) return redacted
  return redacted.split(home).join('~').split(home.replaceAll('\\', '\\\\')).join('~')
}

function reserveLogArchivePath(fileName: string, used: Set<string>): string {
  const lower = fileName.toLowerCase()
  const source = lower.includes('executor')
    ? 'executor'
    : lower.includes('frontend') || lower.includes('webview')
      ? 'webview'
      : 'app'
  const requested = `logs/${source}/${fileName}`
  if (!used.has(requested)) {
    used.add(requested)
    return requested
  }
  const extension = extname(fileName)
  const stem = extension ? fileName.slice(0, -extension.length) : fileName
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `logs/${source}/${stem}-${suffix}${extension}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

function validateStagingId(value: string): string {
  if (!value || !/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error('Invalid feedback staging identifier')
  }
  return value
}

function randomToken(): string {
  return randomUUID().replaceAll('-', '')
}
