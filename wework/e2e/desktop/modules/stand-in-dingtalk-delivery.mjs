import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { openStandInActivity } from './stand-in-profile-navigation.mjs'
import { openStoryPrimary, storyUntil } from './stand-in-source-story-evidence.mjs'
import { DINGTALK_DELEGATION_IDS } from './stand-in-dingtalk-delegation-fixture.mjs'

const byId = id => `[data-testid="${id}"]`
const preview = byId('stand-in-work-preview')
const receipt = `${preview} ${byId('stand-in-delegation-receipt')}`
const verify = `${preview} ${byId('stand-in-delegation-verify-delivery')}`
const takeover = `${preview} ${byId('stand-in-delegation-takeover')}`

export async function verifyDingTalkDelivery(
  control,
  { mailbox, work, automaticallyConfirmed, pending, rejected, timeout }
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
  const openResult = async record => {
    const current = (await work()).items.find(
      row => row.delegationResult?.recordId === record.recordId
    )
    assert.ok(current, `Delegated delivery ${record.id} must appear in the activity list`)
    await control.command('clickWhenEnabled', byId(`stand-in-activity-task-${current.taskId}`))
  }

  await ensureExperimentalFeaturesEnabled(control)
  await openStoryPrimary(control, timeout)
  await openStandInActivity(control)
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
    await control.command('waitFor', preview, { text: labels.sent })
    await control.command('waitFor', receipt, { text: `accepted-${recordId}` })
    await control.command('waitFor', verify, { visible: false })
    await assertSingleSubmission(record)
  }

  await openResult(rejected)
  await control.command('waitFor', preview, { text: labels.failed })
  await control.command('waitFor', receipt, { visible: false })
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
  await control.command('waitFor', preview, { text: labels.unknown })
  await control.command('waitFor', receipt, { visible: false })
  await control.command('clickWhenEnabled', takeover)
  await control.command('waitFor', preview, { text: labels.takeover })
  await control.command('waitFor', preview, { text: labels.unknown })
  await control.command('waitFor', takeover, { visible: false })

  await control.command('clickWhenEnabled', verify)
  await storyUntil(
    () => readChecks(pendingId),
    checks => checks.length === automaticChecks.length + 1,
    timeout,
    'The first UI verification must query the recorded channel task'
  )
  await control.command('waitFor', `${verify}[aria-busy="false"]`)
  await control.command('waitFor', preview, { text: labels.unknown })
  await control.command('waitFor', receipt, { visible: false })
  await assertSingleSubmission(pending)

  await mailbox.releaseMatchingReceipt()
  await control.command('clickWhenEnabled', verify)
  await control.command('waitFor', receipt, { text: `accepted-${pendingId}` })
  await control.command('waitFor', preview, { text: labels.sent })
  await control.command('waitFor', preview, { text: labels.takeover })
  await control.command('waitFor', verify, { visible: false })
  await assertSingleSubmission(pending)
  assert.deepEqual((await auditChecks(pendingId)).slice(automaticChecks.length), [
    [DINGTALK_DELEGATION_IDS.profile, false],
    [DINGTALK_DELEGATION_IDS.profile, true],
  ])
  await control.command('clickWhenEnabled', byId('stand-in-preview-close'))
  return {
    automaticallyConfirmed: automaticallyConfirmed.map(record => record.id),
    channelTaskId,
    rejected: rejectedId,
    confirmed: pendingId,
    ownerTakeover: true,
  }
}
