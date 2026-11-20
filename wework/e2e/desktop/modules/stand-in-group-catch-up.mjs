import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { storyUntil } from './stand-in-source-story-evidence.mjs'

export async function verifyStandInGroupCatchUp({ database, rpc, root, userId, providerId }) {
  const groupId = 'group-catch-up'
  const settings = await rpc('runtime.stand_in.personal.get', { userId })
  settings.primary.connections.push({
    providerId,
    id: groupId,
    name: groupId,
    profile: 'connection-test-account',
    kind: 'group',
    collectionKey: 'all-messages',
    policy: { automatic: false, askBeforeAct: true },
  })
  await rpc('runtime.stand_in.personal.save', { userId, settings })
  const query = database.prepare(
    "SELECT id, metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.source.id')=?"
  )
  const source = () => {
    const row = query.get(userId, groupId)
    return row && { id: row.id, state: JSON.parse(row.metadata) }
  }
  const row = await storyUntil(
    source,
    value => value?.state.checkpoint?.after,
    12_000,
    'The all-message group must establish its collection checkpoint'
  )
  const staleStart = new Date(Date.now() - 30 * 60_000).toISOString()
  const writeMessages = messages =>
    writeFile(
      join(root, 'group-catch-up-message.json'),
      JSON.stringify({
        success: true,
        result: {
          hasMore: false,
          nextCursor: '0',
          conversationMessagesList: [{ openConversationId: groupId, singleChat: false, messages }],
        },
      })
    )
  await writeMessages([])
  await writeFile(join(root, 'group-catch-up-start'), staleStart)
  // Resume the persisted five-minute checkpoint created after the first timeout.
  assert.equal(
    database
      .prepare(
        "UPDATE loop_items SET metadata=json_set(metadata,'$.checkpoint',json(?)) WHERE id=?"
      )
      .run(JSON.stringify({ after: staleStart, cursor: '0', windowMinutes: 5 }), row.id).changes,
    1
  )
  await storyUntil(
    () =>
      readFile(join(root, 'group-catch-up-requested'), 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error
        return null
      }),
    start => start === staleStart,
    20_000,
    'The collector must send the persisted stale window to the DingTalk fixture'
  )
  const recovered = await storyUntil(
    source,
    value => value?.state.error?.code === 'request_timeout',
    20_000,
    'The real collector must time out the stale group query'
  )
  assert.equal(recovered.state.checkpoint.windowMinutes, 1)
  assert.ok(Date.now() - Date.parse(recovered.state.checkpoint.after) < 6 * 60_000)

  const messageId = 'new-group-message-after-timeout'
  await writeMessages([
    {
      openMessageId: messageId,
      senderOpenDingTalkId: 'other',
      content: 'New group message after catch-up timed out',
      createTime: new Date().toISOString(),
      sendType: 'user',
    },
  ])
  await rpc('runtime.stand_in.source.retry', { userId, source: recovered.state.source })
  const message = database.prepare(
    "SELECT count(*) AS count FROM loop_items WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=? AND json_extract(metadata,'$.id')=?"
  )
  await storyUntil(
    () => ({ message: message.get(userId, messageId).count, error: source()?.state.error }),
    value => value.message === 1 && !value.error,
    22_000,
    'The fresh group message must reach durable intake after skipping stale backlog'
  )
}
