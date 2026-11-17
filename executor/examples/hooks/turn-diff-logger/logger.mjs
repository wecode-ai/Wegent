import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isDeepStrictEqual } from 'node:util'

export const BUFFER_BYTES = 64 * 1024
export const MAX_METADATA_BYTES = 1024 * 1024
export const ARTIFACTS = {
  diff: { field: 'diff_artifact', name: 'diff.patch', format: 'git-patch' },
  files: { field: 'files_artifact', name: 'files.jsonl', format: 'jsonl' },
}

function validatePayload(payload) {
  const changes = payload?.file_changes
  if (
    payload?.hook_event_name !== 'TurnCompleted' ||
    !['event_id', 'session_id', 'turn_id'].every(
      (field) => typeof payload[field] === 'string' && payload[field].trim()
    ) ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 0 ||
    typeof payload.cwd !== 'string' ||
    !isAbsolute(payload.cwd) ||
    changes?.version !== 2 ||
    typeof changes.status !== 'string' ||
    !['file_count', 'additions', 'deletions'].every(
      (field) => Number.isSafeInteger(changes[field]) && changes[field] >= 0
    ) ||
    'diff' in changes ||
    'files' in changes
  ) {
    throw new Error(
      'Expected a v2 TurnCompleted event with event_id, sequence and artifact metadata'
    )
  }
  for (const { field, format } of Object.values(ARTIFACTS)) {
    const artifact = changes[field]
    if (artifact == null && changes.status === 'error') continue
    if (
      !artifact ||
      typeof artifact.path !== 'string' ||
      !isAbsolute(artifact.path) ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      artifact.size_bytes < 0 ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      artifact.format !== format
    ) {
      throw new Error(`Invalid ${field} descriptor`)
    }
  }
}

function logRoot({ logDirectory }) {
  if (typeof logDirectory !== 'string' || !logDirectory.trim()) {
    throw new Error('config.json must specify logDirectory')
  }
  const path =
    logDirectory.startsWith(`~${sep}`) || logDirectory.startsWith('~/')
      ? join(homedir(), logDirectory.slice(2))
      : logDirectory
  if (!isAbsolute(path)) throw new Error('logDirectory must be an absolute path or start with ~/')
  return path
}

function workspaceRoot(payload) {
  if (payload.file_changes.workspace_path != null) {
    return realpath(payload.file_changes.workspace_path)
  }
  const root = execFileSync('git', ['-C', payload.cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    windowsHide: true,
  }).replace(/[\r\n]+$/, '')
  return realpath(root)
}

function assertOutsideWorkspace(directory, workspace) {
  const inside = relative(workspace, directory)
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
    throw new Error('logDirectory must be outside the Git workspace')
  }
}

async function readMetadata(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw new Error('Invalid record metadata')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function syncPath(path, directory = false) {
  if (directory && process.platform === 'win32') return
  const file = await open(path, directory ? 'r' : 'r+')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

async function verifyArtifact(source, descriptor, destination) {
  const info = await lstat(source)
  if (!info.isFile() || info.size !== descriptor.size_bytes) {
    throw new Error('Artifact size mismatch or source is not a regular file')
  }
  const hash = createHash('sha256')
  let bytes = 0
  const verify = new Transform({
    highWaterMark: BUFFER_BYTES,
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > descriptor.size_bytes) return callback(new Error('Artifact size mismatch'))
      hash.update(chunk)
      callback(null, destination ? chunk : undefined)
    },
  })
  const input = createReadStream(source, { highWaterMark: BUFFER_BYTES })
  if (destination) {
    await pipeline(
      input,
      verify,
      createWriteStream(destination, {
        flags: 'wx',
        mode: 0o600,
        highWaterMark: BUFFER_BYTES,
      })
    )
  } else {
    await pipeline(input, verify)
  }
  if (bytes !== descriptor.size_bytes || hash.digest('hex') !== descriptor.sha256) {
    throw new Error('Artifact size or SHA-256 mismatch')
  }
  if (destination) await syncPath(destination)
}

async function existingRecord(directory, payload) {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid archive directory')
    const record = await readMetadata(join(directory, 'record.json'))
    const id = createHash('sha256').update(payload.event_id).digest('hex')
    if (
      record.schema_version !== 2 ||
      record.record_id !== id ||
      !isDeepStrictEqual(record.payload, payload)
    ) {
      throw new Error('Conflicting metadata for existing event_id')
    }
    const expected = {}
    for (const [key, { field, name }] of Object.entries(ARTIFACTS)) {
      if (payload.file_changes[field]) {
        await verifyArtifact(join(directory, name), payload.file_changes[field])
        expected[key] = { ...payload.file_changes[field], path: name }
      }
    }
    if (!isDeepStrictEqual(record.artifacts, expected)) throw new Error('Invalid archive manifest')
    return true
  } catch (error) {
    if (error.code === 'ENOENT' && !(await lstat(directory).catch(() => null))) return false
    throw error
  }
}

export async function logTurn(payload, config) {
  validatePayload(payload)
  const workspace = await workspaceRoot(payload)
  const requested = join(logRoot(config), 'records')
  assertOutsideWorkspace(resolve(requested), workspace)
  await mkdir(requested, { recursive: true, mode: 0o700 })
  const root = await realpath(requested)
  assertOutsideWorkspace(root, workspace)
  const id = createHash('sha256').update(payload.event_id).digest('hex')
  const directory = join(root, id)
  const result = (deduplicated) => ({
    logged: true,
    record_id: id,
    log_path: join(directory, 'record.json'),
    deduplicated,
  })
  if (await existingRecord(directory, payload)) {
    await syncPath(root, true)
    return result(true)
  }
  const temporary = join(root, `.${id}-${randomUUID()}.tmp`)
  await mkdir(temporary, { mode: 0o700 })
  try {
    const artifacts = {}
    for (const [key, { field, name }] of Object.entries(ARTIFACTS)) {
      const artifact = payload.file_changes[field]
      if (!artifact) continue
      await verifyArtifact(artifact.path, artifact, join(temporary, name))
      artifacts[key] = { ...artifact, path: name }
    }
    const record = {
      schema_version: 2,
      record_id: id,
      timestamp: new Date().toISOString(),
      payload,
      artifacts,
    }
    const metadata = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES)
      throw new Error('Record metadata too large')
    await writeFile(join(temporary, 'record.json'), metadata, {
      flag: 'wx',
      mode: 0o600,
    })
    await syncPath(join(temporary, 'record.json'))
    await syncPath(temporary, true)
    try {
      await rename(temporary, directory)
    } catch (error) {
      if (await existingRecord(directory, payload)) {
        await syncPath(root, true)
        return result(true)
      }
      throw error
    }
    await syncPath(root, true)
    return result(false)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
