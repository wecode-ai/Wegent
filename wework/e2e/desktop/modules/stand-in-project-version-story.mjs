import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSourceStoryModel } from './stand-in-source-story-model.mjs'
import { readStoryTaskEvidence } from './stand-in-private-story-evidence.mjs'
import {
  STORY_CHAT,
  STORY_PRIMARY,
  STORY_USER,
  assertStoryPrimaryOutcome,
  restoreSourceStory,
  startSourceStory,
  storyUntil,
} from './stand-in-source-story-evidence.mjs'

const MARKER = 'PROJECT_VERSION_SOURCE_STORY'
const ROLE = 'project-version-story'
export const PROJECT_STORY_VALUES = {
  1: {
    version: `${MARKER}-passed`,
    text: `${MARKER}: PR #4335检查通过。`,
    fact: 'PR #4335检查通过，当前可继续评审。来源：versioned-record。',
  },
  2: {
    version: `${MARKER}-failed`,
    text: `${MARKER}: PR #4335的scope-regression检查失败，合并被阻塞。`,
    fact: 'PR #4335新增scope-regression检查失败，合并暂被阻塞，需要修复该项。来源：versioned-record。',
  },
}

export function createProjectVersionStory(options, providerId) {
  const model = createSourceStoryModel({
    marker: MARKER,
    roleId: ROLE,
    providerId,
    mode: 'project',
    expected: phase => PROJECT_STORY_VALUES[phase],
  })
  return {
    model,
    async verify(control, rpc, records) {
      const before = await readFile(records, 'utf8')
      const database = new DatabaseSync(join(options.executorHome, 'data/tasks.sqlite'), {
        readOnly: true,
      })
      database.exec('PRAGMA busy_timeout = 10000')
      const scope = `${MARKER}-${process.pid}`
      const read = kind =>
        database
          .prepare(
            "SELECT metadata FROM loop_items WHERE resource_type=? AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.source.collectionKey')=?"
          )
          .all(kind, STORY_USER, scope)
          .map(row => JSON.parse(row.metadata))
      const snapshot = () => ({
        events: read('stand_in_event'),
        source: read('stand_in_source')[0],
      })
      async function publish(phase) {
        const value = PROJECT_STORY_VALUES[phase]
        await writeFile(
          records,
          JSON.stringify([
            ...JSON.parse(before).filter(row => row.id !== 'versioned-record'),
            { id: 'versioned-record', version: value.version, value: value.text },
          ])
        )
      }
      let original
      try {
        await publish(1)
        const page = await rpc('runtime.connections.resources', {
          providerId,
          kind: 'record',
          query: 'versioned-record',
        })
        assert.equal(page.items.length, 1)
        const prepared = await startSourceStory(
          control,
          rpc,
          options,
          model,
          {
            ...page.items[0],
            collectionKey: scope,
            configurationSummary: 'PR #4335 only',
            policy: { automatic: true, askBeforeAct: false, immediate: true },
          },
          ROLE,
          // A source without a fixed role instruction is semantically assessed immediately.
          // This story covers automatic follow-up, not the separate silent aggregation window.
          { rolePrompt: '' }
        )
        original = prepared.original
        await control.command('fill', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
          value: `${MARKER}-OWNER：持续关注选定PR的新检查变化，把具体结论告诉我。`,
        })
        await control.command('press', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
          key: 'Enter',
        })
        await control.command('waitFor', `${STORY_CHAT} [data-testid="message-assistant"]`, {
          text: '我会关注已选来源的新变化',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await assertStoryPrimaryOutcome(
          control,
          rpc,
          PROJECT_STORY_VALUES[1].fact,
          options.modelResponseTimeoutMs
        )
        const first = await rpc('runtime.tasks.get', { taskId: model.taskId })
        assert.equal(first.task.status, 'done')
        const firstEvidence = await readStoryTaskEvidence(options.executorHome, model.taskId)
        const firstReceipt = firstEvidence.receipt
        assert.ok(firstReceipt, 'The first primary result needs a native durable outbox receipt')
        assert.equal(firstEvidence.completion.status, 'done')
        assert.equal(firstEvidence.completion.turnId, firstEvidence.lastTurnId)
        assert.deepEqual(firstEvidence.completion.generation.reportTo, {
          userId: STORY_USER,
          taskId: STORY_PRIMARY,
        })
        const firstThread = first.task.runtimeHandle.threadId
        model.phase = 2
        await publish(2)
        await assertStoryPrimaryOutcome(
          control,
          rpc,
          PROJECT_STORY_VALUES[2].fact,
          options.modelResponseTimeoutMs
        )
        const second = await rpc('runtime.tasks.get', { taskId: model.taskId })
        assert.equal(
          second.task.runtimeHandle.threadId,
          firstThread,
          'New source versions must continue the original conversation'
        )
        const secondEvidence = await readStoryTaskEvidence(options.executorHome, model.taskId)
        assert.ok(secondEvidence.receipt)
        assert.notEqual(secondEvidence.receipt, firstReceipt)
        assert.equal(second.task.status, 'done')
        assert.equal(secondEvidence.completion.status, 'done')
        assert.equal(secondEvidence.completion.turnId, secondEvidence.lastTurnId)
        assert.notEqual(secondEvidence.completion.turnId, firstEvidence.completion.turnId)
        assert.deepEqual(secondEvidence.completion.generation.reportTo, {
          userId: STORY_USER,
          taskId: STORY_PRIMARY,
        })
        const works = await rpc('runtime.stand_in.work.list', { userId: STORY_USER })
        assert.equal(works.items.filter(work => work.roleId === ROLE).length, 1)
        assert.ok(model.continuations.some(item => item.taskId === model.taskId))
        assert.deepEqual(
          model.reads.map(item => item.phase),
          [1, 2]
        )
        const collected = await storyUntil(
          async () => snapshot(),
          value => value.events.length === 2,
          options.modelResponseTimeoutMs,
          'Both real record revisions must be durably ingested'
        )
        const cursor = Number(collected.source.checkpoint.cursor)
        await storyUntil(
          async () => snapshot(),
          value => Number(value.source.checkpoint.cursor) > cursor,
          options.modelResponseTimeoutMs,
          'Observe one production collection replay'
        )
        assert.equal(snapshot().events.length, 2, 'Replaying v2 must not create another event')
        await assertStoryPrimaryOutcome(
          control,
          rpc,
          PROJECT_STORY_VALUES[2].fact,
          options.modelResponseTimeoutMs
        )
        assert.equal(
          (await rpc('runtime.stand_in.work.list', { userId: STORY_USER })).items.filter(
            work => work.roleId === ROLE
          ).length,
          1
        )
        await options.captureScreenshot(control, 'source-story-project-final-primary.png')
        await writeFile(
          join(options.resultDir, 'project-version-story-evidence.json'),
          JSON.stringify(
            {
              taskId: model.taskId,
              threadId: firstThread,
              reads: model.reads,
              continuations: model.continuations,
              events: snapshot().events.map(event => ({
                id: event.id,
                version: event.message?.version,
              })),
            },
            null,
            2
          )
        )
      } finally {
        if (original) await restoreSourceStory(rpc, original, model)
        database.close()
        await writeFile(records, before)
      }
    },
  }
}
