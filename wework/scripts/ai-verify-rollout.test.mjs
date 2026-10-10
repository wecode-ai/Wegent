import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readRolloutHeader, seedAiVerifyRollout } from './ai-verify-rollout.mjs'

const threadId = '01a11b55-7a67-7840-8100-42a64595ae0d'
const roots = []

async function fixture(record) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-rollout-replay-'))
  roots.push(directory)
  const source = join(directory, 'original.jsonl')
  const body = Buffer.from('{"type":"event_msg","payload":{"text":"历史🙂"}}\r\n')
  const bytes = Buffer.concat([Buffer.from(`${JSON.stringify(record)}\r\n`), body])
  await writeFile(source, bytes)
  return { directory, source, body, bytes }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('isolated rollout replay', () => {
  test('preserves the source and all history bytes while binding an isolated workspace', async () => {
    const data = await fixture({
      type: 'session_meta',
      timestamp: '2026-10-08T11:45:49.328Z',
      payload: { id: threadId, cwd: '/remote/project', instructions: '中文'.repeat(30_000) },
    })
    const session = join(data.directory, 'session')
    const replay = await seedAiVerifyRollout(data.source, session)
    const copy = await readFile(replay.rolloutPath)
    const separator = copy.indexOf(10)
    const header = JSON.parse(copy.subarray(0, separator))
    expect(header.payload.cwd).toBe(replay.workspacePath)
    expect(header.payload.id).toBe(threadId)
    expect(copy.subarray(separator + 1).equals(data.body)).toBe(true)
    expect((await readFile(data.source)).equals(data.bytes)).toBe(true)
    const index = JSON.parse(await readFile(join(session, 'executor-home/runtime-work/index.json')))
    expect(index.tasks[replay.taskId]).toMatchObject({
      thread_id: threadId,
      workspace_path: replay.workspacePath,
      runtime_handle: { cloudTranscript: {}, threadPath: replay.rolloutPath },
    })
    const state = JSON.parse(
      await readFile(join(session, 'executor-home/codex/.codex-global-state.json'))
    )
    expect(state['thread-project-assignments'][threadId]).toEqual({ projectId: 'rollout-replay' })
    expect(state['electron-workspace-root-labels'][replay.workspacePath]).toBe('Rollout replay')
    await expect(seedAiVerifyRollout(data.source, session)).rejects.toThrow('EEXIST')
  })

  test.each([
    { type: 'event_msg', payload: { id: threadId }, timestamp: '2026-10-08' },
    { type: 'session_meta', payload: { id: '../../outside' }, timestamp: '2026-10-08' },
    { type: 'session_meta', payload: { id: threadId }, timestamp: 'invalid' },
  ])('rejects invalid session metadata', async record => {
    const data = await fixture(record)
    await expect(seedAiVerifyRollout(data.source, join(data.directory, 'session'))).rejects.toThrow(
      'session_meta'
    )
  })

  test('rejects an incomplete metadata record before launching the application', async () => {
    const data = await fixture({})
    await writeFile(data.source, '{"type":"session_meta"')
    await expect(readRolloutHeader(data.source)).rejects.toThrow('no complete session_meta')
  })
})
