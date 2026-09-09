import { ZipArchive } from 'archiver'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { extname, isAbsolute, posix, resolve } from 'node:path'

export const name = 'wework-conversation-export'
export const inject = ['weworkPluginRuntime']

const BACKEND_ID = 'conversation-export'
const MAX_ACTIVE_EXPORTS = 8
const IMAGE_CHUNK_BYTES = 192 * 1024
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const TERMINAL_TASK_RETENTION_MS = 5 * 60 * 1000
const exportTasks = new Map()

export function apply(ctx) {
  ctx.weworkPluginRuntime.register(ctx, {
    id: BACKEND_ID,
    methods: {
      start: options => startExport(options),
      append: ({ exportTaskId, content }) => appendExport(exportTaskId, content),
      addAsset: options => addExportAsset(options),
      appendAsset: options => appendExportAsset(options),
      finish: ({ exportTaskId }) => finishExport(exportTaskId),
      status: ({ exportTaskId }) => exportStatus(exportTaskId),
      cancel: ({ exportTaskId }) => cancelExport(exportTaskId),
      readImageChunk: ({ path, offset, workspacePath }) =>
        readImageChunk(path, offset, workspacePath),
    },
  })
  ctx.effect(
    () => () => {
      for (const task of exportTasks.values()) {
        void cleanupTaskFiles(task)
      }
      exportTasks.clear()
    },
    'conversation-export: cleanup temporary files'
  )
}

async function startExport({ path, archive = false, documentName, assetCount = 0 }) {
  const destination = requiredDestination(path)
  if (archive !== (extname(destination).toLowerCase() === '.zip')) {
    throw new Error('Conversation export archive mode does not match the destination')
  }
  if (!Number.isSafeInteger(assetCount) || assetCount < 0) {
    throw new Error('Conversation export asset count must be a non-negative safe integer')
  }
  discardExpiredTasks()
  const activeTasks = [...exportTasks.values()].filter(task => isActive(task.state))
  if (activeTasks.length >= MAX_ACTIVE_EXPORTS) {
    throw new Error('Too many conversation exports are in progress')
  }
  if (activeTasks.some(task => task.destination === destination)) {
    throw new Error('Another conversation export is already writing to this destination')
  }
  const exportTaskId = randomUUID()
  const temporaryPath = `${destination}.${exportTaskId}.tmp`
  const documentPath = archive ? `${destination}.${exportTaskId}.document.tmp` : temporaryPath
  const handle = await open(documentPath, 'wx', 0o600)
  exportTasks.set(exportTaskId, {
    archive,
    assetCount,
    assets: new Map(),
    bytesWritten: 0,
    destination,
    documentName: archive ? requiredDocumentName(documentName) : null,
    documentPath,
    exportTaskId,
    handle,
    state: 'writing',
    temporaryPath,
    uploadedAssetPaths: new Set(),
    updatedAt: Date.now(),
  })
  return { exportTaskId }
}

async function appendExport(exportTaskId, content) {
  const task = requiredActiveTask(exportTaskId, 'writing')
  if (typeof content !== 'string') throw new Error('Export content chunk must be a string')
  const buffer = Buffer.from(content, 'utf8')
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await task.handle.write(buffer, offset, buffer.byteLength - offset, null)
    if (result.bytesWritten <= 0) throw new Error('Conversation export could not write file data')
    offset += result.bytesWritten
  }
  task.bytesWritten += offset
  task.updatedAt = Date.now()
  return { written: offset }
}

async function addExportAsset({ exportTaskId, archivePath, path, workspacePath }) {
  const task = requiredArchiveTask(exportTaskId)
  const target = requiredArchivePath(archivePath)
  if (task.assets.has(target))
    throw new Error(`Conversation export asset already exists: ${target}`)
  const sourcePath = resolvedSource(path, workspacePath, 'Export asset')
  const metadata = await stat(sourcePath)
  if (!metadata.isFile()) throw new Error('Conversation export asset source must be a file')
  task.assets.set(target, { kind: 'local', path: sourcePath, size: metadata.size })
  task.updatedAt = Date.now()
  return { added: true, size: metadata.size }
}

