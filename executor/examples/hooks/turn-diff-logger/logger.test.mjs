import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { BUFFER_BYTES, logTurn } from './logger.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'turn-diff-logger-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const patch = join(directory, 'diff source.patch')
  const files = join(directory, 'files source.jsonl')
  writeFileSync(patch, 'diff --git a/代码.ts b/代码.ts\n@@ -1 +1 @@\n-旧值\n+新值🙂\n')
  writeFileSync(files, `${JSON.stringify({ path: '代码.ts', change_type: 'modified' })}\n`)
  return {
    directory,
    workspace,
    patch,
    files,
    logDirectory: join(directory, 'local logs'),
  }
}

function descriptor(path, format) {
  const bytes = readFileSync(path)
  return {
    path,
    format,
    size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function payload(fixture, fields = {}) {
  return {
    hook_event_name: 'TurnCompleted',
    event_id: 'stable-event/一',
    sequence: 1,
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: fixture.workspace,
    status: 'completed',
    file_changes: {
      version: 2,
      workspace_path: fixture.workspace,
      status: 'active',
      file_count: 1,
      additions: 1,
      deletions: 1,
      diff_artifact: descriptor(fixture.patch, 'git-patch'),
      files_artifact: descriptor(fixture.files, 'jsonl'),
    },
    ...fields,
  }
}

function initGit(workspace) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
  )
  execFileSync('git', ['-C', workspace, 'init', '--quiet', '--template='], {
    env,
    stdio: 'pipe',
  })
}

function records(logDirectory) {
  const root = join(logDirectory, 'records')
  return existsSync(root) ? readdirSync(root) : []
}

function record(result) {
  return JSON.parse(readFileSync(result.log_path, 'utf8'))
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, {
    highWaterMark: BUFFER_BYTES,
  }))
    hash.update(chunk)
  return hash.digest('hex')
}

function writeLargeArtifact(path, size, format) {
  const buffer = Buffer.from(
    format === 'git-patch' ? '+超长单行🙂'.repeat(3000) : '{"path":"代码🙂"}\n'.repeat(2000)
  )
  assert.ok(buffer.length <= BUFFER_BYTES)
  const hash = createHash('sha256')
  const file = openSync(path, 'w')
  try {
    let remaining = size
    while (remaining) {
      const chunk = buffer.subarray(0, Math.min(buffer.length, remaining))
      writeSync(file, chunk)
      hash.update(chunk)
      remaining -= chunk.length
    }
  } finally {
    closeSync(file)
  }
  return { path, format, size_bytes: size, sha256: hash.digest('hex') }
}

async function lowHeapLogger(input, config) {
  const script = `
    import { logTurn } from ${JSON.stringify(new URL('./logger.mjs', import.meta.url).href)}
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    const { payload, config } = JSON.parse(text)
    const result = await logTurn(payload, config)
    process.stdout.write(JSON.stringify({ result, maxRSS: process.resourceUsage().maxRSS }))
  `
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=16', '--input-type=module', '--eval', script],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout))
      else reject(new Error(`Low-heap logger exited ${code}: ${stderr}`))
    })
  })
  child.stdin.end(JSON.stringify({ payload: input, config }))
  return completion
}

test('archives exact Unicode artifacts and small metadata with private permissions', async (t) => {
  const fixtureData = fixture(t)
  const input = payload(fixtureData, {
    cwd: fixtureData.directory,
    user: { id: '用户-7', name: '测试用户🙂' },
    custom: { nested: ['保留字段', 7, false, null] },
  })

  const result = await logTurn(input, fixtureData)

  assert.equal(result.logged, true)
  assert.equal(result.deduplicated, false)
  assert.match(result.record_id, /^[a-f0-9]{64}$/)
  const stored = record(result)
  assert.equal(stored.schema_version, 2)
  assert.deepEqual(stored.payload, input)
  assert.equal(new Date(stored.timestamp).toISOString(), stored.timestamp)
  assert.equal(
    dirname(dirname(result.log_path)),
    join(realpathSync(fixtureData.logDirectory), 'records')
  )
  for (const [key, source] of [
    ['diff', fixtureData.patch],
    ['files', fixtureData.files],
  ]) {
    assert.deepEqual(
      readFileSync(join(dirname(result.log_path), stored.artifacts[key].path)),
      readFileSync(source)
    )
  }
  if (process.platform !== 'win32') {
    for (const path of [fixtureData.logDirectory, dirname(result.log_path)])
      assert.equal(statSync(path).mode & 0o777, 0o700)
    for (const path of [
      result.log_path,
      join(dirname(result.log_path), 'diff.patch'),
      join(dirname(result.log_path), 'files.jsonl'),
    ]) {
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }
  }
  assert.deepEqual(readdirSync(fixtureData.workspace), [])
})

