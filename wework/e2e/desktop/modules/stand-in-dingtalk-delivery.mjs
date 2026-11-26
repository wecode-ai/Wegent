import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { storyUntil } from './stand-in-source-story-evidence.mjs'
import { DINGTALK_DELEGATION_IDS } from './stand-in-dingtalk-delegation-fixture.mjs'

const byId = id => `[data-testid="${id}"]`
const center = byId('stand-in-message-center')
const filter = `${center} ${byId('message-center-filter')}`
const detail = `${center} ${byId('message-center-detail')}`
const delivery = byId('message-center-detail-delivery')
const receipt = `${detail} section:has(> ${delivery})`
const verify = `${detail} ${byId('message-center-verify-delivery')}`
const takeover = `${detail} ${byId('message-center-take-over')}`
const close = `${detail} :is(${byId('message-center-detail-close')}, ${byId('message-center-detail-back')})`

export async function verifyDingTalkDelivery(
  control,
  { mailbox, automaticallyConfirmed, changed, pending, rejected, timeout }
) {
  const pendingId = pending.id
  const rejectedId = rejected.id
  const channelTaskId = `task-${pendingId}`
  assert.equal(pending.delegationResult.status, 'unknown')
  assert.equal(pending.delegationResult.channelTaskId, channelTaskId)
  assert.equal(pending.delegationResult.receiptId, null)
  assert.equal(rejected.delegationResult.status, 'failed')
  assert.equal(rejected.delegationResult.receiptId, null)

  const readChecks = async id =>
    (await mailbox.reads()).filter(
      row => row.operation === 'query-send-status' && row.taskId === `task-${id}`
    )
  const auditChecks = async id =>
    (await readChecks(id)).map(({ profile, matching }) => [profile, matching])
  const assertSingleSubmission = async record => {
    const attempts = (await mailbox.replies()).filter(row => row.messageId === record.id)
    assert.equal(attempts.length, 1, `${record.id} must submit only once`)
    assert.equal(attempts[0].uuid, record.delegationResult.attemptId)
  }
  const openResult = async (record, category) => {
    if ((await control.command('getElementCount', detail)) !== '0') {
      await control.command('clickWhenEnabled', close, { visible: true })
    }
    const selected = `${filter} [data-value="${category}"]`
    if ((await control.command('getElementCount', selected)) === '0') {
      await control.command('clickWhenEnabled', filter, { visible: true })
      await control.command('clickWhenEnabled', `[role="option"][data-value="${category}"]`, {
        visible: true,
      })
    }
    const row = byId(`message-center-record-${record.recordId}`)
    await control.command('clickWhenEnabled', `${center} ${row}`, { visible: true })
    await control.command('waitFor', detail, { text: record.text })
  }
  const assertNoReceipt = async record => {
    assert.doesNotMatch(
      await control.command('getText', receipt),
      labels.receiptKind,
      `${record.id} must not show a delivery receipt before confirmation`
    )
  }

  await ensureExperimentalFeaturesEnabled(control)
  await control.command('clickWhenEnabled', byId('personal-stand-in-button'))
  await control.command('clickWhenEnabled', byId('stand-in-message-center-open'))
  await control.command('waitFor', filter, { visible: true })
  const language = await control.command('getAttribute', 'html', { value: 'lang' })
  const labels = language?.startsWith('en')
    ? {
        failed: 'Delivery failed',
        receiptKind: /Channel receipt|Recipient verification/,
        unknown: 'Delivery unknown',
        takeover: 'Taken over by you',
        sent: 'Delivery confirmed',
      }
    : {
        failed: '投递失败',
        receiptKind: /渠道回执|收件端核验/,
        unknown: '结果未知',
        takeover: '本人已接管',
        sent: '已确认送达',
      }
  for (const record of automaticallyConfirmed) {
    const recordId = record.id
    assert.equal(record.delegationResult.status, 'sent')
    assert.equal(record.delegationResult.channelTaskId, `task-${recordId}`)
    assert.deepEqual(await auditChecks(recordId), [
      [DINGTALK_DELEGATION_IDS.profile, false],
      [DINGTALK_DELEGATION_IDS.profile, true],
    ])
    await openResult(record, 'replied')
    await control.command('waitFor', `${detail} ${delivery}`, { text: labels.sent })
    await control.command('waitFor', receipt, { text: `accepted-${recordId}` })
    await control.command('waitFor', verify, { visible: false })
    await assertSingleSubmission(record)
  }

  await openResult(changed, 'exceptions')
  await control.command('waitFor', `${detail} ${delivery}`, { text: labels.failed })
  await control.command('clickWhenEnabled', `${detail} ${byId('message-center-detail-process')}`)
  await control.command('waitFor', detail, { text: changed.delegationResult.reason, visible: true })
  await assertNoReceipt(changed)

  await openResult(rejected, 'exceptions')
  await control.command('waitFor', `${detail} ${delivery}`, { text: labels.failed })
  await assertNoReceipt(rejected)
  await control.command('waitFor', verify, { visible: false })
  await assertSingleSubmission(rejected)

  const automaticChecks = await storyUntil(
    () => readChecks(pendingId),
    checks => checks.length === 3,
    timeout,
    'Automatic checks must stop after three mismatched responses'
  )
  assert.ok(
    automaticChecks.every(row => row.profile === DINGTALK_DELEGATION_IDS.profile && !row.matching)
  )
  await openResult(pending, 'exceptions')
  await control.command('waitFor', `${detail} ${delivery}`, { text: labels.unknown })
  await assertNoReceipt(pending)
  await control.command('clickWhenEnabled', takeover)
  await control.command('waitFor', detail, { text: labels.takeover })
  await control.command('waitFor', `${detail} ${delivery}`, { text: labels.unknown })
  await control.command('waitFor', takeover, { visible: false })

  await control.command('clickWhenEnabled', verify)
  await storyUntil(
    () => readChecks(pendingId),
    checks => checks.length === automaticChecks.length + 1,
    timeout,
    'The first UI verification must query the recorded channel task'
  )
  await control.command('waitFor', verify, { enabled: true })
  await control.command('waitFor', `${detail} ${delivery}`, { text: labels.unknown })
  await assertNoReceipt(pending)
  await assertSingleSubmission(pending)

  await mailbox.releaseMatchingReceipt()
  await control.command('clickWhenEnabled', verify)
  await control.command('waitFor', receipt, { text: `accepted-${pendingId}` })
  await control.command('waitFor', `${detail} ${delivery}`, { text: labels.sent })
  await control.command('waitFor', detail, { text: labels.takeover })
  await control.command('waitFor', verify, { visible: false })
  await assertSingleSubmission(pending)
  assert.deepEqual((await auditChecks(pendingId)).slice(automaticChecks.length), [
    [DINGTALK_DELEGATION_IDS.profile, false],
    [DINGTALK_DELEGATION_IDS.profile, true],
  ])
  await control.command('clickWhenEnabled', close, { visible: true })
  return {
    automaticallyConfirmed: automaticallyConfirmed.map(record => record.id),
    channelTaskId,
    rejected: rejectedId,
    confirmed: pendingId,
    ownerTakeover: true,
  }
}
