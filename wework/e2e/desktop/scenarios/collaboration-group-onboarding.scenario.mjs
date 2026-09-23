import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { inCollaborationSidebar } from '../modules/workspace-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const LOCAL_WORKSPACE_ID = 'wework-local-workspace'
const PROJECT_NAME = `协作小组上手验收-${process.pid}`
const GROUP_NAME = `项目推进小组-${process.pid}`
const ISSUE_NAME = `验证小组分配-${process.pid}`

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

function sidebarScoped(selector) {
  return inCollaborationSidebar(selector, ACTIVE_WORKBENCH_SELECTOR)
}

async function snapshot(control, selector = ACTIVE_WORKBENCH_SELECTOR) {
  return JSON.parse(await control.command('snapshot', selector))
}

async function waitForTestId(control, prefix, timeoutMs, selector = ACTIVE_WORKBENCH_SELECTOR) {
  const deadline = Date.now() + timeoutMs
  let lastTestIds = []
  while (Date.now() < deadline) {
    lastTestIds = (await snapshot(control, selector)).testIds
    const testId = lastTestIds.find(candidate => candidate.startsWith(prefix))
    if (testId) return testId
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Missing test id with prefix ${prefix}. Last test ids: ${lastTestIds.join(', ')}`)
}

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            sidebarScoped('[data-testid="collaboration-primary-agents"]')
          )
        ),
        1,
        'The left navigation did not expose the standalone Agent destination'
      )

      const localWorkspaceTree = sidebarScoped(
        `[data-testid="collaboration-workspace-tree-${LOCAL_WORKSPACE_ID}"]`
      )
      await control.command('waitFor', localWorkspaceTree, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${localWorkspaceTree} .collaboration-workspace-identity`)
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid="collaboration-workspace-starter-invite-members"]')
          )
        ),
        0,
        'The local workspace onboarding exposed member invitations'
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-workspace-starter-configure-agents"]')
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-workspace-participants-tab-agents"]'),
        { timeoutMs: uiTimeoutMs }
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid="collaboration-workspace-participants-tab-members"]')
          )
        ),
        0,
        'The local workspace settings exposed the cloud-only member tab'
      )
      await control.command('waitFor', scoped('[data-testid^="project-agent-row-"]'), {
        text: '当前设备智能体',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid^="project-agent-archive-"]')
          )
        ),
        0,
        'The default local Agent could still be removed from the local workspace'
      )
      await control.command('click', `${localWorkspaceTree} .collaboration-workspace-identity`)
      await control.command(
        'click',
        scoped('[data-testid="collaboration-workspace-project-create"]')
      )
      await control.command('click', '[data-testid="collaboration-workspace-project-create-blank"]')
      const dialog = scoped('[data-testid="collaboration-project-create-dialog"]')
      await control.command('waitFor', dialog, { timeoutMs: uiTimeoutMs })
      const initialDialog = await snapshot(control, dialog)
      assert.ok(
        !initialDialog.text.includes('下一步再选择保存在本地或云端'),
        'The removed local-or-cloud follow-up hint returned'
      )
      assert.equal(
        initialDialog.testIds.some(testId => testId.startsWith('cloud-project-task-provider-')),
        false,
        'Task source was exposed before More settings'
      )
      assert.equal(
        initialDialog.testIds.includes('collaboration-project-description-input'),
        false,
        'Description occupied the primary project creation flow'
      )
      assert.ok(
        initialDialog.text.includes('我'),
        'Project creation did not include the current user'
      )
      await control.command('waitFor', scoped('.collaboration-project-create-collaborator-token'), {
        text: '当前设备智能体',
        timeoutMs: uiTimeoutMs,
      })

      await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
        value: PROJECT_NAME,
      })
      await control.command('click', scoped('[aria-label="取消 当前设备智能体"]'))
      assert.equal(
        Number(
          await control.command('getElementCount', scoped('[aria-label="取消 当前设备智能体"]'))
        ),
        0,
        'The default local Agent could not be removed from the new project'
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-create-add-collaborator"]')
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="collaboration-project-create-default-agent"]'
          )
        ),
        0,
        'Project creation still exposed manual default collaboration-group creation'
      )
      const defaultAgentOptionTestId = await waitForTestId(
        control,
        'collaboration-project-create-agent-',
        uiTimeoutMs,
        'body'
      )
      await control.command('click', `[data-testid="${defaultAgentOptionTestId}"]`)
      await control.command('waitFor', scoped('.collaboration-project-create-collaborator-token'), {
        text: '当前设备智能体',
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-project-create-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', scoped('[data-testid="cloud-project-header-title"]'), {
        text: PROJECT_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', localWorkspaceTree, {
        text: PROJECT_NAME,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid="collaboration-participants-tab-agents"]')
          )
        ),
        1,
        'Project settings did not expose the standalone Agent tab'
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-agents"]')
      )
      await control.command('waitFor', scoped('[data-testid^="project-agent-row-"]'), {
        text: '当前设备智能体',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid^="project-agent-archive-"]')
          )
        ),
        0,
        'The default local Agent could still be archived from the project'
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-groups"]')
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-participants-tab-groups"][aria-selected="true"]'),
        { timeoutMs: uiTimeoutMs }
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped('[data-testid^="collaboration-group-detail-"]')
          )
        ),
        0,
        'Creating a local project still created a default collaboration group'
      )

      await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
      await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
        timeoutMs: uiTimeoutMs,
      })
      const groupForm = await snapshot(control, scoped('[data-testid="collaboration-group-form"]'))
      assert.equal(
        groupForm.testIds.some(testId => testId.startsWith('collaboration-group-create-tab-')),
        false,
        'Collaboration group creation returned to the obsolete multi-step form'
      )
      assert.equal(
        groupForm.testIds.includes('collaboration-group-create-next'),
        false,
        'Collaboration group creation still required a Next step'
      )
      await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
        value: GROUP_NAME,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-group-create-add-members"]')
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="collaboration-group-agent-action-create-default"]'
          )
        ),
        0,
        'A second current-device Agent could be created after one already existed'
      )
      const agentMemberTestId = await waitForTestId(
        control,
        'collaboration-group-create-member-agent-',
        uiTimeoutMs
      )
      await control.command('click', `[data-testid="${agentMemberTestId}"]`)
      const humanMemberTestId = await waitForTestId(
        control,
        'collaboration-group-create-member-human-',
        uiTimeoutMs
      )
      await control.command('click', `[data-testid="${humanMemberTestId}"]`)
      await control.command(
        'click',
        scoped('[data-testid="collaboration-group-create-add-members"]')
      )
      await control.command('click', scoped('[data-testid="collaboration-group-leader"]'))
      const humanId = humanMemberTestId.slice('collaboration-group-create-member-human-'.length)
      await control.command('click', `[data-testid="collaboration-group-leader-human-${humanId}"]`)
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-group-create"]'),
        { timeoutMs: uiTimeoutMs }
      )
      const groupDetailTestId = await waitForTestId(
        control,
        'collaboration-group-detail-local-group-',
        uiTimeoutMs
      )
      const groupId = groupDetailTestId.slice('collaboration-group-detail-'.length)

      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
      await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: ISSUE_NAME,
      })
      await control.command('click', scoped('[data-testid="cloud-todo-create-assignee"]'))
      await control.command(
        'click',
        `[data-testid="cloud-todo-create-assignee-option-group:${groupId}"]`
      )
      assert.equal(
        await control.command(
          'getAttribute',
          scoped('[data-testid="cloud-todo-create-assignee"]'),
          { value: 'data-value' }
        ),
        `group:${groupId}`,
        'The collaboration group could not be selected during Issue creation'
      )
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="cloud-todo-create-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-assignee"]'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command(
          'getAttribute',
          scoped('[data-testid="cloud-todo-detail-assignee"]'),
          { value: 'data-value' }
        ),
        `group:${groupId}`,
        'The created Issue did not retain its collaboration group assignee'
      )
    },

    diagnostics() {
      return {
        projectName: PROJECT_NAME,
        groupName: GROUP_NAME,
      }
    },
  }
}
