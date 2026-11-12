// @vitest-environment node

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

vi.mock('../e2e/desktop/modules/preferences-automation-flows.mjs', () => ({
  ensureExperimentalFeaturesEnabled: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', () => ({
  createLocalCollaborationProject: vi.fn(),
  configureFirstProjectExecutionEnvironment: vi.fn(),
  reloadMainWindow: vi.fn(),
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
  let groupSelected = false
  let groupNamed = false
  let fullForm = false
  let mentionChip = false
  const captures = []
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'chooseWhenEnabled') {
        if (selector.includes('thread-create-group-select')) {
          assert.equal(options.value, '__new__')
          groupSelected = true
        }
        return
      }
      if (action === 'fill') {
        if (selector.includes('thread-create-new-group-name')) {
          assert.ok(groupSelected)
          assert.match(options.value, /^评论提及协作群-/)
          groupNamed = true
          return
        }
        if (options.value === ISSUE_NAME) {
          assert.ok(fullForm)
          return
        }
        assert.ok(titleVerified, 'The real Issue identity must be checked before mentioning')
        assert.equal(options.value, '@')
        menuOpen = true
        mentionChip = false
        return
      }
      if (action === 'getElementCount') return menuOpen ? '1' : '0'
      if (action === 'getText') {
        assert.ok(titleVerified)
        if (selector.includes('data-composer-reference-kind')) assert.ok(mentionChip)
        return '@Project member'
      }
      if (action === 'getAttribute') {
        if (selector.includes('group-reply-context')) {
          assert.ok(replyOpen)
          return 'comment-1'
        }
        assert.equal(submissions, 2)
        assert.equal(options.value, 'data-message-id')
        return 'reply-1'
      }
      if (action === 'hover') {
        assert.ok(selector.includes('group-message-comment-1'))
        return
      }
      if (action === 'snapshot') {
        const testIds = ['collaboration-issue-archive-open']
        if (cardReady) testIds.push('collaboration-issue-PRJ-1')
        if (menuOpen) testIds.push('collaboration-issue-mention-member-7')
        if (submissions) testIds.push('group-message-reply-comment-1')
        if (replyOpen) testIds.push('group-reply-context')
        return JSON.stringify({ testIds })
      }
      if (action === 'click' || action === 'clickWhenEnabled') {
        assert.ok(
          !selector.includes('collaboration-issue-archive-open') &&
            !selector.includes('collaboration-issue-PRJ-1'),
          'Creation already opened the detail; board controls must not be clicked'
        )
        if (selector.includes('thread-create-group-next')) {
          assert.ok(groupSelected && groupNamed)
          fullForm = true
        }
        if (selector.includes('cloud-todo-create-confirm')) {
          assert.ok(fullForm)
          created = true
        }
        if (selector.includes('collaboration-issue-mention-member-')) {
          assert.ok(menuOpen)
          menuOpen = false
          mentionChip = true
        }
        if (selector.includes('group-message-reply-')) {
          assert.equal(submissions, 1)
          replyOpen = true
        }
        if (selector.includes('group-message-send')) {
          assert.ok(titleVerified)
          assert.ok(!menuOpen)
          assert.ok(mentionChip)
          assert.equal(replyOpen, submissions === 1)
          submissions += 1
          assert.ok(submissions <= 2, 'Root and reply each submit exactly once')
          mentionChip = false
          replyOpen = false
        }
        return
      }
      assert.equal(action, 'waitFor')
      if (selector.endsWith('[data-testid="thread-room"]')) {
        assert.ok(created && fullForm)
        assert.equal(options.visible, true)
        assert.equal(options.timeoutMs, TIMEOUT_MS)
        assert.equal(options.text, ISSUE_NAME)
        assert.equal(title, options.text, 'The open detail belongs to another Issue')
        titleVerified = true
      }
      if (selector.includes('data-composer-reference-kind')) assert.ok(mentionChip)
      if (selector.endsWith('[data-testid="group-message-list"]')) {
        assert.equal(submissions, 1)
        assert.equal(options.text, '@Project member')
      }
      if (
        selector.includes('[data-message-id][data-reply-to-message-id="comment-1"]') ||
        selector.includes('group-message-quoted-reply-1')
      ) {
        assert.equal(submissions, 2)
        assert.equal(options.text, '@Project member')
      }
      if (selector.endsWith('[data-testid="group-reply-context"]')) {
        assert.equal(replyOpen, options.visible !== false)
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
      'collaboration-issue-comment-mention-03-reply-sent.png',
      'collaboration-issue-comment-mention-04-reply-persisted.png',
    ])
  }
)

test('rejects another Issue detail before either mention composer is used', async () => {
  const { control, scenario, result } = fixture({ cardReady: true, title: 'Another Issue' })
  await assert.rejects(scenario.verify(control), /The open detail belongs to another Issue/)
  assert.equal(result().submissions, 0)
  assert.deepEqual(result().captures, [])
})
