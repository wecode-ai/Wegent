import assert from 'node:assert/strict'
import { openStandInActivity } from './stand-in-profile-navigation.mjs'
import { storyUntil } from './stand-in-source-story-evidence.mjs'
import { DINGTALK_DELEGATION_IDS } from './stand-in-dingtalk-delegation-fixture.mjs'

const byId = id => `[data-testid="${id}"]`
const detail = byId('stand-in-work-preview')
const reason = byId('stand-in-delegation-result-reason')
const receipt = byId('stand-in-delegation-receipt')
const verify = `${detail} ${byId('stand-in-delegation-verify-delivery')}`
const takeover = `${detail} ${byId('stand-in-delegation-takeover')}`
const close = `${detail} ${byId('stand-in-preview-close')}`

export async function verifyDingTalkDelivery(
  control,
  { mailbox, work, automaticallyConfirmed, changed, pending, rejected, timeout }
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
  const clickInView = async selector => {
    await control.command('waitFor', selector)
    await control.command('scrollIntoView', selector, { visible: true })
    await control.command('clickWhenEnabled', selector, { visible: true })
  }
  const openResult = async record => {
    const items = await storyUntil(
      work,
      result => result.items.some(item => item.id === record.workId),
      timeout,
      `Delegated work ${record.workId} must be visible to the owner`
    )
    const item = items.items.find(row => row.id === record.workId)
    if ((await control.command('getElementCount', detail)) !== '0') await clickInView(close)
    await clickInView(byId(`stand-in-activity-task-${item.taskId}`))
    await control.command('waitFor', detail)
  }
  const assertNoReceipt = () => control.command('waitFor', receipt, { visible: false })

  await control.command('clickWhenEnabled', byId('personal-stand-in-button'))
  await control.command('clickWhenEnabled', byId('stand-in-primary-open'))
  await openStandInActivity(control)
  await control.command('waitFor', byId('stand-in-work-dialog'))
  const language = await control.command('getAttribute', 'html', { value: 'lang' })
  const labels = language?.startsWith('en')
    ? {
        failed: 'Reply failed to send',
        unknown: 'Reply delivery unconfirmed',
        takeover: 'Taken over by you',
        sent: 'Automatic reply sent',
      }
    : {
        failed: '答复发送失败',
        unknown: '答复送达待确认',
        takeover: '本人已接管',
        sent: '已自动答复',
      }
  for (const record of automaticallyConfirmed) {
    const recordId = record.id
    assert.equal(record.delegationResult.status, 'sent')
    assert.equal(record.delegationResult.channelTaskId, `task-${recordId}`)
    assert.deepEqual(await auditChecks(recordId), [
      [DINGTALK_DELEGATION_IDS.profile, false],
      [DINGTALK_DELEGATION_IDS.profile, true],
    ])
    await openResult(record)
    await control.command('waitFor', detail, { text: labels.sent })
    await control.command('waitFor', receipt, { text: `accepted-${recordId}` })
    await control.command('waitFor', verify, { visible: false })
    await assertSingleSubmission(record)
  }

  await openResult(changed)
  await control.command('waitFor', detail, { text: labels.failed })
  await control.command('waitFor', reason, { text: changed.delegationResult.reason, visible: true })
  await assertNoReceipt()

  await openResult(rejected)
  await control.command('waitFor', detail, { text: labels.failed })
  await assertNoReceipt()
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
  await openResult(pending)
  await control.command('waitFor', detail, { text: labels.unknown })
  await assertNoReceipt()
  await clickInView(takeover)
  await control.command('waitFor', detail, { text: labels.takeover })
  await control.command('waitFor', detail, { text: labels.unknown })
  await control.command('waitFor', takeover, { visible: false })

  await clickInView(verify)
  await storyUntil(
    () => readChecks(pendingId),
    checks => checks.length === automaticChecks.length + 1,
    timeout,
    'The first UI verification must query the recorded channel task'
  )
  await control.command('waitFor', verify, { enabled: true })
  await control.command('waitFor', detail, { text: labels.unknown })
  await assertNoReceipt()
  await assertSingleSubmission(pending)

  await mailbox.releaseMatchingReceipt()
  await clickInView(verify)
  await control.command('waitFor', receipt, { text: `accepted-${pendingId}` })
  await control.command('waitFor', detail, { text: labels.sent })
  await control.command('waitFor', detail, { text: labels.takeover })
  await control.command('waitFor', verify, { visible: false })
  await assertSingleSubmission(pending)
  assert.deepEqual((await auditChecks(pendingId)).slice(automaticChecks.length), [
    [DINGTALK_DELEGATION_IDS.profile, false],
    [DINGTALK_DELEGATION_IDS.profile, true],
  ])
  await clickInView(close)
  await clickInView(byId('stand-in-work-dialog-close'))
  return {
    automaticallyConfirmed: automaticallyConfirmed.map(record => record.id),
    channelTaskId,
    rejected: rejectedId,
    confirmed: pendingId,
    ownerTakeover: true,
  }
}
