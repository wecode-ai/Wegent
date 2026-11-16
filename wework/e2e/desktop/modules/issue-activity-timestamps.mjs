import assert from 'node:assert/strict'

import { readProjectChatMessages } from './project-chat-snapshot.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const list = `${CONTENT} [data-testid="cloud-task-activity-list"]`

function instant(value) {
  assert.equal(typeof value, 'string', 'Activity must expose a timestamp')
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`)
  assert.ok(Number.isFinite(parsed), `Invalid activity timestamp: ${value}`)
  return parsed
}

function assertWithinRun(value, startedAt, receivedAt, label) {
  const timestamp = instant(value)
  assert.ok(
    timestamp >= startedAt - 1000 && timestamp <= receivedAt + 1000,
    `${label} has a timezone-sized shift: ${value}`
  )
  return timestamp
}

/** Check actual member records, displayed local time and persisted timeline order. */
export async function verifyIssueActivityTimestamps(
  control,
  { backendUrl, authToken, projectId, issueId, creationStartedAt, phase, timeoutMs }
) {
  const messages = await readProjectChatMessages(
    { backendUrl, authToken, projectId },
    issueId,
    timeoutMs
  )
  const receivedAt = Date.now()
  const members = messages.filter(message => message.metadata.activity_type === 'member_execution')
  assert.equal(members.length, 2, `${phase}: both independent member activities must be persisted`)
  const cardIds = new Set()
  const displayedInstants = new Map()
  for (const message of members) {
    const createdAt = assertWithinRun(message.createdAt, creationStartedAt, receivedAt, 'createdAt')
    const updatedAt = assertWithinRun(message.updatedAt, creationStartedAt, receivedAt, 'updatedAt')
    assert.ok(updatedAt >= createdAt - 1000, `${message.messageId}: update precedes creation`)
    const cardId = `cloud-task-activity-card-${message.messageId}`
    cardIds.add(cardId)
    const time = `${list} [data-testid="${cardId}"] .task-detail-thread-actions > time`
    await control.command('waitFor', time, { timeoutMs })
    const value = await control.command('getAttribute', time, { value: 'datetime' })
    const displayed = assertWithinRun(value, creationStartedAt, Date.now(), 'displayed activity')
    displayedInstants.set(cardId, displayed)
    // This scenario runs in Asia/Shanghai, which has a fixed UTC+8 offset.
    const expected = new Date(displayed + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(5, 16)
      .replace('T', ' ')
    assert.equal((await control.command('getText', time)).trim(), expected)
  }
  const order = JSON.parse(await control.command('getTestIdOrder', list))
  const creationIndex = order.indexOf('cloud-task-status-event-0')
  assert.ok(creationIndex >= 0, 'Issue creation must remain in the timeline')
  const orderedCards = order.filter(id => cardIds.has(id))
  assert.equal(orderedCards.length, members.length, 'Each member must render exactly once')
  for (let index = 0; index < orderedCards.length; index += 1) {
    assert.ok(
      order.indexOf(orderedCards[index]) > creationIndex,
      'A member execution must not appear before Issue creation'
    )
    if (index > 0) {
      assert.ok(
        displayedInstants.get(orderedCards[index - 1]) <=
          displayedInstants.get(orderedCards[index]),
        `Member activities are not chronological: ${orderedCards}`
      )
    }
  }
}
