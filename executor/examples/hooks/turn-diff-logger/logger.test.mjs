import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { channel } from 'node:diagnostics_channel'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { handleEvent } from './logger.mjs'
import { BUFFER_BYTES, git as runGit, gitStream } from './git.mjs'
import { processQueue } from './worker.mjs'
import { digest, readJson, writeJson } from './storage.mjs'

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
)
const noWorker = async () => {}
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

async function fixture(
  t,
  { commit = true, workspaceDirectory = 'workspace with spaces' } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'async-turn-hook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, workspaceDirectory)
  const logs = join(root, 'logs')
  await mkdir(workspace, { recursive: true })
  // Setup must create the long repository before its persisted setting is tested.
  const prepareGit = (...args) => git(workspace, '-c', 'core.longpaths=true', ...args)
  prepareGit('init', '--quiet', '--template=')
  prepareGit('config', 'user.name', 'Hook Tests')
  prepareGit('config', 'user.email', 'hooks@example.invalid')
  await writeFile(join(workspace, 'source.txt'), 'original\n')
  if (commit) {
    prepareGit('add', '.')
    prepareGit('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline')
  }
  const event = (sequence, hook_event_name = 'TurnCompleted', execution_id = 'one') => ({
    schema_version: 1,
    emitted_at_ms: Date.now(),
    event_id: execution_id + ':' + sequence,
    execution_id,
    sequence,
    task_id: 'source-task',
    request_id: 'source-request',
    runtime_task_id: 'local-task',
    device_id: 'device',
    runtime: 'Codex',
    executor_version: 'test-version',
    platform: process.platform,
    arch: process.arch,
    hook_event_name,
    cwd: workspace,
    status: hook_event_name === 'TurnStarted' ? 'started' : 'completed',
    user: { id: null, name: 'Test' },
    session_id: null,
    turn_id: null,
    model: 'test-model',
    model_provider: 'test-provider',
    permission_mode: 'workspace-write',
    is_test: false,
  })
  const config = { logDirectory: logs }
  return {
    root,
    workspace,
    logs,
    config,
    event,
    invoke: input => handleEvent(input, config, { launchWorker: noWorker }),
  }
}

async function records(logs) {
  const found = []
  for (const name of await readdir(join(logs, 'records'))) {
    if (!name.startsWith('.'))
      found.push(await readJson(join(logs, 'records', name, 'record.json')))
  }
  return found.sort((a, b) => a.event.sequence - b.event.sequence)
}

const patchPath = (f, record) =>
  join(f.logs, 'records', digest(record.event.event_id), 'diff.patch')

test('event pins stay within the reported Windows ref path and survive archive cleanup', async t => {
  const f = await fixture(t)
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  const jobs = []
  for (const sequence of [1, 2]) {
    await writeFile(join(f.workspace, 'source.txt'), 'revision ' + sequence + '\n')
    const event = f.event(sequence)
    await f.invoke(event)
    jobs.push(await readJson(join(start.queue_path, 'pending', digest(event.event_id) + '.json')))
  }
  await f.invoke(f.event(3, 'ExecutionCompleted'))
  const reportedGitRoot =
    'C:/Users/wework-e2e-9756/AppData/Local/Temp/wework-async-hooks-IGsJvw/repository/.git'
  const refs = jobs.flatMap(job => job.references)
  assert.equal(new Set(refs).size, 4, 'Each queued snapshot must retain its own pins')
  for (const job of jobs) {
    for (const [index, ref] of job.references.entries()) {
      const lockPath = win32.join(reportedGitRoot, ref + '.lock')
      assert.ok(lockPath.length < 260,
        'Reported Windows ref lock path is too long: ' + lockPath.length)
      assert.equal(git(f.workspace, 'rev-parse', ref), index ? job.after : job.before)
    }
  }
  git(f.workspace, 'gc', '--prune=now')
  await processQueue(start.queue_path)
  assert.equal((await records(f.logs)).length, 2)
  assert.deepEqual(await readdir(join(start.queue_path, 'pending')), [])
  assert.equal(git(f.workspace, 'for-each-ref', '--format=%(refname)', 'refs/wegent/turn-diff'), '')
})

