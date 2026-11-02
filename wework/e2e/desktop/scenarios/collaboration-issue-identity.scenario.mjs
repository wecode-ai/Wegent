// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createCollaborationBoardIssue } from '../modules/collaboration-board-issue.mjs'
import {
  createLocalCollaborationProject,
  reloadMainWindow,
  selectCollaborationProjectView,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await createLocalCollaborationProject(control, CONTENT, 'Issue identity regression')
      const issueId = await createCollaborationBoardIssue(
        control,
        'Followed local issue',
        'pending',
        uiTimeoutMs
      )
      await control.command('click', scoped(`[data-testid="cloud-todo-card-${issueId}"]`))
      const follow = scoped('[data-testid="cloud-todo-follow"]')
      await control.command('waitFor', follow, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command(
        'waitFor',
        scoped('[data-testid="cloud-todo-detail"] header [data-testid="cloud-todo-detail-status"]'),
        { visible: true, timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="cloud-todo-state-summary"] button[aria-label="时间范围"]'),
        { visible: true, timeoutMs: uiTimeoutMs }
      )
      assert.equal(
        (await control.command('getText', follow)).trim(),
        '',
        'Following must remain an icon-only header action'
      )
      assert.equal(
        await control.command('getAttribute', follow, { value: 'aria-pressed' }),
        'false'
      )
      await control.command('click', follow)
      await control.command('waitFor', `${follow}[aria-pressed="true"]`, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(await control.command('getAttribute', follow, { value: 'aria-pressed' }), 'true')
      assert.equal(
        await control.command(
          'getAttribute',
          scoped('[data-testid="cloud-todo-detail-assignee"]'),
          { value: 'data-value' }
        ),
        ''
      )
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await reloadMainWindow(control, 'The renderer did not reconnect after following an Issue')
      await control.command('click', scoped(`[data-testid="cloud-todo-card-${issueId}"]`))
      await control.command('waitFor', follow, { visible: true, timeoutMs: uiTimeoutMs })
      assert.equal(await control.command('getAttribute', follow, { value: 'aria-pressed' }), 'true')
      const more = scoped('[data-testid="cloud-todo-more-properties"]')
      const properties = '[data-testid="cloud-todo-more-properties-popover"]'
      await control.command('click', more)
      await control.command('waitFor', properties, { visible: true, timeoutMs: uiTimeoutMs })
      const creator = await control.command(
        'getText',
        `${properties} [data-testid="cloud-todo-identity-creator"]`
      )
      assert.doesNotMatch(creator, /—/, 'Local Issue creator must be displayed')
      await control.command('click', more)
      await control.command('waitFor', properties, { visible: false, timeoutMs: uiTimeoutMs })
      await control.command('click', scoped('[data-testid="cloud-todo-assign-to-me"]'))
      await control.command(
        'waitFor',
        scoped('[data-testid="cloud-todo-detail-assignee"][data-value^="user:"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', '[data-testid="wework-notifications-unread"]', {
        timeoutMs: Math.max(uiTimeoutMs, 30000),
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('waitFor', '[data-testid="wework-notifications-collaboration-list"]', {
        text: 'Followed local issue',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await selectCollaborationProjectView(control, CONTENT, 'table')
      await control.command(
        'click',
        scoped('[data-testid="collaboration-issue-table-following-filter"]')
      )
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-table"]'), {
        text: 'Followed local issue',
        timeoutMs: uiTimeoutMs,
      })
    },
  }
}