async function appendExportAsset({ exportTaskId, archivePath, contentBase64 }) {
  const task = requiredArchiveTask(exportTaskId)
  const target = requiredArchivePath(archivePath)
  if (typeof contentBase64 !== 'string') {
    throw new Error('Conversation export asset chunk must be a base64 string')
  }
  let asset = task.assets.get(target)
  if (!asset) {
    const path = `${task.destination}.${task.exportTaskId}.${randomUUID()}.asset.tmp`
    asset = { bytesWritten: 0, handle: await open(path, 'wx', 0o600), kind: 'uploaded', path }
    task.assets.set(target, asset)
    task.uploadedAssetPaths.add(path)
  }
  if (asset.kind !== 'uploaded') {
    throw new Error(`Conversation export asset is not uploadable: ${target}`)
  }
  const buffer = Buffer.from(contentBase64, 'base64')
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await asset.handle.write(buffer, offset, buffer.byteLength - offset, null)
    if (result.bytesWritten <= 0) throw new Error('Conversation export could not write asset data')
    offset += result.bytesWritten
  }
  asset.bytesWritten += offset
  task.updatedAt = Date.now()
  return { written: offset }
}

function finishExport(exportTaskId) {
  const task = requiredActiveTask(exportTaskId, 'writing')
  if (task.assets.size !== task.assetCount) {
    throw new Error(
      `Conversation export expected ${task.assetCount} assets but received ${task.assets.size}`
    )
  }
  task.state = 'finalizing'
  task.phase = task.archive ? 'packaging' : 'finalizing'
  task.updatedAt = Date.now()
  void finalizeExport(task)
  return taskResult(task)
}

async function finalizeExport(task) {
  try {
    await task.handle.sync()
    await task.handle.close()
    task.handle = null
    for (const asset of task.assets.values()) {
      if (asset.kind !== 'uploaded') continue
      await asset.handle.sync()
      await asset.handle.close()
      asset.handle = null
    }
    if (task.archive) await writeArchive(task)
    const temporaryMetadata = await stat(task.temporaryPath)
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.size <= 0 ||
      (!task.archive && temporaryMetadata.size !== task.bytesWritten)
    ) {
      throw new Error('Conversation export file verification failed')
    }
    await replaceDestination(
      task.temporaryPath,
      task.destination,
      task.exportTaskId,
      temporaryMetadata.size
    )
    task.size = temporaryMetadata.size
    task.state = 'completed'
  } catch (error) {
    await cleanupTaskFiles(task)
    task.error = error instanceof Error ? error.message : 'Conversation export failed'
    task.state = 'failed'
  } finally {
    if (task.state === 'completed') await cleanupTaskStagingFiles(task)
    task.updatedAt = Date.now()
  }
}

function exportStatus(exportTaskId) {
  return taskResult(requiredTask(exportTaskId))
}

async function cancelExport(exportTaskId) {
  const task = requiredTask(exportTaskId)
  if (task.state !== 'writing') return { cancelled: false, ...taskResult(task) }
  await cleanupTaskFiles(task)
  task.state = 'cancelled'
  task.updatedAt = Date.now()
  return { cancelled: true, ...taskResult(task) }
}

async function readImageChunk(path, offset, workspacePath) {
  const source = resolvedSource(path, workspacePath, 'Image source')
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Image read offset must be a non-negative safe integer')
  }
  const metadata = await stat(source)
  if (!metadata.isFile()) throw new Error('Image source must be a file')
  if (metadata.size > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds the 50 MB conversation export limit')
  }
  if (offset > metadata.size) throw new Error('Image read offset exceeds the file size')

  const length = Math.min(IMAGE_CHUNK_BYTES, metadata.size - offset)
  const buffer = Buffer.alloc(length)
  const handle = await open(source, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return {
      chunkBase64: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      eof: offset + bytesRead >= metadata.size,
      size: metadata.size,
    }
  } finally {
    await handle.close()
  }
}