test('verbose Git warnings are drained while metadata stdout remains bounded', async t => {
  const f = await fixture(t)
  git(f.workspace, 'config', 'core.autocrlf', 'true')
  git(f.workspace, 'config', 'core.safecrlf', 'warn')
  for (let i = 0; i < 400; i++)
    await writeFile(join(f.workspace, 'warning-' + i + '-' + 'x'.repeat(180)), 'line\n')
  const warning = spawnSync('git', ['-C', f.workspace, 'add', '--all'], {
    env: { ...environment, GIT_INDEX_FILE: join(f.root, 'warning.index') },
    encoding: 'utf8',
  })
  assert.equal(warning.status, 0, warning.stderr)
  assert.ok(Buffer.byteLength(warning.stderr) > BUFFER_BYTES)
  await f.invoke(f.event(0, 'TurnStarted'))
  await writeFile(join(f.workspace, 'large.txt'), 'x'.repeat(BUFFER_BYTES + 1))
  const blob = git(f.workspace, 'hash-object', '-w', 'large.txt')
  await assert.rejects(runGit(f.workspace, ['cat-file', 'blob', blob]), /exceeds 64 KiB/)
  let size = 0
  const hash = createHash('sha256')
  for await (const bytes of gitStream(f.workspace, ['cat-file', 'blob', blob])) {
    hash.update(bytes)
    size += bytes.length
  }
  assert.equal(size, BUFFER_BYTES + 1)
  assert.equal(hash.digest('hex'), createHash('sha256').update('x'.repeat(size)).digest('hex'))
  const output = []
  for await (const bytes of gitStream(f.workspace, ['hash-object', '--stdin'], { input: 'stdin' }))
    output.push(bytes)
  assert.equal(
    Buffer.concat(output).toString().trim(),
    await runGit(f.workspace, ['hash-object', '--stdin'], { input: 'stdin' })
  )
  await assert.rejects(
    async () => {
      for await (const _bytes of gitStream(f.workspace, [
        'rev-parse',
        '--verify',
        'refs/missing',
      ])) {
        assert.fail('A missing reference produced output')
      }
    },
    { gitExitCode: 128 }
  )
})