test('concurrent distinct and repeated event IDs publish exactly one complete archive per event', async (t) => {
  const fixtureData = fixture(t)
  const inputs = Array.from({ length: 4 }, (_, index) =>
    payload(fixtureData, { event_id: `event-${index}`, sequence: index + 1 })
  )

  const results = await Promise.all(
    [...inputs, ...inputs].map((input) => logTurn(input, fixtureData))
  )

  assert.equal(new Set(results.map((result) => result.log_path)).size, inputs.length)
  assert.equal(results.filter((result) => !result.deduplicated).length, inputs.length)
  assert.equal(records(fixtureData.logDirectory).length, inputs.length)
  assert.ok(records(fixtureData.logDirectory).every((name) => /^[a-f0-9]{64}$/.test(name)))
  for (const [index, input] of inputs.entries())
    assert.deepEqual(record(results[index]).payload, input)
})

test('retries are idempotent after source deletion and conflicting metadata fails', async (t) => {
  const fixtureData = fixture(t)
  const input = payload(fixtureData)
  const first = await logTurn(input, fixtureData)
  const firstMetadata = readFileSync(first.log_path)
  rmSync(fixtureData.patch)
  rmSync(fixtureData.files)

  const retry = await logTurn(input, fixtureData)

  assert.equal(retry.deduplicated, true)
  assert.equal(retry.log_path, first.log_path)
  assert.deepEqual(readFileSync(first.log_path), firstMetadata)
  await assert.rejects(logTurn({ ...input, status: 'failed' }, fixtureData), /conflicting/i)
  await assert.rejects(logTurn({ ...input, sequence: 2 }, fixtureData), /conflicting/i)
  assert.equal(records(fixtureData.logDirectory).length, 1)
})

test('concurrent conflicting metadata cannot replace the winning event archive', async (t) => {
  const fixtureData = fixture(t)
  const input = payload(fixtureData)
  const conflict = { ...input, status: 'failed' }

  const results = await Promise.allSettled([
    logTurn(input, fixtureData),
    logTurn(conflict, fixtureData),
  ])

  const success = results.find((result) => result.status === 'fulfilled')
  const failure = results.find((result) => result.status === 'rejected')
  assert.ok(success)
  assert.match(failure?.reason.message, /conflicting/i)
  assert.equal(records(fixtureData.logDirectory).length, 1)
  const winner = results[0].status === 'fulfilled' ? input : conflict
  assert.deepEqual(record(success.value).payload, winner)
})

test('corrupt or incomplete artifacts never publish an archive and retries detect archive corruption', async (t) => {
  const fixtureData = fixture(t)
  const input = payload(fixtureData)
  const wrongHash = structuredClone(input)
  wrongHash.file_changes.diff_artifact.sha256 = '0'.repeat(64)
  await assert.rejects(logTurn(wrongHash, fixtureData), /SHA-256/i)
  const wrongSize = structuredClone(input)
  wrongSize.file_changes.files_artifact.size_bytes += 1
  await assert.rejects(logTurn(wrongSize, fixtureData), /size/i)
  assert.deepEqual(records(fixtureData.logDirectory), [])
  const result = await logTurn(input, fixtureData)
  const archived = join(dirname(result.log_path), 'diff.patch')
  writeFileSync(archived, Buffer.alloc(input.file_changes.diff_artifact.size_bytes, 120))
  await assert.rejects(logTurn(input, fixtureData), /SHA-256/i)
  assert.equal(records(fixtureData.logDirectory).length, 1)
})

test('empty artifacts and artifact-free capture errors preserve complete event metadata', async (t) => {
  const fixtureData = fixture(t)
  writeFileSync(fixtureData.patch, '')
  writeFileSync(fixtureData.files, '')
  const empty = payload(fixtureData)
  const result = await logTurn(empty, fixtureData)
  assert.equal(statSync(join(dirname(result.log_path), 'diff.patch')).size, 0)
  const error = payload(fixtureData, {
    event_id: 'error-event',
    sequence: 2,
    status: 'failed',
    file_changes: {
      version: 2,
      workspace_path: fixtureData.workspace,
      status: 'error',
      file_count: 0,
      additions: 0,
      deletions: 0,
      error: 'Git capture failed',
    },
  })
  const failedResult = await logTurn(error, fixtureData)
  assert.deepEqual(record(failedResult).payload, error)
  assert.deepEqual(readdirSync(dirname(failedResult.log_path)), ['record.json'])
})

