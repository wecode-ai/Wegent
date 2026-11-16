// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

vi.mock('../e2e/desktop/modules/preferences-automation-flows.mjs', () => ({
  ensureExperimentalFeaturesEnabled: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', () => ({
  createLocalCollaborationProject: vi.fn(),
  configureFirstProjectExecutionEnvironment: vi.fn(),
}))

import { createDesktopScenario } from '../e2e/desktop/scenarios/collaboration-issue-comment-mention.scenario.mjs'

const ISSUE_NAME = '评论 @ 成员必须弹出成员列表'
const TIMEOUT_MS = 1234

function fixture({ cardReady, title = ISSUE_NAME }) {
  let created = false
  let titleVerified = false
  let menuOpen = false
  let replyOpen = false
  let submissions = 0
  const captures = []
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'chooseWhenEnabled') return
      if (action === 'fill') {
        if (options.value === ISSUE_NAME) return
        assert.ok(titleVerified, 'The real Issue identity must be checked before mentioning')
        assert.equal(options.value, '@')
        menuOpen = true
        return
      }
      if (action === 'getElementCount') return menuOpen ? '1' : '0'
      if (action === 'getText') return '@Project member'
      if (action === 'snapshot') {
        const testIds = ['collaboration-issue-archive-open']
        if (cardReady) testIds.push('collaboration-issue-PRJ-1')
        if (menuOpen) testIds.push('collaboration-issue-mention-member-7')
        if (submissions) testIds.push('cloud-task-activity-reply-toggle-comment-1')
        if (replyOpen) testIds.push('issue-reply-composer')
        return JSON.stringify({ testIds })
      }
      if (action === 'click' || action === 'clickWhenEnabled') {
        assert.ok(
          !selector.includes('collaboration-issue-archive-open') &&
            !selector.includes('collaboration-issue-PRJ-1'),
          'Creation already opened the detail; board controls must not be clicked'
        )
        if (selector.includes('cloud-todo-create-confirm')) created = true
        if (selector.includes('collaboration-issue-mention-member-')) {
          assert.ok(menuOpen)
          menuOpen = false
        }
        if (selector.includes('cloud-task-activity-reply-toggle-')) replyOpen = true
        if (selector.includes('send-message-button')) {
          assert.ok(titleVerified)
          assert.ok(!menuOpen)
          submissions += 1
        }
        return
      }
      assert.equal(action, 'waitFor')
      if (selector.endsWith('[data-testid="cloud-todo-detail"]')) {
        assert.ok(created)
        assert.equal(options.visible, true)
        assert.equal(options.timeoutMs, TIMEOUT_MS)
      }
      if (selector.endsWith('[data-testid="cloud-todo-detail-title"]')) {
        assert.ok(created)
        assert.equal(options.timeoutMs, TIMEOUT_MS)
        assert.equal(options.value, ISSUE_NAME)
        assert.equal(title, options.value, 'The open detail belongs to another Issue')
        titleVerified = true
      }
      if (selector.endsWith('[data-testid="cloud-task-activity-list"]')) {
        assert.equal(submissions, 1)
        assert.equal(options.text, '@Project member')
      }
      if (selector.endsWith('[data-testid="cloud-task-activity-replies-comment-1"]')) {
        assert.equal(submissions, 2)
        assert.equal(options.text, '@Project member')
      }
    },
  }
  return {
    control,
    scenario: createDesktopScenario({
      uiTimeoutMs: TIMEOUT_MS,
      captureScreenshot: async (_, name) => captures.push(name),
    }),
    result: () => ({ submissions, captures, titleVerified }),
  }
}

test.each([false, true])(
  'mentions in both composers through the created detail when board card ready=%s',
  async cardReady => {
    const { control, scenario, result } = fixture({ cardReady })
    await scenario.verify(control)
    assert.equal(result().titleVerified, true)
    assert.equal(result().submissions, 2)
    assert.deepEqual(result().captures, [
      'collaboration-issue-comment-mention-01-popup.png',
      'collaboration-issue-comment-mention-02-card-reply.png',
    ])
  }
)

test('rejects another Issue detail before either mention composer is used', async () => {
  const { control, scenario, result } = fixture({ cardReady: true, title: 'Another Issue' })
  await assert.rejects(scenario.verify(control), /The open detail belongs to another Issue/)
  assert.equal(result().submissions, 0)
  assert.deepEqual(result().captures, [])
})