test('failed metadata writes and syncs remove their temporary files', async t => {
  const f = await fixture(t)
  const probe = await open(join(f.root, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe)
  await probe.close()
  const modifiedAt = Date.now() - 86400000
  for (const method of ['writeFile', 'utimes', 'sync']) {
    const fault = t.mock.method(prototype, method, async function () {
      throw new Error('injected metadata failure')
    })
    try {
      await assert.rejects(writeJson(join(f.root, 'metadata.json'), {}, { modifiedAt }), /injected/)
    } finally {
      fault.mock.restore()
    }
    assert.equal(
      (await readdir(f.root)).some(name => name.startsWith('metadata.json')),
      false
    )
  }
  await writeJson(join(f.root, 'metadata.json'), {}, { modifiedAt })
  const file = await open(join(f.root, 'metadata.json'), 'r')
  try {
    assert.ok(Math.abs((await file.stat()).mtimeMs - modifiedAt) < 1)
  } finally {
    await file.close()
  }
})

test('failed queue publication releases refs only before the job becomes visible', async t => {
  for (const stage of ['write', ...(process.platform === 'win32' ? [] : ['directory-sync'])]) {
    const f = await fixture(t)
    const start = await f.invoke(f.event(0, 'TurnStarted'))
    const statePath = join(start.queue_path, 'executions', digest('one'), 'state.json')
    const baseline = await readJson(statePath)
    await writeFile(join(f.workspace, 'source.txt'), 'captured despite sync failure\n')
    const probe = await open(join(f.root, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    const write = prototype.writeFile
    const sync = prototype.sync
    let jobWritten = false
    const writer = t.mock.method(prototype, 'writeFile', async function (bytes, ...args) {
      if (JSON.parse(bytes).input?.event_id === 'one:1') {
        if (stage === 'write') throw new Error('injected queue failure')
        jobWritten = true
      }
      return write.call(this, bytes, ...args)
    })
    const syncer = t.mock.method(prototype, 'sync', async function () {
      if (jobWritten && (await this.stat()).isDirectory()) {
        jobWritten = false
        throw new Error('injected queue failure')
      }
      return sync.call(this)
    })
    try {
      await assert.rejects(f.invoke(f.event(1)), /injected queue failure/)
    } finally {
      writer.mock.restore()
      syncer.mock.restore()
    }
    const refs = () =>
      git(f.workspace, 'for-each-ref', '--format=%(refname)', 'refs/wegent/turn-diff')
    const pending = await readdir(join(start.queue_path, 'pending'))
    if (stage === 'write') {
      assert.deepEqual(pending, [])
      assert.equal(refs(), baseline.reference)
    } else {
      assert.equal(pending.length, 1)
      assert.match(refs(), /\/event-/)
      git(f.workspace, 'gc', '--prune=now')
      await processQueue(start.queue_path)
      const [record] = await records(f.logs)
      assert.match(await readFile(patchPath(f, record), 'utf8'), /captured despite sync failure/)
      assert.equal(refs(), baseline.reference)
      assert.equal(git(f.workspace, 'rev-parse', baseline.reference), baseline.tree)
    }
  }
})

test('replaying a closed execution releases a baseline left by an interrupted cleanup', async t => {
  const f = await fixture(t)
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  const statePath = join(start.queue_path, 'executions', digest('one'), 'state.json')
  const baseline = await readJson(statePath)
  await writeJson(statePath, { ...baseline, closed: true })
  assert.equal(git(f.workspace, 'rev-parse', baseline.reference), baseline.tree)
  await f.invoke(f.event(1, 'ExecutionCompleted'))
  assert.equal(git(f.workspace, 'for-each-ref', '--format=%(refname)', 'refs/wegent/turn-diff'), '')
  assert.deepEqual(await records(f.logs), [])
})

test('only snapshot differences are logged, including child shell writes and separate increments', async t => {
  const f = await fixture(t)
  await writeFile(join(f.workspace, 'source.txt'), 'dirty before\n')
  await writeFile(join(f.workspace, 'preexisting.txt'), 'user file\n')
  const index = await readFile(join(f.workspace, '.git', 'index'))
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  assert.deepEqual(await records(f.logs), [], 'A baseline must never be logged as a full inventory')
  await writeFile(join(f.workspace, 'source.txt'), 'first\n')
  await writeFile(join(f.workspace, 'child.txt'), 'child shell write\n')
  await f.invoke(f.event(1))
  await writeFile(join(f.workspace, 'source.txt'), 'second\n')
  await writeFile(join(f.workspace, 'second.txt'), 'next\n')
  await f.invoke(f.event(2))
  await f.invoke(f.event(2))
  await f.invoke(f.event(3, 'ExecutionCompleted'))
  git(f.workspace, 'gc', '--prune=now')
  await processQueue(start.queue_path)
  const found = await records(f.logs)
  assert.equal(found.length, 2)
  const first = await readFile(patchPath(f, found[0]), 'utf8')
  const second = await readFile(patchPath(f, found[1]), 'utf8')
  assert.match(first, /-dirty before\n\+first/)
  assert.match(first, /\+child shell write/)
  assert.doesNotMatch(first, /preexisting|second/)
  assert.match(second, /-first\n\+second/)
  assert.doesNotMatch(second, /child\.txt|preexisting/)
  assert.deepEqual(await readFile(join(f.workspace, '.git', 'index')), index)
  assert.equal(git(f.workspace, 'for-each-ref', '--format=%(refname)', 'refs/wegent/turn-diff'), '')
  assert.deepEqual(await readdir(join(start.queue_path, 'pending')), [])
})

test('complete records preserve publisher metadata and sanitized remotes at capture time', async t => {
  const f = await fixture(t)
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  const cases = [
    [null, null],
    [
      'https://user:secret@example.invalid/org/repo.git?token=secret#secret',
      'https://example.invalid/org/repo.git',
    ],
    ['ssh://git:secret@example.invalid/org/repo.git', 'ssh://example.invalid/org/repo.git'],
    ['git@example.invalid:org/repo.git', 'git@example.invalid:org/repo.git'],
    [join(f.root, 'local remote.git'), join(f.root, 'local remote.git')],
  ]
  const events = []
  for (const [index, [remote]] of cases.entries()) {
    if (remote) git(f.workspace, 'config', 'remote.origin.url', remote)
    await writeFile(join(f.workspace, 'source.txt'), 'change ' + index + '\n')
    const event = f.event(index + 1)
    events.push(event)
    await f.invoke(event)
  }
  git(f.workspace, 'config', 'remote.origin.url', 'https://later.invalid/repo.git')
  await f.invoke(f.event(cases.length + 1, 'ExecutionCompleted'))
  await processQueue(start.queue_path)
  const found = await records(f.logs)
  assert.equal(found.length, cases.length)
  for (const [index, record] of found.entries()) {
    assert.deepEqual(record.event, events[index])
    assert.equal(record.git_url, cases[index][1])
    assert.equal(record.additions, 1)
    assert.equal(record.deletions, 1)
    assert.equal(record.workspace, await realpath(f.workspace))
    assert.doesNotMatch(JSON.stringify(record), /secret|later\.invalid/)
  }
  const invalid = { ...f.event(99), schema_version: 999 }
  await assert.rejects(f.invoke(invalid), /Expected lifecycle metadata/)
})

test('large patches and hashes remain complete with a 24 MiB Node heap', async t => {
  const f = await fixture(t)
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  const file = await open(join(f.workspace, 'large.txt'), 'w')
  const chunk = 'complete-code-🙂0123456789\n'.repeat(2000)
  try {
    for (let i = 0; i < 175; i++) await file.writeFile(chunk)
  } finally {
    await file.close()
  }
  await f.invoke(f.event(1))
  await f.invoke(f.event(2, 'ExecutionCompleted'))
  const cli = fileURLToPath(new URL('./bin/log-turn.mjs', import.meta.url))
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=24', cli, 'worker', start.queue_path],
    {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', bytes => {
    stderr += bytes
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, stderr)
  const [record] = await records(f.logs)
  assert.equal(record.additions, 350000)
  assert.equal(record.file_count, 1)
  assert.ok(record.artifacts.diff.size_bytes > 8 * 1024 * 1024)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(patchPath(f, record))) {
    hash.update(chunk)
    bytes += chunk.length
  }
  assert.equal(hash.digest('hex'), record.artifacts.diff.sha256)
  assert.equal(bytes, record.artifacts.diff.size_bytes)
})

test('queued snapshots survive later writes, GC and a replay after archive publication', async t => {
  const f = await fixture(t)
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  await writeFile(join(f.workspace, 'source.txt'), 'captured\n')
  await f.invoke(f.event(1))
  const pending = join(start.queue_path, 'pending', digest(f.event(1).event_id) + '.json')
  const job = await readJson(pending)
  await writeFile(join(f.workspace, 'source.txt'), 'later write\n')
  await f.invoke(f.event(2, 'ExecutionCompleted'))
  git(f.workspace, 'gc', '--prune=now')
  await processQueue(start.queue_path)
  const [record] = await records(f.logs)
  assert.match(await readFile(patchPath(f, record), 'utf8'), /\+captured/)
  assert.doesNotMatch(await readFile(patchPath(f, record), 'utf8'), /later write/)
  await writeJson(pending, job)
  git(f.workspace, 'gc', '--prune=now')
  await processQueue(start.queue_path)
  assert.equal((await records(f.logs)).length, 1)
})

test('non-Git and test events do not collect; unsafe log destinations are rejected', async t => {
  const f = await fixture(t)
  const plain = join(f.root, 'plain')
  await mkdir(plain)
  assert.equal((await f.invoke({ ...f.event(0, 'TurnStarted'), cwd: plain })).recorded, false)
  assert.equal((await f.invoke({ ...f.event(0, 'TurnStarted'), is_test: true })).tested, true)
  assert.equal((await readdir(f.root)).includes('logs'), false)
  await assert.rejects(
    handleEvent(f.event(0, 'TurnStarted'), {
      logDirectory: join(f.workspace, 'logs'),
    }),
    /outside/
  )
  if (process.platform !== 'win32') {
    const link = join(f.root, 'link')
    await symlink(f.workspace, link)
    await assert.rejects(
      handleEvent(f.event(0, 'TurnStarted'), {
        logDirectory: join(link, 'nested'),
      }),
      /outside/
    )
    assert.equal((await readdir(f.workspace)).includes('nested'), false)
  }
})

test('unborn, split-index and ignored files preserve Git semantics and the real index', async t => {
  for (const mode of ['unborn', 'unborn-with-index', 'split']) {
    const f = await fixture(t, { commit: mode === 'split' })
    await writeFile(join(f.workspace, '.gitignore'), '*.ignored\n')
    await writeFile(join(f.workspace, 'tracked.ignored'), 'before\n')
    await writeFile(join(f.workspace, 'untracked.ignored'), 'ignored\n')
    if (mode !== 'unborn') git(f.workspace, 'add', '-f', 'tracked.ignored')
    if (mode === 'split') git(f.workspace, 'update-index', '--split-index')
    const indexPath = join(f.workspace, '.git', 'index')
    const index = await readFile(indexPath).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const start = await f.invoke(f.event(0, 'TurnStarted'))
    await writeFile(join(f.workspace, 'source.txt'), 'after\n')
    await writeFile(join(f.workspace, 'tracked.ignored'), 'after\n')
    await f.invoke(f.event(1))
    await f.invoke(f.event(2, 'ExecutionCompleted'))
    await processQueue(start.queue_path)
    const [record] = await records(f.logs)
    const patch = await readFile(patchPath(f, record), 'utf8')
    assert.match(patch, /source\.txt/)
    assert.doesNotMatch(patch, /untracked\.ignored/)
    if (mode !== 'unborn') assert.match(patch, /tracked\.ignored/)
    assert.deepEqual(
      await readFile(indexPath).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      }),
      index
    )
  }
})

