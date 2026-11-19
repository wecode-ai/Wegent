// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow, selectCollaborationDomain } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`

/** Real MCP configuration writes must be visible through the primary desktop board. */
export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let workspace
  let project
  let issue
  let excluded
  let requestId = 0

  async function request(path, method = 'GET', values) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const text = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function callTool(name, args = {}) {
    const response = await request('/mcp/wework-space/sse', 'POST', {
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'tools/call',
      params: { name, arguments: { space_id: String(project.id), ...args } },
    })
    assert.ok(!response.error, `MCP ${name}: ${JSON.stringify(response.error)}`)
    assert.ok(!response.result.isError, `MCP ${name}: ${JSON.stringify(response.result)}`)
    return JSON.parse(response.result.content.find(block => block.type === 'text').text)
  }

  async function openBoard(control) {
    await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
    await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
  }

  async function assertBoard(control, expectedColumns) {
    await control.command('waitFor', scoped('[data-testid="board-view-picker"]'), {
      text: 'MCP work',
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${issue.id}"]`), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${excluded.id}"]`), {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    const ids = JSON.parse(await control.command('getTestIdOrder', CONTENT)).filter(
      id =>
        id.startsWith('cloud-todo-column-') &&
        !id.startsWith('cloud-todo-column-add-') &&
        !id.startsWith('cloud-todo-column-dropzone-')
    )
    assert.deepEqual(
      ids,
      expectedColumns.map(id => `cloud-todo-column-${id}`)
    )
  }

  return {
    requiresCloudEnvironment: true,
    backendEnv: { WEWORK_PROJECT_ADMIN_TOOLS_V1: 'true' },
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Project admin ${process.pid}`,
      })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: 'MCP configuration regression',
        task_provider: 'local',
        visibility: 'private',
      })
      const config = await callTool('get_project_config')
      await callTool('update_project_tags', {
        request: { version: config.projectVersion, operation_id: 'admin-tags', tags: ['backend'] },
      })
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
        title: 'Included MCP Issue',
        status: 'in_progress',
        tags: ['backend'],
        priority: 'high',
      })
      excluded = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
        title: 'Excluded MCP Issue',
        status: 'pending',
        priority: 'medium',
      })
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await openBoard(control)

      const capabilities = await callTool('get_project_admin_capabilities')
      assert.ok(
        capabilities.operations.some(operation => operation.name === 'project.boardViews.update')
      )
      const before = await callTool('get_project_config')
      const view = {
        id: 'mcp-work',
        name: 'MCP work',
        columns: [
          { id: 'working', type: 'status', value: 'in_progress' },
          { id: 'backend', type: 'tag', value: 'backend' },
          { id: 'backlog', type: 'unmatched', value: 'Unplanned' },
        ],
        filter: { tags: ['backend'], match: 'all' },
        sorts: { working: ['created-asc'] },
      }
      const boardViews = { schema_version: 1, default_view_id: view.id, views: [view] }
      const change = {
        version: before.projectVersion,
        operation_id: 'admin-board',
        board_views: boardViews,
      }
      const preview = await callTool('update_project_board_views', {
        request: { ...change, dry_run: true },
      })
      assert.equal(preview.dryRun, true)
      assert.equal(preview.auditId, null)
      assert.deepEqual(await callTool('get_project_config'), before)
      const applied = await callTool('update_project_board_views', { request: change })
      assert.ok(applied.auditId)
      assert.equal(applied.projectVersion, before.projectVersion + 1)
      assert.deepEqual(await callTool('update_project_board_views', { request: change }), applied)
      const policy = await callTool('update_project_strategy', {
        request: {
          version: applied.projectVersion,
          operation_id: 'admin-policy',
          collaboration_policy: { content: 'Require a review before publication.' },
        },
      })
      assert.equal(policy.effectScope, 'future_issues')
      assert.equal(policy.runningIssueSnapshotRule, 'preserved')
      const renamed = await callTool('change_project_tag', {
        request: {
          version: policy.projectVersion,
          operation_id: 'admin-rename',
          tag_change: { source: 'backend', target: 'platform' },
        },
      })
      const read = await callTool('get_project_config')
      assert.equal(read.projectVersion, renamed.projectVersion)
      assert.deepEqual(read.configuration.tags, ['platform'])
      assert.equal(read.configuration.board_views.views[0].columns[1].value, 'platform')
      assert.deepEqual(read.configuration.board_views.views[0].filter.tags, ['platform'])
      assert.equal(
        read.configuration.collaboration_policy.content,
        'Require a review before publication.'
      )
      assert.deepEqual((await request(`/api/v1/loop-items/${issue.id}`)).tags, ['platform'])

      await reloadMainWindow(control, 'MCP board configuration did not reopen')
      await openBoard(control)
      await assertBoard(control, ['working', 'backend', 'backlog'])
      await control.command('click', scoped('[data-testid="board-view-picker"]'))
      await control.command('click', '[data-testid="board-view-default"]')
      await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${excluded.id}"]`), {
        timeoutMs: uiTimeoutMs,
      })
      const reordered = structuredClone(read.configuration.board_views)
      reordered.views[0].columns.reverse()
      await callTool('update_project_board_views', {
        request: {
          version: read.projectVersion,
          operation_id: 'admin-reorder',
          board_views: reordered,
        },
      })
      await reloadMainWindow(control, 'MCP column order did not reopen')
      await openBoard(control)
      await assertBoard(control, ['backlog', 'backend', 'working'])
      const persisted = await request(`/api/v1/cloud-projects/${project.id}`)
      assert.deepEqual(persisted.board_views, reordered)
    },
    async cleanup() {
      try {
        if (project) {
          const current = await request(`/api/v1/cloud-projects/${project.id}`)
          await request(`/api/v1/cloud-projects/${project.id}?version=${current.version}`, 'DELETE')
        }
      } finally {
        if (workspace) {
          const current = await request(`/api/v1/workspaces/${workspace.id}`)
          await request(`/api/v1/workspaces/${workspace.id}?version=${current.version}`, 'DELETE')
        }
      }
    },
  }
}
