import assert from 'node:assert/strict'
import { openStandInActivity, openStandInDetails } from './stand-in-profile-navigation.mjs'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createSourceStoryModel } from './stand-in-source-story-model.mjs'
import { readStoryTaskEvidence } from './stand-in-private-story-evidence.mjs'
import {
  STORY_CHAT,
  STORY_PRIMARY,
  STORY_USER,
  assertStoryPrimaryOutcome,
  openStoryPrimary,
  restoreSourceStory,
  startSourceStory,
  storyUntil,
} from './stand-in-source-story-evidence.mjs'

const MARKER = 'SOURCE_REPLY_STORY'
const ROLE = 'source-reply-story'
const PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'
const CARD = '[data-testid="request-user-input-card"]'
export const REPLY_STORY_VALUES = Object.fromEntries(
  [1, 2, 3].map(phase => [
    phase,
    {
      messageId: `${MARKER}-message-${phase}`,
      text: `${MARKER}: 请确认第${phase}项安排。`,
      reply: `第${phase}项安排已确认，我会按约定跟进。`,
      fact: `已回复第${phase}条原消息：第${phase}项安排已确认，我会按约定跟进。`,
      ...(phase === 1
        ? {
            mentionOpenDingTalkIds: ['source-story-colleague'],
            imageResourceId: '@source-story-image',
          }
        : {}),
    },
  ])
)

