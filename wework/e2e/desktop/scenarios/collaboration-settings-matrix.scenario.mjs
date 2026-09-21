import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { inCollaborationSidebar } from '../modules/workspace-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'
const PERSONAL_WORKSPACE_NAME = '协作设置个人空间'
const GROUP_WORKSPACE_NAME = '协作设置团队空间'
const GROUP_DISPLAY_NAME = '协作设置验收团队'
const LOCAL_E2E_USER_ID = 9001
const LIFECYCLE_PROMPT = 'COLLABORATION_SETTINGS_MATRIX_RUN_ISSUE'
const LIFECYCLE_COMPLETION = 'COLLABORATION_SETTINGS_MATRIX_ISSUE_RAN'

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

async function waitForValue(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await read()
    const result = predicate(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

async function snapshot(control) {
  return JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
}

async function closeDestinationDialog(control) {
  await control.command('click', scoped('[data-testid="resource-destination-close"]'))
  await control.command('waitFor', scoped('[data-testid="resource-destination-dialog"]'), {
    visible: false,
  })
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let ownerGroup = null
  let personalWorkspace = null
  let groupWorkspace = null
  let owner = null
  let modelActive = false
  const cloudProjects = []
  let fixtureArchived = false

  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  async function archiveFixtures() {
    if (fixtureArchived) return
    for (const project of cloudProjects) {
      const latest = await request(`/api/v1/cloud-projects/${project.id}`)
      if (latest.status !== 'archived') {
        await request(`/api/v1/cloud-projects/${project.id}?version=${latest.version}`, {
          method: 'DELETE',
        })
      }
    }
    for (const workspace of [personalWorkspace, groupWorkspace].filter(Boolean)) {
      const latest = await request(`/api/v1/workspaces/${workspace.id}`)
      if (latest.status !== 'archived') {
        await request(`/api/v1/workspaces/${workspace.id}?version=${latest.version}`, {
          method: 'DELETE',
        })
      }
    }
    if (ownerGroup) {
      await request(`/api/groups/${encodeURIComponent(ownerGroup.name)}`, {
        method: 'DELETE',
      })
    }
    fixtureArchived = true
  }

  async function createCloudWorkspace(control, { name, namespace }) {
    await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
    await control.command('waitFor', scoped('[data-testid="collaboration-workspace-name-input"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="collaboration-workspace-name-input"]'), {
      value: name,
    })
    await control.command(
      'fill',
      scoped('[data-testid="collaboration-workspace-description-input"]'),
      { value: `${name} 的完整设置验收。` }
    )
    await control.command(
      'select',
      scoped('[data-testid="collaboration-workspace-owner-select"]'),
      {
        value: namespace,
      }
    )
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-workspace-create-confirm"]'),
      { timeoutMs: uiTimeoutMs }
    )
    const workspace = await waitForValue(
      async () => {
        const response = await request('/api/v1/workspaces')
        return response.items?.find(candidate => candidate.name === name) ?? null
      },
      Boolean,
      `Workspace ${name} was not persisted`,
      uiTimeoutMs
    )
    assert.equal(workspace.namespace, namespace)
    return workspace
  }

  async function openWorkspace(control, workspaceId) {
    const identity = inCollaborationSidebar(
      `[data-testid="collaboration-workspace-${workspaceId}"]`
    )
    await control.command('click', identity)
    await control.command(
      'waitFor',
      `${inCollaborationSidebar(
        `[data-testid="collaboration-workspace-tree-${workspaceId}"]`
      )} [data-testid="collaboration-workspace-nav-projects"][aria-current="page"]`,
      { timeoutMs: uiTimeoutMs }
    )
  }

  async function verifyWorkspaceSettings(control, label) {
    await control.command('click', scoped('[data-testid="collaboration-workspace-home-settings"]'))
    await control.command('waitFor', scoped('[data-testid="workspace-settings-shell"]'), {
      timeoutMs: uiTimeoutMs,
    })
    const sections = [
      ['collaboration-workspace-nav-settings', 'collaboration-workspace-settings-save'],
      [
        'collaboration-workspace-nav-participants',
        'collaboration-workspace-participants-tab-agents',
      ],
      [
        'collaboration-workspace-nav-execution-environments',
        'collaboration-workspace-execution-environment-add',
      ],
    ]
    for (const [section, content] of sections) {
      await control.command('click', scoped(`[data-testid="${section}"]`))
      await control.command('waitFor', scoped(`[data-testid="${content}"]`), {
        timeoutMs: uiTimeoutMs,
      })
    }
    await control.command(
      'click',
      scoped('[data-testid="collaboration-workspace-nav-participants"]')
    )
    for (const tab of ['agents', 'members', 'groups']) {
      const selector = scoped(`[data-testid="collaboration-workspace-participants-tab-${tab}"]`)
      await control.command('click', selector)
      assert.equal(
        await control.command('getAttribute', selector, { value: 'aria-selected' }),
        'true',
        `${label} did not activate its ${tab} Workspace settings tab`
      )
    }
  }

  async function createProject(control, workspace, name) {
    await openWorkspace(control, workspace.id)
    await control.command('click', scoped('[data-testid="collaboration-workspace-project-create"]'))
    await control.command('waitFor', scoped('[data-testid="collaboration-project-name-input"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
      value: name,
    })
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-project-create-confirm"]'),
      { timeoutMs: uiTimeoutMs }
    )
    await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
      text: name,
      timeoutMs: uiTimeoutMs,
    })
    if (workspace.location === 'local') return null
    const project = await waitForValue(
      async () => {
        const response = await request(`/api/v1/workspaces/${workspace.id}/projects`)
        return response.items?.find(candidate => candidate.name === name) ?? null
      },
      Boolean,
      `Project ${name} was not persisted`,
      uiTimeoutMs
    )
    cloudProjects.push(project)
    return project
  }

  async function verifyProjectSettings(control, label) {
    await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
    await control.command('waitFor', scoped('[data-testid="project-settings-shell"]'), {
      timeoutMs: uiTimeoutMs,
    })
    const sections = [
      ['collaboration-project-settings-project', 'cloud-project-manage-visibility-private'],
      ['collaboration-project-settings-participants', 'collaboration-participants-tab-agents'],
      [
        'collaboration-project-settings-environments',
        'collaboration-project-execution-environment-add',
      ],
      ['collaboration-project-settings-automatic-processing', 'automatic-processing'],
    ]
    for (const [section, content] of sections) {
      await control.command('click', scoped(`[data-testid="${section}"]`))
      await control.command('waitFor', scoped(`[data-testid="${content}"]`), {
        timeoutMs: uiTimeoutMs,
      })
    }
    await control.command(
      'click',
      scoped('[data-testid="collaboration-project-settings-participants"]')
    )
    for (const tab of ['agents', 'members', 'groups']) {
      const selector = scoped(`[data-testid="collaboration-participants-tab-${tab}"]`)
      await control.command('click', selector)
      assert.equal(
        await control.command('getAttribute', selector, { value: 'aria-selected' }),
        'true',
        `${label} did not activate its ${tab} Project settings tab`
      )
    }
  }

  async function verifyIssueLifecycle(control, workspace, project) {
    const label = workspace.name
    const assigneeUserId = workspace.location === 'local' ? LOCAL_E2E_USER_ID : owner.id
    const issueTitle = `${label}-全链路-${process.pid}`
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
    await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
      value: issueTitle,
    })
    await control.command('click', scoped('[data-testid="cloud-todo-create-assignee"]'))
    await control.command(
      'click',
      `[data-testid="cloud-todo-create-assignee-option-user:${assigneeUserId}"]`
    )
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      await control.command('getAttribute', scoped('[data-testid="cloud-todo-detail-assignee"]'), {
        value: 'data-value',
      }),
      `user:${assigneeUserId}`,
      `${label} Issue was not assigned to the current user`
    )

    const taskPanel = scoped('[data-testid="work-item-new-task-chat-panel"]')
    await control.command('click', scoped('[data-testid="cloud-todo-start-default-assistant"]'))
    await control.command('waitFor', taskPanel, { timeoutMs: uiTimeoutMs })
    await selectE2EModel(control, undefined, undefined, taskPanel)
    const composer = `${taskPanel} [data-testid="chat-message-input"]`
    modelActive = true
    await control.command('fill', composer, {
      value: `${LIFECYCLE_PROMPT}:${label}`,
    })
    await control.command('press', composer, { key: 'Enter' })
    await control.command(
      'waitFor',
      scoped('[data-testid="work-item-task-chat-panel"] [data-testid="message-assistant"]'),
      {
        text: `${LIFECYCLE_COMPLETION}:${label}`,
        timeoutMs: Math.max(uiTimeoutMs, 30_000),
      }
    )
    modelActive = false
    await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
    await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    const status = scoped('[data-testid="cloud-todo-detail-status"]')
    await control.command('select', status, { value: 'completed' })
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await waitForValue(
      () => control.command('getValue', status),
      value => value === 'completed',
      `${label} Issue did not retain its completed status`,
      uiTimeoutMs
    )
    if (project) {
      const completed = await waitForValue(
        async () => {
          const response = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
          return response.items?.find(candidate => candidate.title === issueTitle) ?? null
        },
        value => value?.status === 'completed',
        `${label} Issue completion was not persisted`,
        uiTimeoutMs
      )
      assert.equal(completed.assignee_user_id, assigneeUserId)
    }
    await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
    await control.command('waitFor', scoped('[data-testid^="cloud-todo-card-"]'), {
      text: issueTitle,
      timeoutMs: uiTimeoutMs,
    })
  }

  async function verifyResourceCatalog(control) {
    for (const kind of ['agents', 'teams']) {
      await control.command('click', scoped(`[data-testid="collaboration-primary-${kind}"]`))
      await control.command('waitFor', scoped(`[data-testid="collaboration-${kind}-page"]`), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped(`[data-testid="collaboration-${kind}-create"]`))
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-${kind}-create-local"]`),
        { timeoutMs: uiTimeoutMs }
      )
      if (kind === 'agents') {
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-agents-create-cloud"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command('click', scoped('[data-testid="collaboration-agents-create-cloud"]'))
        await control.command('waitFor', '[data-testid="wework-agent-owner"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('select', '[data-testid="wework-agent-owner"]', {
          value: ownerGroup.name,
        })
        assert.equal(
          await control.command('getValue', '[data-testid="wework-agent-owner"]'),
          ownerGroup.name,
          'Cloud Agent creation did not expose the group ownership choice in the form'
        )
        await control.command('click', '[data-testid="wework-agent-resource-creator-close"]')
        continue
      } else {
        await control.command(
          'waitFor',
          scoped('[data-testid="collaboration-teams-create-cloud-personal"]'),
          { timeoutMs: uiTimeoutMs }
        )
        await control.command(
          'click',
          scoped('[data-testid="collaboration-teams-create-cloud-groups"]')
        )
        await control.command(
          'waitFor',
          scoped(`[data-testid="collaboration-teams-create-workspace-${groupWorkspace.id}"]`),
          { timeoutMs: uiTimeoutMs }
        )
      }
      await closeDestinationDialog(control)
    }

    await control.command('click', scoped('[data-testid="collaboration-primary-devices"]'))
    await control.command('waitFor', scoped('[data-testid="collaboration-devices-page"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', scoped('[data-testid="collaboration-devices-filter-local"]'))
    const localSnapshot = await snapshot(control)
    assert.ok(
      localSnapshot.testIds.some(testId => testId.startsWith('collaboration-devices-row-')),
      'The Collaboration device catalog did not expose the connected local device'
    )
    await control.command('click', scoped('[data-testid="collaboration-devices-filter-cloud"]'))
    const cloudSnapshot = await snapshot(control)
    assert.ok(
      cloudSnapshot.testIds.some(testId => testId.startsWith('collaboration-devices-row-')),
      'The Collaboration device catalog did not expose the connected cloud device'
    )
    await control.command('click', scoped('[data-testid="collaboration-devices-create"]'))
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-devices-create-cloud-personal"]'),
      { timeoutMs: uiTimeoutMs }
    )
    await control.command(
      'click',
      scoped('[data-testid="collaboration-devices-create-cloud-groups"]')
    )
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-devices-create-workspace-${groupWorkspace.id}"]`),
      { timeoutMs: uiTimeoutMs }
    )
    await closeDestinationDialog(control)
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/api/admin/setup-complete', { method: 'POST' })
      owner = await request('/api/users/me')
      ownerGroup = await request('/api/groups', {
        method: 'POST',
        body: JSON.stringify({
          name: `collaboration-settings-${process.pid}`,
          display_name: GROUP_DISPLAY_NAME,
          visibility: 'private',
        }),
      })
    },

    async handleHttp(requestMessage, response, url) {
      if (
        !modelActive ||
        requestMessage.method !== 'POST' ||
        ![
          '/responses',
          '/v1/responses',
          '/api/runtime-work/llm-responses-proxy/responses',
        ].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(requestMessage)
      const prompt = latestModelInputText(body)
      if (!prompt.includes(LIFECYCLE_PROMPT)) return false
      const marker = prompt
        .split('\n')
        .find(line => line.includes(LIFECYCLE_PROMPT))
        ?.trim()
      assert.ok(marker, 'The Issue lifecycle prompt marker was lost')
      const suffix = marker.slice(marker.indexOf(LIFECYCLE_PROMPT) + LIFECYCLE_PROMPT.length)
      const responseId = `collaboration-settings-matrix-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(`${LIFECYCLE_COMPLETION}${suffix}`),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      try {
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
          timeoutMs: uiTimeoutMs,
        })
        const personalName = `${PERSONAL_WORKSPACE_NAME}-${process.pid}`
        const groupName = `${GROUP_WORKSPACE_NAME}-${process.pid}`
        personalWorkspace = await createCloudWorkspace(control, {
          name: personalName,
          namespace: 'default',
        })
        await control.command('click', scoped('[data-testid="collaboration-primary-home"]'))
        groupWorkspace = await createCloudWorkspace(control, {
          name: groupName,
          namespace: ownerGroup.name,
        })
        await capture(control, 'collaboration-settings-matrix-01-workspaces.png')

        await verifyResourceCatalog(control)
        await capture(control, 'collaboration-settings-matrix-02-resource-catalog.png')

        const localWorkspace = {
          id: LOCAL_WORKSPACE_ID,
          location: 'local',
          name: '本地空间',
        }
        for (const workspace of [localWorkspace, personalWorkspace, groupWorkspace]) {
          await openWorkspace(control, workspace.id)
          await verifyWorkspaceSettings(control, workspace.name)
          const projectName = `${workspace.name}-设置项目-${process.pid}`
          const project = await createProject(control, workspace, projectName)
          await verifyProjectSettings(control, workspace.name)
          if (workspace.location === 'local' || workspace.id === groupWorkspace.id) {
            await verifyIssueLifecycle(control, workspace, project)
          }
        }
        await capture(control, 'collaboration-settings-matrix-03-all-settings.png')
      } finally {
        modelActive = false
        await archiveFixtures()
      }
    },

    async cleanup() {
      await archiveFixtures()
    },

    diagnostics() {
      return {
        cloudProjectIds: cloudProjects.map(project => project.id),
        fixtureArchived,
        groupWorkspaceId: groupWorkspace?.id ?? null,
        ownerGroup: ownerGroup?.name ?? null,
        personalWorkspaceId: personalWorkspace?.id ?? null,
      }
    },
  }
}