test('same-size writes with equal timestamps, binary data and filename bytes are captured', async t => {
  const f = await fixture(t)
  const timestamp = Math.floor(Date.now() / 1000)
  const source = join(f.workspace, 'source.txt')
  await utimes(source, timestamp, timestamp)
  git(f.workspace, 'add', '.')
  await utimes(join(f.workspace, '.git', 'index'), timestamp, timestamp)
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  await writeFile(source, 'replaced\n')
  await utimes(source, timestamp, timestamp)
  const name =
    process.platform === 'linux' ? Buffer.from([255, 46, 98, 105, 110]) : Buffer.from('binary.bin')
  await writeFile(
    Buffer.concat([Buffer.from(f.workspace + '/'), name]),
    Buffer.from([0, 1, 2, 255])
  )
  await f.invoke(f.event(1))
  await f.invoke(f.event(2, 'ExecutionCompleted'))
  await processQueue(start.queue_path)
  const [record] = await records(f.logs)
  const patch = await readFile(patchPath(f, record), 'utf8')
  assert.match(patch, /-original\n\+replaced/)
  assert.match(patch, /GIT binary patch/)
  const rows = (
    await readFile(join(f.logs, 'records', digest(record.event.event_id), 'files.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map(JSON.parse)
  const binary = rows.find(row => row.binary)
  if (process.platform === 'linux') assert.equal(binary.path_bytes_hex, name.toString('hex'))
  else assert.equal(binary.path, 'binary.bin')
})

test('missing baselines fail visibly and a final event can cover a failed completion', async t => {
  const f = await fixture(t)
  await assert.rejects(f.invoke(f.event(1)), /baseline is missing/)
  assert.deepEqual(await records(f.logs), [])
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  await writeFile(join(f.workspace, 'source.txt'), 'recovered end\n')
  await f.invoke(f.event(2, 'ExecutionCompleted'))
  await processQueue(start.queue_path)
  const [record] = await records(f.logs)
  assert.equal(record.event.hook_event_name, 'ExecutionCompleted')
  assert.match(await readFile(patchPath(f, record), 'utf8'), /\+recovered end/)
})

test('archive cleanup preserves a baseline left behind by an interrupted producer', async t => {
  const f = await fixture(t)
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  const statePath = join(start.queue_path, 'executions', digest('one'), 'state.json')
  const baseline = await readJson(statePath)
  await writeFile(join(f.workspace, 'source.txt'), 'first captured\n')
  await f.invoke(f.event(1))
  // Recreate a producer interruption after queue publication and ref advancement,
  // but before the corresponding state file became durable.
  await writeJson(statePath, baseline)
  await processQueue(start.queue_path)
  git(f.workspace, 'gc', '--prune=now')
  assert.equal(git(f.workspace, 'rev-parse', baseline.reference), baseline.tree)
  await writeFile(join(f.workspace, 'source.txt'), 'next captured\n')
  await f.invoke(f.event(2))
  await f.invoke(f.event(3, 'ExecutionCompleted'))
  await processQueue(start.queue_path)
  const found = await records(f.logs)
  assert.equal(found.length, 2)
  assert.match(await readFile(patchPath(f, found[1]), 'utf8'), /-original\n\+next captured/)
})

test('long snapshot refs use per-call long-path support without changing repository configuration', async t => {
  // Compact event refs must still exceed MAX_PATH in this explicit long workspace.
  const f = await fixture(t, {
    workspaceDirectory: join('long-snapshot-parent-'.repeat(7), 'workspace with spaces'),
  })
  git(f.workspace, '-c', 'core.longpaths=true', 'config', '--local', 'core.longpaths', 'false')
  assert.equal(await runGit(f.workspace, ['config', '--get', 'core.longpaths']), 'true')
  const start = await f.invoke(f.event(0, 'TurnStarted'))
  await writeFile(join(f.workspace, 'source.txt'), 'long-path change\n')
  const event = f.event(1)
  await f.invoke(event)
  const pending = await readJson(
    join(start.queue_path, 'pending', digest(event.event_id) + '.json')
  )
  assert.ok(
    pending.references.every(
      reference => join(f.workspace, '.git', reference + '.lock').length > 260
    )
  )
  await f.invoke(f.event(2, 'ExecutionCompleted'))
  await processQueue(start.queue_path)
  const found = await records(f.logs)
  assert.equal(found.length, 1)
  assert.match(await readFile(patchPath(f, found[0]), 'utf8'), /\+long-path change/)
  assert.equal(
    git(f.workspace, '-c', 'core.longpaths=true', 'config', '--local', '--get', 'core.longpaths'),
    'false'
  )
  assert.equal(
    git(
      f.workspace,
      '-c',
      'core.longpaths=true',
      'for-each-ref',
      '--format=%(refname)',
      'refs/wegent/turn-diff'
    ),
    ''
  )
})

test('normal callbacks launch detached workers and release accepted snapshot refs', async t => {
  const workers = []
  const processes = channel('child_process')
  const workerScript = fileURLToPath(new URL('./bin/log-turn.mjs', import.meta.url))
  const observe = ({ process: child }) => {
    child.once('spawn', () => {
      if (child.spawnargs[1] === workerScript) workers.push({ child, exited: once(child, 'exit') })
    })
  }
  processes.subscribe(observe)
  // Workers may outlive their last Git ref; join them before removing the fixture.
  t.after(async () => {
    processes.unsubscribe(observe)
    for (const { exited } of workers) assert.deepEqual(await exited, [0, null])
  })
  const f = await fixture(t)
  const invoke = async input => {
    const result = await handleEvent(input, f.config)
    for (const { child } of workers) child.ref()
    return result
  }
  await invoke(f.event(0, 'TurnStarted'))
  await writeFile(join(f.workspace, 'source.txt'), 'detached\n')
  await invoke(f.event(1))
  await invoke(f.event(2, 'ExecutionCompleted'))
  const deadline = Date.now() + 20000
  while (true) {
    const found = await records(f.logs)
    if (
      found.length === 1 &&
      git(f.workspace, 'for-each-ref', '--format=%(refname)', 'refs/wegent/turn-diff') === ''
    ) {
      assert.match(await readFile(patchPath(f, found[0]), 'utf8'), /\+detached/)
      break
    }
    if (Date.now() >= deadline) {
      try {
        for (const queue of await readdir(join(f.logs, 'queues'))) {
          const path = join(f.logs, 'queues', queue)
          console.error('[turn-diff-worker]', {
            log: await readFile(join(path, 'worker.log'), 'utf8'),
            pending: await readdir(join(path, 'pending')),
          })
        }
      } catch (error) {
        console.error('[turn-diff-worker] diagnostics failed:', error)
      }
    }
    assert.ok(Date.now() < deadline, 'Detached workers did not drain the queue')
    await delay(25)
  }
})

test('custom processors and archive callbacks retain jobs until consumption succeeds', async t => {
  for (const mode of ['stream', 'archive']) {
    const f = await fixture(t)
    const { queue_path: root } = await f.invoke(f.event(0, 'TurnStarted'))
    await writeFile(join(f.workspace, 'source.txt'), 'consumer payload\n')
    const event = f.event(1)
    await f.invoke(event)
    await f.invoke(f.event(2, 'ExecutionCompleted'))
    const pending = join(root, 'pending', digest(event.event_id) + '.json')
    const expected = await readJson(pending)
    let calls = 0
    const errors = []
    const consume = async value => {
      assert.deepEqual(await readJson(pending), expected)
      for (const reference of expected.references)
        assert.ok(git(f.workspace, 'rev-parse', '--verify', reference))
      if (mode === 'stream') {
        assert.deepEqual(value, expected)
        const chunks = []
        for await (const bytes of gitStream(f.workspace, ['diff', value.before, value.after]))
          chunks.push(bytes)
        assert.match(Buffer.concat(chunks).toString(), /\+consumer payload/)
      } else {
        assert.equal((await readJson(join(value, 'record.json'))).event.event_id, event.event_id)
      }
      if (++calls === 1) throw new Error('consumer unavailable')
    }
    await processQueue(root, {
      ...(mode === 'stream' ? { processJob: consume } : { onArchive: consume }),
      onError: (...fields) => errors.push(fields.at(-1)),
    })
    assert.equal(calls, 2)
    assert.deepEqual(errors, ['consumer unavailable'])
    assert.deepEqual(await readdir(join(root, 'pending')), [])
    assert.equal((await records(f.logs)).length, mode === 'stream' ? 0 : 1)
    assert.equal(
      git(f.workspace, 'for-each-ref', '--format=%(refname)', 'refs/wegent/turn-diff'),
      ''
    )
  }
})