export function createDingTalkReplyStory(options) {
  const root = join(options.resultDir, 'dingtalk-story')
  const model = createSourceStoryModel({
    marker: MARKER,
    roleId: ROLE,
    providerId: PROVIDER,
    mode: 'reply',
    expected: phase => REPLY_STORY_VALUES[phase],
  })
  async function replies() {
    const value = await readFile(join(root, 'replies.jsonl'), 'utf8')
    return value
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  }
  async function publish(phase) {
    const value = REPLY_STORY_VALUES[phase]
    await writeFile(
      join(root, 'mentions.json'),
      JSON.stringify({
        success: true,
        result: {
          hasMore: false,
          nextCursor: '0',
          conversationMessagesList: [
            {
              singleChat: false,
              openConversationId: 'source-story-group',
              title: 'Source story group',
              messages: [
                {
                  openMessageId: value.messageId,
                  content: value.text,
                  senderOpenDingTalkId: 'source-story-sender',
                  sender: 'Source story sender',
                  createTime: new Date().toISOString(),
                  openConvThreadId: `story-topic-${phase}`,
                  sendType: 'user',
                },
              ],
            },
          ],
        },
      })
    )
  }
  async function pendingApproval(control, rpc, phase) {
    const work = await storyUntil(
      () => rpc('runtime.stand_in.work.list', { userId: STORY_USER }),
      value =>
        value.items.find(
          item =>
            item.roleId === ROLE &&
            item.task &&
            JSON.stringify(item).includes(`story-topic-${phase}`)
        ),
      options.modelResponseTimeoutMs,
      'The new mention must become its own authorized work'
    )
    const selected = work.items.find(
      item => item.roleId === ROLE && JSON.stringify(item).includes(`story-topic-${phase}`)
    )
    await openStoryPrimary(control)
    await control.command('clickWhenEnabled', `[data-testid="stand-in-overview-role-${ROLE}"]`)
    await openStandInActivity(control)
    await control.command(
      'clickWhenEnabled',
      `[data-testid="stand-in-activity-task-${selected.taskId}"]`
    )
    await control.command('waitFor', '[data-testid="stand-in-work-open-pending"]', {
      timeoutMs: options.modelResponseTimeoutMs,
    })
    await control.command('clickWhenEnabled', '[data-testid="stand-in-work-open-pending"]')
    await control.command('clickWhenEnabled', '[data-testid="interaction-open-original"]')
    await control.command('waitFor', CARD, { timeoutMs: options.modelResponseTimeoutMs })
    const preview = await control.command('getText', CARD, { visible: true })
    const source = await control.command('getText', '[data-testid="user-message-content"]', {
      visible: true,
    })
    assert.ok(source.includes(REPLY_STORY_VALUES[phase].text))
    assert.ok(source.includes('Source story group'))
    assert.ok(
      preview.includes(REPLY_STORY_VALUES[phase].reply),
      'Confirm the actual complete reply'
    )
    return selected
  }
  return {
    model,
    async prepareApp(context, baseline) {
      await baseline.prepareApp(context)
      const originalBinary = context.appEnvironment.DWS_BINARY_PATH
      assert.ok(originalBinary)
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'baseline-path.txt'), originalBinary)
      await writeFile(join(root, 'replies.jsonl'), '')
      await writeFile(
        join(root, 'image.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=',
          'base64'
        )
      )
      await writeFile(
        join(root, 'history.json'),
        JSON.stringify({
          contractVersion: 'im.message-list.v1',
          paginationKnown: true,
          hasMore: false,
          complete: true,
          failedCount: 0,
          failures: [],
          messages: [
            {
              messageId: 'source-story-image-message',
              conversationId: 'source-story-group',
              text: '[图片消息](mediaId=@source-story-image)',
              senderId: 'source-story-sender',
              sender: 'Colleague',
              createTime: new Date().toISOString(),
            },
          ],
        })
      )
      await writeFile(
        join(root, 'mentions.json'),
        JSON.stringify({
          success: true,
          result: { hasMore: false, nextCursor: '0', conversationMessagesList: [] },
        })
      )
      const preparedBinary = process.env.WEWORK_E2E_DWS_REPLY_FIXTURE_BIN
      const binary = join(
        options.resultDir,
        process.platform === 'win32' ? 'source-story-dws.exe' : 'source-story-dws'
      )
      if (preparedBinary) {
        await copyFile(preparedBinary, binary)
      } else {
        await promisify(execFile)('rustc', [
          fileURLToPath(new URL('../fixtures/source-story-dingtalk-cli.rs', import.meta.url)),
          '--edition',
          '2021',
          '-o',
          binary,
        ])
      }
      context.appEnvironment.DWS_BINARY_PATH = binary
    },
    async verify(control, rpc) {
      let original
      const database = new DatabaseSync(join(options.executorHome, 'data/tasks.sqlite'), {
        readOnly: true,
      })
      database.exec('PRAGMA busy_timeout = 10000')
      const sourceState = () =>
        database
          .prepare(
            "SELECT metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.source.providerId')=? AND json_extract(metadata,'$.source.id')=?"
          )
          .all(STORY_USER, PROVIDER, 'source-story-group')
          .map(row => JSON.parse(row.metadata))[0]
      try {
        await writeFile(join(root, 'active'), 'enabled')
        const page = await rpc('runtime.connections.resources', {
          providerId: PROVIDER,
          kind: 'group',
          query: 'Source story group',
        })
        assert.equal(page.items.length, 1)
        const prepared = await startSourceStory(
          control,
          rpc,
          options,
          model,
          {
            ...page.items[0],
            policy: { automatic: true, askBeforeAct: true, immediate: true },
          },
          ROLE
        )
        original = prepared.original
        await control.command('fill', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
          value: `${MARKER}-OWNER：看到这个群的新@时准备回复，每次发送让我确认。`,
        })
        await control.command('press', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
          key: 'Enter',
        })
        await control.command('waitFor', `${STORY_CHAT} [data-testid="message-assistant"]`, {
          text: '我会关注已选来源的新变化',
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await publish(1)
        const firstWork = await pendingApproval(control, rpc, 1)
        assert.equal(
          (await replies()).length,
          0,
          'There must be no reply before native one-time approval'
        )
        await options.captureScreenshot(control, 'source-story-dingtalk-once-confirmation.png')
        await control.command(
          'clickWhenEnabled',
          '[data-testid="request-user-input-option-__mcp_approval-0"]'
        )
        await assertStoryPrimaryOutcome(
          control,
          rpc,
          REPLY_STORY_VALUES[1].fact,
          options.modelResponseTimeoutMs
        )
        const firstTask = await rpc('runtime.tasks.get', { taskId: firstWork.taskId })
        assert.equal(firstTask.task.status, 'done')
        const firstEvidence = await readStoryTaskEvidence(options.executorHome, firstWork.taskId)
        assert.equal(firstEvidence.completion.status, 'done')
        assert.equal(firstEvidence.completion.turnId, firstEvidence.lastTurnId)
        assert.deepEqual(firstEvidence.completion.generation.reportTo, {
          userId: STORY_USER,
          taskId: STORY_PRIMARY,
        })
        assert.ok(
          firstEvidence.receipt,
          'The one-time reply outcome must have a durable primary-delivery receipt'
        )
        const afterOnce = await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })
        assert.equal(
          afterOnce.roles.find(item => item.id === ROLE).connections[0].policy.askBeforeAct,
          true,
          'Approving one reply must not create a continuing grant'
        )
        assert.equal((await replies()).length, 1)
        assert.equal((await replies())[0].mentions, 'source-story-colleague')
        const imagePath = (await readFile(join(root, 'download-path.txt'), 'utf8')).trim()
        assert.deepEqual(await readFile(imagePath), await readFile(join(root, 'image.png')))
        await rm(imagePath)
        model.phase = 2
        await publish(2)
        await pendingApproval(control, rpc, 2)
        assert.equal(
          (await replies()).length,
          1,
          'The next mention still requires a native decision'
        )
        model.nativeCancellationRequested = true
        await control.command(
          'clickWhenEnabled',
          '[data-testid="request-user-input-option-__mcp_approval-1"]'
        )
        await assertStoryPrimaryOutcome(
          control,
          rpc,
          '本次回复已取消，未发送。',
          options.modelResponseTimeoutMs
        )
        await openStoryPrimary(control)
        await control.command('fill', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
          value: `${MARKER}-CONTINUOUS：以后这个群的新@可以直接代为回复，不再逐次问我。`,
        })
        await control.command('press', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
          key: 'Enter',
        })
        await openStandInDetails(control)
        await control.command('waitFor', '[data-testid="stand-in-proposal-open"]', {
          timeoutMs: options.modelResponseTimeoutMs,
        })
        // The UI can show the proposal before the model consumes its tool result.
        await storyUntil(
          () => model.proposalSubmitted,
          submitted => submitted === true,
          options.modelResponseTimeoutMs,
          'The model must receive the persisted proposal before reviewing its grant'
        )
        assert.equal(model.proposalSubmitted, true)
        assert.equal(
          (await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })).roles.find(
            item => item.id === ROLE
          ).connections[0].policy.askBeforeAct,
          true
        )
        await control.command('clickWhenEnabled', '[data-testid="stand-in-proposal-open"]')
        await options.captureScreenshot(control, 'source-story-dingtalk-continuous-proposal.png')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-proposal-accept"]')
        const granted = await rpc('runtime.stand_in.personal.get', { userId: STORY_USER })
        assert.equal(
          granted.roles.find(item => item.id === ROLE).connections[0].policy.askBeforeAct,
          false
        )
        model.continuous = true
        model.phase = 3
        await publish(3)
        await assertStoryPrimaryOutcome(
          control,
          rpc,
          REPLY_STORY_VALUES[3].fact,
          options.modelResponseTimeoutMs
        )
        const sent = await replies()
        const latestWorks = await rpc('runtime.stand_in.work.list', { userId: STORY_USER })
        const automaticWork = latestWorks.items.find(
          item => item.roleId === ROLE && item.latestMessage?.id === REPLY_STORY_VALUES[3].messageId
        )
        assert.ok(automaticWork, 'The new mention must have its own actual source work')
        const automaticTask = await rpc('runtime.tasks.get', { taskId: automaticWork.taskId })
        assert.equal(
          automaticTask.task.status,
          'done',
          'A confirmed continuous grant must not wait for another user decision'
        )
        const automaticEvidence = await readStoryTaskEvidence(
          options.executorHome,
          automaticWork.taskId
        )
        assert.equal(automaticEvidence.completion.status, 'done')
        assert.equal(automaticEvidence.completion.turnId, automaticEvidence.lastTurnId)
        assert.deepEqual(automaticEvidence.completion.generation.reportTo, {
          userId: STORY_USER,
          taskId: STORY_PRIMARY,
        })
        assert.ok(
          automaticEvidence.receipt,
          'Automatic reply must return through the native result outbox'
        )
        assert.deepEqual(
          sent.map(item => item.messageId),
          [REPLY_STORY_VALUES[1].messageId, REPLY_STORY_VALUES[3].messageId]
        )
        assert.deepEqual(
          model.replies.map(item => item.phase),
          [1, 3]
        )
        assert.deepEqual(
          model.reads.map(item => item.phase),
          [1, 2, 3]
        )
        const after = sourceState().checkpoint.after
        await storyUntil(
          async () => sourceState(),
          value => value.checkpoint.after > after,
          options.modelResponseTimeoutMs,
          'Observe replay with the production collector after continuous delivery'
        )
        assert.equal(
          (await replies()).length,
          2,
          'Replayed mentions must never repeat external replies'
        )
        await assertStoryPrimaryOutcome(
          control,
          rpc,
          REPLY_STORY_VALUES[3].fact,
          options.modelResponseTimeoutMs
        )
        await options.captureScreenshot(
          control,
          'source-story-dingtalk-automatic-primary-result.png'
        )
        await writeFile(
          join(options.resultDir, 'dingtalk-reply-story-evidence.json'),
          JSON.stringify(
            {
              replies: sent,
              reads: model.reads,
              nativeReceipts: model.replies,
              continuingGrantVersion: granted.version,
            },
            null,
            2
          )
        )
      } finally {
        if (original) await restoreSourceStory(rpc, original, model)
        database.close()
        await rm(join(root, 'active'), { force: true })
      }
    },
  }
}
