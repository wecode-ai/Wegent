import assert from 'node:assert/strict'
import test from 'node:test'

import { createTranscriptTarget, readExecutorTurn } from './index.js'

const locator = {
  transcriptId: 'task-1',
  taskId: 'task-1',
  title: 'Task',
  sequence: 1,
  turnId: 'turn-1',
  sessionId: 'session-1',
  executorTurnId: 'executor-turn-1',
}

test('reads a finalized turn directly from the Executor transcript', async () => {
  const requests = []
  const client = {
    async request(method, params) {
      assert.equal(method, 'runtime.tasks.transcript')
      requests.push(params)
      if (!params.beforeCursor) {
        return {
          turns: [{ id: 'newer-turn', status: 'done', items: [] }],
          hasMoreBefore: true,
          beforeCursor: 'older-page',
        }
      }
      return {
        turns: [
          {
            id: 'executor-turn-1',
            status: 'done',
            items: [
              {
                id: 'user-item',
                type: 'user_message',
                message: {
                  id: 'user-1',
                  content: 'Continue on another device',
                },
              },
              {
                id: 'reasoning-1',
                type: 'reasoning',
                summary: ['Inspect', ' evidence'],
              },
              {
                id: 'assistant-1',
                type: 'assistant_text',
                content: 'Done',
              },
            ],
          },
        ],
      }
    },
  }

  const turn = await readExecutorTurn(client, locator)

  assert.deepEqual(requests, [
    { taskId: 'task-1', limit: 100 },
    { taskId: 'task-1', limit: 100, beforeCursor: 'older-page' },
  ])
  assert.deepEqual(turn.payload, {
    userMessages: [{ id: 'user-1', text: 'Continue on another device' }],
    assistantMessage: 'Done',
    reasoning: 'Inspect evidence',
    completion: { kind: 'completed' },
  })
})

test('resolves a legacy sequence locator only after collecting all transcript pages', async () => {
  const client = {
    async request(_method, params) {
      if (!params.beforeCursor) {
        return {
          turns: [{ id: 'executor-turn-3', status: 'done', items: [] }],
          hasMoreBefore: true,
          beforeCursor: 'older-page',
        }
      }
      return {
        turns: [
          { id: 'executor-turn-1', status: 'done', items: [] },
          {
            id: 'executor-turn-2',
            status: 'done',
            items: [{ type: 'assistant_text', content: 'Second turn' }],
          },
        ],
      }
    },
  }

  const turn = await readExecutorTurn(client, {
    ...locator,
    sequence: 2,
    executorTurnId: undefined,
  })

  assert.equal(turn.payload.assistantMessage, 'Second turn')
})

test('routes downloaded and acknowledged turns into the Executor native transcript APIs', async () => {
  const requests = []
  const client = {
    async request(method, params) {
      requests.push({ method, params })
      return { available: true, importedThrough: params.sequence ?? 2 }
    },
  }
  const target = createTranscriptTarget(client)
  const transcript = { transcriptId: 'shared-transcript', taskId: 'local-task' }
  const turns = [{ turnId: 'turn-2', sequence: 2, payload: { assistantMessage: 'Done' } }]

  await target.status(transcript)
  await target.import(transcript, turns)
  await target.acknowledge({
    ...transcript,
    cloudSequence: 3,
    parentTranscriptId: 'mainline',
  })

  assert.deepEqual(requests, [
    {
      method: 'runtime.tasks.transcript.sync_status',
      params: { transcriptId: 'shared-transcript', taskId: 'local-task' },
    },
    {
      method: 'runtime.tasks.transcript.import',
      params: { transcriptId: 'shared-transcript', taskId: 'local-task', turns },
    },
    {
      method: 'runtime.tasks.transcript.acknowledge',
      params: {
        transcriptId: 'shared-transcript',
        taskId: 'local-task',
        sequence: 3,
        parentTranscriptId: 'mainline',
      },
    },
  ])
})
