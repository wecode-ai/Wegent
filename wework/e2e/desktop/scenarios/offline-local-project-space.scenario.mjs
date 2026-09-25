import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  captureVerificationScreenshot,
  completeLocalCollaborationFolderImport,
  inCollaborationSidebar,
  selectWhenOptionAvailable,
} from '../modules/workspace-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'
const CLOUD_WORKSPACE_ID = 'offline-cloud-workspace'
const PROJECT_NAME = '离线本地项目空间'
const ISSUE_NAME = '离线本地 Issue'
const MODEL_NAME = 'wework-custom-desktop-e2e-responses'

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

function sidebarScoped(selector) {
  return inCollaborationSidebar(selector)
}

async function snapshot(control) {
  return JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
}

async function projectAgentTestId(control, displayName) {
  const projectSnapshot = await snapshot(control)
  for (const testId of projectSnapshot.testIds.filter(testId =>
    testId.startsWith('project-agent-row-')
  )) {
    if ((await control.command('getText', `[data-testid="${testId}"]`)).includes(displayName)) {
      return testId.slice('project-agent-row-'.length)
    }
  }
  throw new Error(`Could not find project Agent "${displayName}"`)
}

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloudOffline = false
  let cloudWorkspaceListFailures = 0
  const cloudAgentMutationRequests = []
  const cloudProjectDetailRequests = []
  const assertLocalIsolation = () =>
    assert.deepEqual(
      cloudProjectDetailRequests,
      [],
      `Local project operations unexpectedly called cloud project detail APIs: ${cloudProjectDetailRequests.join(', ')}`
    )

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/workspaces') {
        if (cloudOffline) {
          cloudWorkspaceListFailures += 1
          json(response, 503, { detail: 'Desktop E2E cloud workspace service is unavailable' })
          return true
        }
        json(response, 200, {
          items: [
            {
              id: CLOUD_WORKSPACE_ID,
              name: '云端空间',
              description: '保存在云端并可跨设备访问的协作空间。',
              access_role: 'Owner',
              member_count: 1,
              agent_count: 0,
              execution_environment_count: 0,
              project_count: 0,
              created_by_user_id: 1,
              version: 1,
              created_at: '2026-09-13T00:00:00Z',
              updated_at: '2026-09-13T00:00:00Z',
            },
          ],
        })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/resources') {
        json(response, 200, { agents: [], execution_environments: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/teams') {
        json(response, 200, { items: [], total: 0 })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/devices') {
        json(response, 200, { items: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/models/unified') {
        json(response, 503, {
          detail: 'Desktop E2E cloud model service is unavailable',
        })
        return true
      }
      if (
        request.method === 'POST' &&
        (url.pathname === '/api/bots' || url.pathname === '/api/teams')
      ) {
        cloudAgentMutationRequests.push(`${request.method} ${url.pathname}`)
      }
      if (
        url.pathname.startsWith('/api/v1/cloud-projects/') ||
        url.pathname.startsWith('/api/v1/loop-items/')
      ) {
        cloudProjectDetailRequests.push(`${request.method} ${url.pathname}`)
      }
      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="wework-collaboration-platform"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        sidebarScoped(`[data-testid="collaboration-workspace-${LOCAL_WORKSPACE_ID}"]`),
        {
          text: '本地空间',
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        sidebarScoped(`[data-testid="collaboration-workspace-${CLOUD_WORKSPACE_ID}"]`),
        {
          text: '云端空间',
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped(
              '[data-testid="collaboration-domain-local"], [data-testid="collaboration-domain-cloud"]'
            )
          )
        ),
        0,
        'The unified collaboration board still exposed local/cloud mode selectors'
      )

      const platformSnapshot = await snapshot(control)
      assert.ok(
        platformSnapshot.testIds.includes('wework-collaboration-platform') &&
          platformSnapshot.testIds.includes('collaboration-platform-root'),
        'Collaboration did not render through the shared native Wework module'
      )
      assert.equal(
        platformSnapshot.testIds.some(testId => testId.startsWith('app-iframe-')),
        false,
        'Collaboration unexpectedly rendered through an iframe host'
      )
      await captureVerificationScreenshot(
        control,
        'offline-local-project-space-01-local-and-cloud-spaces.png',
        ACTIVE_WORKBENCH_SELECTOR
      )

      cloudOffline = true
      await control.command(
        'click',
        sidebarScoped(`[data-testid="collaboration-workspace-${LOCAL_WORKSPACE_ID}"]`)
      )
      const localWorkspaceTree = sidebarScoped(
        `[data-testid="collaboration-workspace-tree-${LOCAL_WORKSPACE_ID}"]`
      )
      const activeLocalWorkspace = `${localWorkspaceTree} [data-testid="collaboration-workspace-nav-projects"]`
      await control.command('waitFor', `${activeLocalWorkspace}[aria-current="page"]`, {
        text: '本地空间',
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-workspace-project-create"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(
        await control.command('getAttribute', activeLocalWorkspace, {
          value: 'aria-current',
        }),
        'page',
        'The offline flow did not enter the device-owned local workspace'
      )

      await control.command(
        'click',
        scoped('[data-testid="collaboration-workspace-project-create"]')
      )
      await control.command(
        'click',
        '[data-testid="collaboration-workspace-project-import-folder"]'
      )
      await control.command('waitFor', '[data-testid="device-folder-path-input"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="collaboration-project-name-input"]',
            { visible: true }
          )
        ),
        0,
        'The local workspace unexpectedly opened the cloud project form'
      )
      await completeLocalCollaborationFolderImport(control, PROJECT_NAME)
      await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
        text: PROJECT_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="collaboration-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        cloudWorkspaceListFailures,
        0,
        'Entering the local workspace unexpectedly reloaded the unavailable cloud workspace service'
      )
      assertLocalIsolation()

      await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: ISSUE_NAME,
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="cloud-todo-create-confirm"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
        ISSUE_NAME,
        'The newly created local Issue did not open in the shared Issue detail'
      )
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await control.command('waitFor', scoped('[data-testid^="collaboration-issue-"]'), {
        text: ISSUE_NAME,
        timeoutMs: uiTimeoutMs,
      })
      assertLocalIsolation()

      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command('waitFor', scoped('[data-testid="project-settings-shell"]'), {
        timeoutMs: uiTimeoutMs,
      })
      const settingsSnapshot = await snapshot(control)
      assert.equal(
        settingsSnapshot.testIds.includes('collaboration-tab-automation'),
        false,
        'Automation must not remain a top-level project view'
      )

      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command('clickWhenEnabled', scoped('[data-testid="project-agent-add"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-display-name"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
        value: '离线本地智能体',
      })
      await selectWhenOptionAvailable(
        control,
        '[data-testid="cloud-project-chat-agent-model"]',
        MODEL_NAME,
        uiTimeoutMs
      )
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid^="project-agent-row-"]'), {
        text: '离线本地智能体',
        timeoutMs: uiTimeoutMs,
      })
      const localAgentId = await projectAgentTestId(control, '离线本地智能体')
      await control.command('click', scoped(`[data-testid="project-agent-edit-${localAgentId}"]`))
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-display-name"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
        value: '离线本地智能体（已编辑）',
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid^="project-agent-row-"]'), {
        text: '离线本地智能体（已编辑）',
        timeoutMs: uiTimeoutMs,
      })
      assert.deepEqual(
        cloudAgentMutationRequests,
        [],
        'Local Agent creation must not write cloud resources'
      )
      assertLocalIsolation()

      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-automatic-processing"]')
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-project-automatic-processing-page"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', scoped('[data-testid="automatic-processing"]'), {
        text: '暂无自动处理规则',
        timeoutMs: uiTimeoutMs,
      })
      await captureVerificationScreenshot(
        control,
        'offline-local-project-space-02-local-project-settings.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
      assertLocalIsolation()
      await control.command('click', scoped('[data-testid="collaboration-tab-files"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-files-view"]'), {
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', activeLocalWorkspace)
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-workspace-project-create"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.equal(
        await control.command('getAttribute', activeLocalWorkspace, {
          value: 'aria-current',
        }),
        'page',
        'The local Workspace tree lost its active state after leaving Project settings'
      )
      await control.command('waitFor', localWorkspaceTree, {
        text: '本地空间',
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(
        cloudWorkspaceListFailures,
        0,
        'Returning to the local workspace unexpectedly reloaded the unavailable cloud workspace service'
      )
      assertLocalIsolation()
    },

    diagnostics() {
      return {
        cloudAgentMutationRequests,
        cloudProjectDetailRequests,
        cloudWorkspaceListFailures,
      }
    },
  }
}
