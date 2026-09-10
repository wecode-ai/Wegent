// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = {
  id: '896185331840201899',
  public_id: 'e2e-collaboration-shared-core',
  project_key: 'SHARED',
  name: '协作共享核心',
  description: 'Web 与 Wework 使用同一协作领域组件',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 9001,
  current_user_id: 9001,
  current_user_name: 'admin',
  access_role: 'Owner',
  visibility: 'private',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-10T00:00:00',
  updated_at: '2026-09-10T00:00:00',
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [PROJECT] })
        return true
      }
      if (request.method === 'GET' && url.pathname === `/api/v1/cloud-projects/${PROJECT.id}`) {
        json(response, 200, PROJECT)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${PROJECT.id}/board-snapshot`
      ) {
        json(response, 200, { items: [], task_bindings: [], members: [], agents: [] })
        return true
      }
      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command(
        'waitFor',
        '[data-testid="wework-collaboration-workspace"] [data-testid="collaboration-root"]',
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', '[data-testid="collaboration-project-list"]', {
        timeoutMs: uiTimeoutMs,
      })
      const homeSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      const projectTestId = homeSnapshot.testIds.find(testId =>
        testId.startsWith('collaboration-project-wework-project:')
      )
      assert.ok(projectTestId, 'The shared collaboration project card was not rendered in Wework')
      await control.command('click', `[data-testid="${projectTestId}"]`)
      await control.command('waitFor', '[data-testid="collaboration-board"]', {
        timeoutMs: uiTimeoutMs,
      })

      const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
      assert.ok(
        snapshot.testIds.includes('wework-collaboration-workspace'),
        'The Wework collaboration module did not mount the shared collaboration surface'
      )
      assert.ok(
        snapshot.text.includes(PROJECT.name),
        'The shared collaboration project header was not rendered in Wework'
      )
      assert.ok(
        snapshot.testIds.includes('collaboration-open-desktop-workspace'),
        'Wework did not expose desktop-only capabilities through the host adaptation boundary'
      )
      await captureScreenshot(control, 'collaboration-shared-core.png', ACTIVE_WORKBENCH_SELECTOR)
    },
  }
}
