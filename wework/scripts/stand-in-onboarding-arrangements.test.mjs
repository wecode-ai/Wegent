import assert from 'node:assert/strict'
import test from 'node:test'
import { onboardingArrangementIds } from '../e2e/desktop/scenarios/stand-in-profile-with-review.scenario.mjs'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import { bindDesktopOwner } from '../e2e/desktop/modules/desktop-owner-fixture.mjs'

bindDesktopOwner({ id: 37, user_name: 'onboarding-owner' })

test('onboarding and original processing dependencies remain in the existing CI profile group', () => {
  const catalog = loadDesktopCheckpointCatalog()
  assert.ok(catalog.ci.core_segments.includes('stand-in-profile'))
  for (const scenario of ['stand-in-processing', 'stand-in-onboarding-skip']) {
    assert.deepEqual(
      catalog.PATH_TARGETS.get(`wework/e2e/desktop/scenarios/${scenario}.scenario.mjs`),
      ['core:stand-in-profile']
    )
  }
})

const memoryReview = () => ({
  id: 'stand-in-memory-review-37',
  taskRequest: {
    standInOwner: { userId: 37, roleId: '@primary' },
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
  for (const id of ['weekly-review-37', 'stand-in-memory-review-38', 'unexpected']) {
    assert.notDeepEqual(onboardingArrangementIds([...baseline, { id }]), ['existing-arrangement'])
  }
})

test('a duplicate or mismatched memory default cannot be hidden from onboarding assertions', () => {
  assert.throws(() => onboardingArrangementIds([memoryReview(), memoryReview()]))
  for (const mutate of [
    item => {
      item.taskRequest.standInOwner.userId = 38
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
