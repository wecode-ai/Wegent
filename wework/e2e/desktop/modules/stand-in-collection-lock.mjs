import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { storyUntil } from './stand-in-source-story-evidence.mjs'

/** Reproduce the persisted SQLite failure on an added assistant's all-contact subscription. */
export async function verifyCollectionLockRecovery({ database, rpc, root, userId, timeoutMs }) {
  const providerId = '@wegent/dsh-connection-dingtalk/dingtalk'
  const roleId = 'collection-lock-recovery'
  const originalSettings = await rpc('runtime.stand_in.personal.get', { userId })
  const settings = structuredClone(originalSettings)
  const role = {
    ...settings.primary,
    id: roleId,
    name: 'Collection lock recovery',
    enabled: true,
    executionDeviceId: settings.executionDeviceId,
    collaboration: {
      enabled: false,
      allProjects: false,
      projects: [],
      excludedProjects: [],
      tags: [],
      policy: { automatic: true, askBeforeAct: true, immediate: true },
    },
    connections: [
      {
        providerId,
        profile: 'connection-test-account',
        kind: 'direct',
        id: '*',
        scope: 'all',
        name: 'All direct messages',
        policy: { automatic: true, askBeforeAct: true, immediate: true },
      },
    ],
  }
  delete role.delegation
  settings.roles = [...(settings.roles ?? []).filter(existing => existing.id !== roleId), role]
  const saved = await rpc('runtime.stand_in.personal.save', { userId, settings })
  const sourceRow = () =>
    database
      .prepare(
        "SELECT id,metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.source.providerId')=? AND json_extract(metadata,'$.source.kind')='direct' AND json_extract(metadata,'$.source.scope')='all'"
      )
      .get(userId, providerId)
  const original = await storyUntil(
    async () => sourceRow(),
    row => !!row,
    timeoutMs,
    'All-contact intake must establish its original checkpoint'
  )
  const before = JSON.parse(original.metadata)
  assert.ok(before.checkpoint)
  assert.equal(
    database
      .prepare("UPDATE loop_items SET metadata=json_set(metadata,'$.error',json(?)) WHERE id=?")
      .run(
        JSON.stringify({
          code: 'stand_in_settings',
          message: 'local task database error: database is locked',
        }),
        original.id
      ).changes,
    1
  )
  const messageId = 'DIRECT_RECOVERY-collection-lock'
  await writeFile(
    join(root, 'messages.json'),
    JSON.stringify({
      success: true,
      result: {
        hasMore: false,
        nextCursor: '0',
        conversationMessagesList: [
          {
            singleChat: true,
            openConversationId: 'collection-lock-chat',
            messages: [
              {
                openMessageId: messageId,
                senderOpenDingTalkId: 'collection-lock-peer',
                sender: 'Collection lock regression',
                content: `${messageId}: [图片消息]为什么凌晨有 token 消耗？`,
                createTime: new Date().toISOString(),
                sendType: 'user',
              },
            ],
          },
        ],
      },
    })
  )
  const works = await storyUntil(
    () => rpc('runtime.stand_in.work.list', { userId }),
    value => value.items.some(item => item.source?.id === 'collection-lock-peer'),
    timeoutMs,
    'A transient database lock must not permanently stop all-contact direct message intake'
  )
  const work = works.items.find(item => item.source?.id === 'collection-lock-peer')
  assert.equal(work.roleId, roleId, 'All-contact intake belongs to an added assistant')
  await storyUntil(
    () => rpc('runtime.tasks.get', { taskId: work.taskId }),
    value => value.task?.status === 'done',
    timeoutMs,
    'Recovered intake must create and complete a real native task'
  )
  const after = JSON.parse(sourceRow().metadata)
  assert.equal(after.error, undefined)
  assert.equal(after.version, before.version)
  assert.ok(Date.parse(after.checkpoint.after) >= Date.parse(before.checkpoint.after))
  assert.equal(
    (await rpc('runtime.stand_in.personal.get', { userId })).version,
    saved.version,
    'Recovery must not require editing or resaving connection settings'
  )
  const messages = database
    .prepare(
      "SELECT count(*) AS count FROM loop_items WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.id')=?"
    )
    .get(userId, messageId)
  assert.equal(messages.count, 1, 'Recovered collection must deduplicate the source message')
  await rpc('runtime.stand_in.personal.save', {
    userId,
    settings: { ...originalSettings, version: saved.version },
  })
  return work
}
