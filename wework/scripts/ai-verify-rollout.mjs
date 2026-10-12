import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function readRolloutHeader(source) {
  let prefix = Buffer.alloc(0)
  for await (const chunk of createReadStream(source)) {
    prefix = Buffer.concat([prefix, chunk])
    const newline = prefix.indexOf(10)
    if (newline < 0) continue
    const record = JSON.parse(prefix.subarray(0, newline).toString('utf8'))
    const threadId = record.payload?.id
    const timestamp = new Date(record.payload?.timestamp ?? record.timestamp)
    if (
      record.type !== 'session_meta' ||
      typeof threadId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(threadId) ||
      !Number.isFinite(timestamp.getTime())
    ) {
      throw new Error('Rollout must begin with session_meta containing a UUID and timestamp')
    }
    return { record, threadId, timestamp, bodyOffset: newline + 1 }
  }
  throw new Error('Rollout has no complete session_meta line')
}

/** Seed only a newly created AI verification session, before starting its Runtime. */
export async function seedAiVerifyRollout(source, sessionDirectory) {
  const { record, threadId, timestamp, bodyOffset } = await readRolloutHeader(source)
  const executorHome = join(sessionDirectory, 'executor-home')
  const codexHome = join(executorHome, 'codex')
  const projectKey = 'rollout-replay'
  const workspacePath = join(executorHome, 'workspace', 'projects', projectKey)
  const isoTime = timestamp.toISOString()
  const sessions = join(codexHome, 'sessions', ...isoTime.slice(0, 10).split('-'))
  const rolloutPath = join(
    sessions,
    `rollout-${isoTime.slice(0, 19).replaceAll(':', '-')}-${threadId}.jsonl`
  )
  await mkdir(sessions, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await mkdir(join(executorHome, 'runtime-work'), { recursive: true })
  // Only the copied session metadata changes. Historical records stay byte-identical.
  record.payload.cwd = workspacePath
  async function* replayRecords() {
    yield Buffer.from(`${JSON.stringify(record)}\n`)
    yield* createReadStream(source, { start: bodyOffset })
  }
  await pipeline(
    Readable.from(replayRecords()),
    createWriteStream(rolloutPath, { flags: 'wx', mode: 0o600 })
  )
  const taskId = `rollout-replay-${threadId}`
  await writeJson(join(executorHome, 'runtime-work', 'index.json'), {
    version: 1,
    tasks: {
      [taskId]: {
        local_task_id: taskId,
        thread_id: threadId,
        workspace_path: workspacePath,
        title: 'Rollout replay',
        runtime: 'codex',
        archived: false,
        continuable: true,
        created_at: timestamp.getTime(),
        updated_at: Date.now(),
        runtime_project_key: projectKey,
        runtime_workspace_roots: [workspacePath],
        runtime_handle: { runtime: 'codex', threadPath: rolloutPath, cloudTranscript: {} },
      },
    },
    workspaces: {},
  })
  await writeJson(join(codexHome, '.codex-global-state.json'), {
    'electron-saved-workspace-roots': [workspacePath],
    'electron-workspace-root-labels': { [workspacePath]: 'Rollout replay' },
    'local-projects': { [projectKey]: { id: projectKey, name: 'Rollout replay' } },
    'project-writable-roots': { [projectKey]: [{ kind: 'local', path: workspacePath }] },
    'thread-project-assignments': { [threadId]: { projectId: projectKey } },
    'thread-workspace-root-hints': { [threadId]: workspacePath },
  })
  return { taskId, threadId, projectName: 'Rollout replay', workspacePath, rolloutPath }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
}
