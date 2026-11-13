import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { inCollaborationSidebar, reloadMainWindow } from '../modules/workspace-flows.mjs'

const active = '[data-workspace-tab-content][aria-hidden="false"]'
const sidebar = testId => inCollaborationSidebar(`[data-testid="${testId}"]`, active)

// Stories: defaults never adopt a business space; explicit ownership is honored;
// reconnecting preserves a single project row and per-space expansion.
export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs, captureScreenshot }) {
  let cloud
  let business
  const projects = []
  let scrollTarget
  async function request(path, method = 'GET', values) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const body = await response.text()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }
  async function createProject(control, name, workspaceId = '') {
    await control.command('clickWhenEnabled', sidebar('collaboration-project-create-cloud'), {
      timeoutMs: uiTimeoutMs,
    })
    const select = '[data-testid="collaboration-project-workspace-select"]'
    await control.command('waitFor', select, { visible: true, timeoutMs: uiTimeoutMs })
    assert.ok((await control.command('getText', select)).includes('默认空间'))
    assert.equal((await control.command('getText', select)).includes('尚未加入空间'), false)
    if (workspaceId) await control.command('select', select, { value: workspaceId })
    await control.command('fill', '[data-testid="collaboration-project-name-input"]', {
      value: name,
    })
    await control.command(
      'clickWhenEnabled',
      '[data-testid="collaboration-project-create-confirm"]',
      { timeoutMs: uiTimeoutMs }
    )
    await control.command('waitFor', '[data-testid="collaboration-project-create-dialog"]', {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', sidebar('collaboration-project-group-cloud'), {
      text: name,
      timeoutMs: uiTimeoutMs,
    })
    const result = await request('/api/v1/cloud-projects')
    const project = result.items.find(item => item.name === name)
    assert.ok(project, 'UI creation must persist a real cloud project')
    await control.command(
      'waitFor',
      `${sidebar(`collaboration-workspace-project-${project.id}`)}[aria-current="page"]`,
      {
        timeoutMs: uiTimeoutMs,
      }
    )
    projects.push(project)
    return project
  }
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      business = await request('/api/v1/workspaces', 'POST', {
        name: `test-${process.pid}`,
        is_default: true,
      })
      for (let index = 0; index < 20; index += 1) {
        const project = await request(`/api/v1/workspaces/${business.id}/projects`, 'POST', {
          name: `滚动验收-${index}-${process.pid}`,
        })
        if (index === 0) scrollTarget = project
      }
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            sidebar('collaboration-workspaces-section-toggle')
          )
        ),
        0
      )
      assert.equal(
        (await control.command('getText', sidebar('collaboration-project-group-local'))).includes(
          '本地空间'
        ),
        false
      )
      const first = await createProject(control, `默认项目一-${process.pid}`)
      const second = await createProject(control, `默认项目二-${process.pid}`)
      assert.ok(first.workspace_id)
      assert.notEqual(first.workspace_id, business.id)
      assert.equal(second.workspace_id, first.workspace_id)
      const defaultSpace = await request(`/api/v1/workspaces/${first.workspace_id}`)
      assert.equal(defaultSpace.name, '默认空间')
      const explicit = await createProject(control, `指定空间项目-${process.pid}`, business.id)
      assert.equal(explicit.workspace_id, business.id)
      assert.equal((await request(`/api/v1/workspaces/${business.id}`)).name, business.name)
      await reloadMainWindow(control, 'Project navigation did not reconnect')
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      for (const project of projects) {
        const tree = sidebar(`collaboration-workspace-tree-${project.workspace_id}`)
        const row = sidebar(`collaboration-workspace-project-${project.id}`)
        await control.command('waitFor', tree, { text: project.name, timeoutMs: uiTimeoutMs })
        assert.equal(Number(await control.command('getElementCount', row)), 1)
      }
      const toggle = sidebar(`collaboration-workspace-toggle-${first.workspace_id}`)
      await control.command('scrollIntoView', toggle)
      await control.command('click', toggle)
      await control.command('waitFor', sidebar(`collaboration-workspace-project-${first.id}`), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', sidebar(`collaboration-workspace-project-${explicit.id}`), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', toggle)
      await control.command('waitFor', sidebar(`collaboration-workspace-project-${first.id}`), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getComputedStyleValue', inCollaborationSidebar('', active).trim(), {
          value: 'overflow-y',
        }),
        'auto'
      )
      await control.command(
        'scrollIntoView',
        sidebar(`collaboration-workspace-project-${scrollTarget.id}`)
      )
      await control.command(
        'waitFor',
        sidebar(`collaboration-workspace-project-${scrollTarget.id}`),
        { visible: true, timeoutMs: uiTimeoutMs }
      )
      const [metrics] = JSON.parse(
        await control.command('getElementMetrics', inCollaborationSidebar('', active).trim())
      )
      assert.ok(
        metrics.scrollHeight > metrics.clientHeight,
        'The fixture must overflow the sidebar'
      )
      assert.ok(metrics.scrollTop > 0, 'The sidebar must scroll to reveal a project below the fold')
      assert.ok(
        metrics.scrollWidth <= metrics.clientWidth + 1,
        'The sidebar must not overflow horizontally'
      )
      await captureScreenshot(control, 'project-spaces-default-and-explicit.png', active)
    },
  }
}
