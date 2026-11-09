import assert from 'node:assert/strict'
import test from 'node:test'
import { onboardingArrangementIds } from '../e2e/desktop/scenarios/stand-in-profile-with-review.scenario.mjs'

const memoryReview = () => ({
  id: 'stand-in-memory-review-9001',
  taskRequest: {
    standInOwner: { userId: 9001, roleId: '@primary' },
    standInCalendar: { template: 'memory_review' },
  },
  conversationMode: 'independent',
  notificationPolicy: 'attention_only',
})

test('onboarding assertions retain every arrangement except the exact native memory default', () => {
  const baseline = [{ id: 'existing-arrangement' }]
  assert.deepEqual(onboardingArrangementIds(baseline), ['existing-arrangement'])
  assert.deepEqual(onboardingArrangementIds([...baseline, memoryReview()]), [
    'existing-arrangement',
  ])
  for (const id of ['weekly-review-9001', 'stand-in-memory-review-9002', 'unexpected']) {
    assert.notDeepEqual(onboardingArrangementIds([...baseline, { id }]), ['existing-arrangement'])
  }
})

test('a duplicate or mismatched memory default cannot be hidden from onboarding assertions', () => {
  assert.throws(() => onboardingArrangementIds([memoryReview(), memoryReview()]))
  for (const mutate of [
    item => {
      item.taskRequest.standInOwner.userId = 9002
    },
    item => {
      item.taskRequest.standInOwner.roleId = 'other'
    },
    item => {
      item.taskRequest.standInCalendar.template = 'weekly_review'
    },
    item => {
      item.conversationMode = 'reuse'
    },
    item => {
      item.notificationPolicy = 'always'
    },
  ]) {
    const item = memoryReview()
    mutate(item)
    assert.throws(() => onboardingArrangementIds([item]))
  }
})