test('invalid v2 metadata and inline legacy payloads create no log directory', async (t) => {
  const fixtureData = fixture(t)
  const valid = payload(fixtureData)
  const invalid = [
    null,
    {},
    { ...valid, hook_event_name: 'PostToolUse' },
    { ...valid, event_id: '' },
    { ...valid, sequence: -1 },
    { ...valid, sequence: 2 ** 53 },
    { ...valid, cwd: 'relative' },
    { ...valid, file_changes: { ...valid.file_changes, version: 1 } },
    { ...valid, file_changes: { ...valid.file_changes, diff: 'inline' } },
    { ...valid, file_changes: { ...valid.file_changes, files: [] } },
    { ...valid, file_changes: { ...valid.file_changes, diff_artifact: null } },
  ]
  for (const input of invalid) await assert.rejects(logTurn(input, fixtureData))
  assert.equal(existsSync(fixtureData.logDirectory), false)
})

test('missing workspace_path resolves actual Git root from nested cwd and rejects non-Git cwd', async (t) => {
  const fixtureData = fixture(t)
  const input = payload(fixtureData, {
    file_changes: {
      version: 2,
      status: 'error',
      file_count: 0,
      additions: 0,
      deletions: 0,
    },
  })
  await assert.rejects(logTurn(input, fixtureData))
  assert.equal(existsSync(fixtureData.logDirectory), false)
  initGit(fixtureData.workspace)
  const cwd = join(fixtureData.workspace, 'src')
  mkdirSync(cwd)
  input.cwd = cwd
  await assert.rejects(
    logTurn(input, { logDirectory: join(fixtureData.workspace, 'logs') }),
    /outside|workspace/i
  )
  const result = await logTurn(input, fixtureData)
  assert.deepEqual(record(result).payload, input)
  assert.deepEqual(readdirSync(cwd), [])
})

test('rejects log paths and symbolic links resolving inside the workspace', async (t) => {
  const fixtureData = fixture(t)
  const input = payload(fixtureData)
  for (const logDirectory of [fixtureData.workspace, join(fixtureData.workspace, 'logs')]) {
    await assert.rejects(logTurn(input, { logDirectory }), /outside|workspace/i)
  }
  const link = join(fixtureData.directory, 'redirected logs')
  symlinkSync(fixtureData.workspace, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(logTurn(input, { logDirectory: join(link, 'nested') }), /outside|workspace/i)
  assert.ok(
    !existsSync(
      join(
        fixtureData.workspace,
        'nested',
        'records',
        createHash('sha256').update(input.event_id).digest('hex')
      )
    )
  )
  mkdirSync(fixtureData.logDirectory)
  symlinkSync(
    fixtureData.workspace,
    join(fixtureData.logDirectory, 'records'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await assert.rejects(logTurn(input, fixtureData), /outside|workspace/i)
})

test('32 MiB Unicode single-line patches archive completely with a 16 MiB heap and bounded RSS', async (t) => {
  const fixtureData = fixture(t)
  const input = payload(fixtureData)
  writeFileSync(fixtureData.patch, '')
  writeFileSync(fixtureData.files, '')
  const small = payload(fixtureData, { event_id: 'small', sequence: 1 })
  const baseline = await lowHeapLogger(small, fixtureData)
  input.file_changes.diff_artifact = writeLargeArtifact(
    fixtureData.patch,
    32 * 1024 * 1024,
    'git-patch'
  )
  input.file_changes.files_artifact = writeLargeArtifact(
    fixtureData.files,
    4 * 1024 * 1024,
    'jsonl'
  )
  input.event_id = 'large'
  input.sequence = 2

  const large = await lowHeapLogger(input, fixtureData)

  assert.ok(
    large.maxRSS - baseline.maxRSS < 28 * 1024,
    `RSS grew ${(large.maxRSS - baseline.maxRSS) / 1024} MiB for a 36 MiB archive`
  )
  for (const [field, name] of [
    ['diff_artifact', 'diff.patch'],
    ['files_artifact', 'files.jsonl'],
  ]) {
    const archived = join(dirname(large.result.log_path), name)
    assert.equal(statSync(archived).size, input.file_changes[field].size_bytes)
    assert.equal(await hashFile(archived), input.file_changes[field].sha256)
  }
  assert.deepEqual(record(large.result).payload, input)
})
