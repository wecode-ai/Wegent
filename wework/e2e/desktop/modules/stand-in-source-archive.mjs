import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'
import {
  restoreSourceStory,
  startSourceStory,
  storyUntil,
  STORY_USER,
} from './stand-in-source-story-evidence.mjs'

const MARKER = 'SOURCE_ARCHIVE_REGRESSION'
const ROLE = 'source-archive-regression'

/** Reuse the real source plugin, durable inbox and native task lifecycle; script only the model. */
export function createSourceArchiveRegression(options, providerId) {
  const state = { active: false, marker: MARKER }
  return {
    get active() {
      return state.active
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (isReplyPredictionRequest(body)) return false
      if (handleModelMaintenanceRequest(body, response)) return true
      if (!JSON.stringify(body.input).includes(MARKER)) return false
      const id = `archive-regression-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(`${MARKER}: processed`),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control, rpc, records) {
      const before = await readFile(records, 'utf8')
      let original
      let archivedTaskId
      const messages = []
      const publish = async (id, quotedMessageId) => {
        messages.push({
          id,
          eventType: 'message.received',
          text: `${MARKER}: ${id}`,
          at: new Date().toISOString(),
          ...(quotedMessageId ? { quotedMessageId } : {}),
        })
        await writeFile(
          records,
          JSON.stringify([
            ...JSON.parse(before),
            { id: 'archive-record', value: JSON.stringify(messages) },
          ])
        )
      }
      const works = async () =>
        (await rpc('runtime.stand_in.work.list', { userId: STORY_USER })).items.filter(
          work => work.roleId === ROLE
        )
      const settled = async (count, messageCount, messageId) =>
        storyUntil(
          async () => {
            const items = await works()
            const latest = items.find(
              work => work.messageCount === messageCount && work.taskId !== archivedTaskId
            )
            const task = latest && (await rpc('runtime.tasks.get', { taskId: latest.taskId }))
            const transcript =
              task?.task?.status === 'done'
                ? await rpc('runtime.tasks.transcript', { taskId: latest.taskId, limit: 100 })
                : null
            return { items, latest, task, transcript }
          },
          value =>
            value.items.length === count &&
            value.task?.task?.status === 'done' &&
            value.transcript?.messages?.some(
              message =>
                message.role === 'user' && message.content?.includes(`${MARKER}: ${messageId}`)
            ),
          options.modelResponseTimeoutMs,
          'New source messages must execute and reuse the current unarchived work'
        )
      try {
        await writeFile(
          records,
          JSON.stringify([...JSON.parse(before), { id: 'archive-record', value: '[]' }])
        )
        const page = await rpc('runtime.connections.resources', {
          providerId,
          kind: 'record',
          query: 'archive-record',
        })
        const prepared = await startSourceStory(
          control,
          rpc,
          options,
          state,
          {
            ...page.items[0],
            policy: {
              automatic: true,
              immediate: true,
              askBeforeAct: false,
              sessionStrategy: 'reuse',
            },
          },
          ROLE
        )
        original = prepared.original
        await publish('first')
        const firstResult = await settled(1, 1, 'first')
        const first = firstResult.latest
        assert.equal((await rpc('runtime.tasks.archive', { taskId: first.taskId })).accepted, true)
        archivedTaskId = first.taskId
        await publish('second', 'first')
        const secondResult = await settled(2, 1, 'second')
        const second = secondResult.latest
        assert.notEqual(second.taskId, first.taskId)
        const thread = result => result.task.task.runtimeHandle.threadId
        assert.ok(thread(firstResult))
        assert.ok(thread(secondResult))
        assert.notEqual(thread(secondResult), thread(firstResult))
        await publish('third')
        const thirdResult = await settled(2, 2, 'third')
        const reused = thirdResult.latest
        assert.equal(reused.taskId, second.taskId)
        assert.equal(thread(thirdResult), thread(secondResult))
        assert.equal(
          (await rpc('runtime.tasks.get', { taskId: first.taskId })).code,
          'task_archived'
        )
        const history = await rpc('runtime.stand_in.work.messages', {
          userId: STORY_USER,
          workId: first.id,
        })
        assert.deepEqual(
          history.messages.map(message => message.id),
          ['first']
        )
        const current = await rpc('runtime.stand_in.work.messages', {
          userId: STORY_USER,
          workId: second.id,
        })
        assert.deepEqual(current.messages.map(message => message.id).sort(), ['second', 'third'])
      } finally {
        if (original) await restoreSourceStory(rpc, original, state)
        await writeFile(records, before)
      }
    },
  }
}
