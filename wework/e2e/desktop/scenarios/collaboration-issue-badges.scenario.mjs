import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  reloadMainWindow,
  waitForAttribute,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT_NAME = 'Issue badges regression'
const ISSUE_NAME = '评论链接写入 metadata badges'
const PR_URL = 'https://github.com/wecode-ai/Wegent/pull/4015'
const MR_URL = 'https://gitlab.example.test/group/sub/app/-/merge_requests/7'
const scoped = selector => `${CONTENT} ${selector}`

/** Real local storage and UI; status lookup is explicitly disabled through its preference. */
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('clickWhenEnabled', '[data-testid="settings-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('click', '[data-testid="settings-nav-git-hosting"]')
      const lookupSwitch = '[data-testid="change-request-status-switch"]'
      await control.command('waitFor', lookupSwitch)
      assert.equal(
        await control.command('getAttribute', lookupSwitch, { value: 'aria-checked' }),
        'true'
      )
      await control.command('click', lookupSwitch)
      await waitForAttribute(
        control,
        lookupSwitch,
        'aria-checked',
        'false',
        'PR lookup preference was not saved'
      )
      await control.command('click', '[data-testid="settings-back-button"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await createLocalCollaborationProject(control, CONTENT, PROJECT_NAME)
      await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: ISSUE_NAME,
      })
      await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
        value: `Review ${PR_URL}`,
      })
      await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-detail"]'))
      await control.command('fill', scoped('[data-testid="cloud-task-activity-composer"]'), {
        value: `Also review ${MR_URL}?view=changes and ${PR_URL}/files#diff. Ignore https://github.com/wecode-ai/Wegent/issues/1`,
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="task-comment-form"] [data-testid="send-message-button"]')
      )
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: 'Also review',
      })
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await control.command('waitFor', scoped('[data-testid^="cloud-todo-card-badges-"]'), {
        text: '!7',
      })
      const snapshot = JSON.parse(
        await control.command('snapshot', scoped('[data-testid="collaboration-board"]'))
      )
      const badgeSectionId = snapshot.testIds.find(id => id.startsWith('cloud-todo-card-badges-'))
      assert.ok(badgeSectionId, 'The actual project board did not render metadata badges')
      const badges = scoped(`[data-testid="${badgeSectionId}"]`)
      const assertBadges = async () => {
        await control.command('waitFor', badges, { text: '#4015', timeoutMs: uiTimeoutMs })
        await control.command('waitFor', badges, { text: '!7', timeoutMs: uiTimeoutMs })
        assert.equal(
          Number(
            await control.command('getElementCount', `${badges} [data-testid^="issue-badge-"]`)
          ),
          2,
          'Duplicate links or a non-PR URL produced extra badges'
        )
        assert.doesNotMatch(
          await control.command('getText', badges),
          /wecode-ai|group\/sub/,
          'The compact board badge exposed a repository name'
        )
      }
      await assertBadges()
      await captureScreenshot(control, 'collaboration-issue-badges-board.png', CONTENT)
      await reloadMainWindow(
        control,
        'The renderer did not reconnect after reloading persisted badges'
      )
      await assertBadges()
      const issueId = badgeSectionId.slice('cloud-todo-card-badges-'.length)
      await control.command('click', scoped(`[data-testid="cloud-todo-card-${issueId}"]`))
      await control.command('waitFor', scoped('[data-testid="issue-badges"]'), { text: '!7' })
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: 'Also review',
      })
      assert.equal(
        await control.command(
          'getAttribute',
          scoped(`[data-testid="issue-badges"] [data-testid="issue-badge-${PR_URL}"]`),
          { value: 'title' }
        ),
        '#4015',
        'Disabled lookup must retain the saved badge without live enrichment'
      )
    },
  }
}