function resolvedSource(value, workspacePath, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} path is required`)
  }
  const path = value.trim()
  if (isAbsolute(path)) return path
  const workspace = requiredAbsolutePath(workspacePath, 'Conversation workspace')
  return resolve(workspace, path)
}

function requiredDestination(value) {
  const path = requiredAbsolutePath(value, 'Export destination')
  if (!['.md', '.html', '.zip'].includes(extname(path).toLowerCase())) {
    throw new Error('Export destination must end with .md, .html, or .zip')
  }
  return path
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return value.trim()
}

function requiredDocumentName(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('/') || value.includes('\\')) {
    throw new Error('Conversation export document name must be a filename')
  }
  if (!['.md', '.html'].includes(extname(value).toLowerCase())) {
    throw new Error('Conversation export document name must end with .md or .html')
  }
  return value.trim()
}

function requiredArchivePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Conversation export archive path is required')
  }
  const normalized = posix.normalize(value.trim().replaceAll('\\', '/'))
  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Conversation export archive path must stay inside the archive')
  }
  return normalized
}

function requiredArchiveTask(exportTaskId) {
  const task = requiredActiveTask(exportTaskId, 'writing')
  if (!task.archive) throw new Error('Conversation export task is not creating an archive')
  return task
}

async function replaceDestination(temporaryPath, destination, exportTaskId, expectedSize) {
  const backupPath = `${destination}.${exportTaskId}.backup`
  let hasBackup = false
  try {
    const existing = await stat(destination)
    if (!existing.isFile()) throw new Error('Conversation export destination is not a file')
    await rename(destination, backupPath)
    hasBackup = true
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  try {
    await rename(temporaryPath, destination)
    const metadata = await stat(destination)
    if (!metadata.isFile() || metadata.size !== expectedSize) {
      throw new Error('Conversation export destination verification failed')
    }
    if (hasBackup) await rm(backupPath, { force: true })
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {})
    if (hasBackup) await rename(backupPath, destination).catch(() => {})
    throw error
  }
}

function isMissingFile(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT'
}

function requiredActiveTask(exportTaskId, expectedState) {
  const task = requiredTask(exportTaskId)
  if (task.state !== expectedState) {
    throw new Error(`Conversation export task is ${task.state}, expected ${expectedState}`)
  }
  return task
}

function requiredTask(value) {
  const exportTaskId = requiredId(value)
  const task = exportTasks.get(exportTaskId)
  if (!task) throw new Error('Conversation export task was not found')
  return task
}

function requiredId(value) {
  if (typeof value !== 'string' || !value) throw new Error('Export task id is required')
  return value
}

function taskResult(task) {
  return {
    exportTaskId: task.exportTaskId,
    state: task.state,
    phase: task.phase ?? task.state,
    assetsCompleted: task.assets.size,
    assetsTotal: task.assetCount,
    ...(task.state === 'completed' ? { path: task.destination, size: task.size } : {}),
    ...(task.state === 'failed' ? { error: task.error } : {}),
  }
}

function discardExpiredTasks() {
  const cutoff = Date.now() - TERMINAL_TASK_RETENTION_MS
  for (const [exportTaskId, task] of exportTasks) {
    if (!isActive(task.state) && task.updatedAt < cutoff) exportTasks.delete(exportTaskId)
  }
}

function isActive(state) {
  return state === 'writing' || state === 'finalizing'
}

async function writeArchive(task) {
  const output = createWriteStream(task.temporaryPath, { flags: 'wx', mode: 0o600 })
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const completed = new Promise((resolveArchive, rejectArchive) => {
    output.once('close', resolveArchive)
    output.once('error', rejectArchive)
    archive.once('error', rejectArchive)
  })
  archive.pipe(output)
  archive.file(task.documentPath, { name: task.documentName })
  for (const [archivePath, asset] of task.assets) {
    archive.file(asset.path, { name: archivePath })
  }
  try {
    await archive.finalize()
    await completed
  } catch (error) {
    archive.abort()
    output.destroy()
    throw error
  }
}

async function cleanupTaskFiles(task) {
  await task.handle?.close().catch(() => {})
  task.handle = null
  for (const asset of task.assets.values()) {
    await asset.handle?.close().catch(() => {})
    if (asset.kind === 'uploaded') asset.handle = null
  }
  await Promise.all(
    [task.temporaryPath, task.documentPath, ...task.uploadedAssetPaths].map(path =>
      rm(path, { force: true }).catch(() => {})
    )
  )
}

async function cleanupTaskStagingFiles(task) {
  await Promise.all(
    [task.documentPath, ...task.uploadedAssetPaths].map(path =>
      path === task.destination ? Promise.resolve() : rm(path, { force: true }).catch(() => {})
    )
  )
}
