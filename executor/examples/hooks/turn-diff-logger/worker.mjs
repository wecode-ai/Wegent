import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, openSync } from 'node:fs'
import { mkdir, open, opendir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BUFFER_BYTES, git, pin, unpin, withLock } from './git.mjs'
import { digest, optionalJson, readJson, writeJson, syncDirectory } from './storage.mjs'

export async function startWorker(root) {
  const output = openSync(join(root, 'worker.log'), 'a', 0o600)
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./bin/log-turn.mjs', import.meta.url)), 'worker', root],
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', output, output],
      }
    )
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } finally {
    closeSync(output)
  }
}

async function artifact(path, format) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, {
    highWaterMark: BUFFER_BYTES,
  })) {
    bytes += chunk.length
    if (!Number.isSafeInteger(bytes)) throw new Error('Artifact exceeds exact byte range')
    hash.update(chunk)
  }
  const file = await open(path, 'r+')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  return {
    path: path.split(/[\\/]/).at(-1),
    format,
    size_bytes: bytes,
    sha256: hash.digest('hex'),
  }
}

async function* nulRecords(path) {
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(path, {
    highWaterMark: BUFFER_BYTES,
  })) {
    const bytes = Buffer.concat([tail, chunk])
    let start = 0
    for (let end; (end = bytes.indexOf(0, start)) >= 0; start = end + 1)
      yield bytes.subarray(start, end)
    tail = bytes.subarray(start)
    if (tail.length > BUFFER_BYTES) throw new Error('Git filename exceeds metadata limit')
  }
  if (tail.length) throw new Error('Incomplete Git numstat output')
}

async function fileMetadata(source, destination) {
  const file = await open(destination, 'wx', 0o600)
  const totals = { file_count: 0, additions: 0, deletions: 0 }
  try {
    for await (const row of nulRecords(source)) {
      const first = row.indexOf(9)
      const second = row.indexOf(9, first + 1)
      if (first < 1 || second < first + 2) throw new Error('Invalid Git numstat record')
      const add = row.subarray(0, first).toString('ascii')
      const del = row.subarray(first + 1, second).toString('ascii')
      const binary = add === '-' && del === '-'
      if (!binary && (!/^\d+$/.test(add) || !/^\d+$/.test(del)))
        throw new Error('Invalid line counts')
      const additions = binary ? 0 : Number(add)
      const deletions = binary ? 0 : Number(del)
      const name = row.subarray(second + 1)
      const decoded = name.toString('utf8')
      const path = Buffer.from(decoded).equals(name)
        ? { path: decoded }
        : { path_bytes_hex: name.toString('hex') }
      totals.file_count++
      totals.additions += additions
      totals.deletions += deletions
      if (![additions, deletions, ...Object.values(totals)].every(Number.isSafeInteger))
        throw new Error('Line count exceeds exact integer range')
      await file.writeFile(JSON.stringify({ ...path, additions, deletions, binary }) + '\n')
    }
    await file.sync()
  } finally {
    await file.close()
  }
  return totals
}

async function archive(root, records, job) {
  const id = digest(job.input.event_id)
  const destination = join(records, id)
  const existing = await optionalJson(join(destination, 'record.json'))
  if (existing) {
    if (
      existing.event.event_id !== job.input.event_id ||
      existing.git_url !== job.git_url ||
      existing.before_tree !== job.before ||
      existing.after_tree !== job.after
    ) {
      throw new Error('Conflicting archived event')
    }
    for (const [key, name, format] of [
      ['diff', 'diff.patch', 'git-patch'],
      ['files', 'files.jsonl', 'jsonl'],
    ]) {
      const actual = await artifact(join(destination, name), format)
      if (
        actual.sha256 !== existing.artifacts[key]?.sha256 ||
        actual.size_bytes !== existing.artifacts[key]?.size_bytes
      ) {
        throw new Error('Archived artifact integrity mismatch')
      }
    }
    return
  }
  const temporary = join(records, '.' + id + '-' + randomUUID() + '.tmp')
  await mkdir(temporary, { mode: 0o700 })
  try {
    const options = { hooks: join(root, 'empty-hooks') }
    const common = [
      '--attr-source=' + job.after,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
    ]
    await git(job.workspace, [...common, '--binary', '--full-index', job.before, job.after, '--'], {
      ...options,
      output: join(temporary, 'diff.patch'),
    })
    const numstat = join(temporary, 'numstat.tmp')
    await git(job.workspace, [...common, '--numstat', '-z', job.before, job.after, '--'], {
      ...options,
      output: numstat,
    })
    const totals = await fileMetadata(numstat, join(temporary, 'files.jsonl'))
    await rm(numstat)
    const artifacts = {
      diff: await artifact(join(temporary, 'diff.patch'), 'git-patch'),
      files: await artifact(join(temporary, 'files.jsonl'), 'jsonl'),
    }
    await writeJson(join(temporary, 'record.json'), {
      schema_version: 1,
      event: job.input,
      captured_at: job.captured_at,
      workspace: job.workspace,
      git_url: job.git_url,
      before_tree: job.before,
      after_tree: job.after,
      ...totals,
      artifacts,
    })
    await syncDirectory(temporary)
    await rename(temporary, destination)
    await syncDirectory(records)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function hasPending(root) {
  for await (const entry of await opendir(join(root, 'pending'))) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) return true
  }
  return false
}

export async function processQueue(root) {
  while (true) {
    if (!(await drainQueue(root))) return
  }
}

async function drainQueue(root) {
  const { workspace, records } = await readJson(join(root, 'workspace.json'))
  const hooks = join(root, 'empty-hooks')
  const acquired = await withLock(
    workspace,
    'refs/wegent/turn-diff/worker-' + digest(root),
    hooks,
    async () => {
      let backoff = 1000
      while (true) {
        let failed = false
        for await (const entry of await opendir(join(root, 'pending'))) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
          try {
            const path = join(root, 'pending', entry.name)
            const job = await readJson(path)
            await archive(root, records, job)
            const execution = digest(job.input.execution_id)
            const reference = 'refs/wegent/turn-diff/' + digest(root) + '/' + execution
            await withLock(workspace, reference + '-capture-lock', hooks, async () => {
              const state = await readJson(join(root, 'executions', execution, 'state.json'))
              // A producer may die after queue publication but before baseline
              // publication. Keep the persisted state's tree reachable.
              if (state.closed) await unpin(workspace, state.reference, hooks)
              else await pin(workspace, state.reference, state.tree, hooks)
              for (const reference of job.references) await unpin(workspace, reference, hooks)
              await rm(path)
              await syncDirectory(join(root, 'pending'))
            })
          } catch (error) {
            failed = true
            console.error(new Date().toISOString(), entry.name, error.message)
          }
        }
        if (!(await hasPending(root))) break
        if (failed) {
          await delay(backoff)
          backoff = Math.min(backoff * 2, 60000)
        }
      }
    },
    { wait: false }
  )
  // Recheck late enqueues in the same worker so its exit covers all accepted work.
  return acquired && (await hasPending(root))
}
