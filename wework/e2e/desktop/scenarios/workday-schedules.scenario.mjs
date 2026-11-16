import assert from 'node:assert/strict'

import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { CLOUD_DEVICE_ID } from '../modules/shared.mjs'
import {
  createLocalCollaborationProject,
  enterLocalCollaborationWorkspace,
  inCollaborationSidebar,
  reloadMainWindow,
  selectCollaborationDomain,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = id => `${CONTENT} [data-testid="${id}"]`
const testId = id => `[data-testid="${id}"]`

// This checkpoint exercises real renderer, IPC, remote relay and HTTP persistence.
// Calendar date decisions belong to the frozen-date Rust/Python unit tests.
export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let workspace
  let cloudProject
  const request = async (path, method = 'GET', input) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
    const body = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: HTTP ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }
  const rpc = (control, method, params = {}) =>
    requestExecutor(control, method, params, uiTimeoutMs)
  const waitValue = (load, expected, message) =>
    waitForBoardValue(load, expected, message, uiTimeoutMs)
  const checked = (control, selector, value) =>
    control.command('waitFor', `${selector}${value ? ':checked' : ':not(:checked)'}`)
  const savePersonal = async control => {
    await control.command('clickWhenEnabled', testId('automation-save-button'))
    await control.command('waitFor', testId('automation-save-button'), { visible: false })
  }

  async function openPersonal(control, name, anchor) {
    await control.command('navigate', 'body', { value: '/automations' })
    await control.command('waitFor', testId('create-automation-button'))
    await control.command('markElementWithText', '[data-testid^="automation-open-"]', {
      text: name,
      value: anchor,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('clickWhenEnabled', `[data-e2e-anchor-id="${anchor}"]`)
    await control.command('waitFor', testId('automation-name-input'))
    assert.equal(await control.command('getValue', testId('automation-name-input')), name)
  }

  async function verifyPersonal(control, source) {
    const name = `Workday ${source} ${process.pid}`
    await control.command('navigate', 'body', { value: '/automations' })
    await control.command('clickWhenEnabled', testId('create-automation-button'))
    await control.command('fill', testId('automation-name-input'), { value: name })
    await control.command('fill', testId('automation-prompt-input'), {
      value: 'Workday persistence regression',
    })
    if (source === 'cloud') {
      await control.command('click', testId('automation-source-select'))
      await control.command('clickWhenEnabled', testId('automation-source-select-option-cloud'))
      await control.command('click', testId('automation-device-select'))
      await control.command(
        'clickWhenEnabled',
        testId(`automation-device-select-option-${CLOUD_DEVICE_ID}`)
      )
    }
    // Start with a future one-time schedule so no real execution can race the editor.
    await control.command('click', testId('automation-repeat-menu'))
    await control.command('click', testId('automation-repeat-menu-option-one_time'))
    await control.command('fill', testId('automation-execute-at-input'), {
      value: '2099-01-01T09:00:00',
    })
    await savePersonal(control)
    const ids = JSON.parse(
      await control.command('getTestIdOrder', testId('automation-detail-panel'))
    )
    const action = ids.find(id => id.startsWith('automation-detail-actions-'))
    assert.ok(action, 'A saved personal schedule must expose its persisted identity')
    const id = action.slice('automation-detail-actions-'.length)
    await control.command('click', testId(`automation-detail-toggle-${id}`))
    const toggle = testId(`automation-detail-toggle-${id}`)
    await control.command('waitFor', `${toggle}[aria-label="恢复"], ${toggle}[aria-label="Resume"]`)
    await control.command('click', testId('automation-repeat-menu'))
    await control.command('click', testId('automation-repeat-menu-option-daily'))
    await checked(control, testId('automation-workday-only'), false)
    await control.command('click', testId('automation-workday-only'))
    await savePersonal(control)
    await waitValue(
      async () => {
        const row = JSON.parse(await control.command('snapshot', testId(`automation-row-${id}`)))
        return /中国大陆法定工作日|Mainland China statutory workdays only/.test(row.text)
      },
      true,
      'The persisted personal schedule must show its statutory workday filter'
    )
    await reloadMainWindow(control, `The ${source} personal workday schedule must survive reload`)
    await openPersonal(control, name, `workday-personal-${source}`)
    await checked(control, testId('automation-workday-only'), true)
    const local = (await rpc(control, 'runtime.automations.list')).items.find(
      item => item.name === name
    )
    if (source === 'local') {
      assert.equal(local?.schedule.workdayOnly, true)
      assert.equal(local.schedule.expression, '0 9 * * *')
    } else {
      assert.equal(
        local,
        undefined,
        'A cloud-device schedule must not be saved in the local Executor'
      )
    }
    await control.command('click', testId('automation-workday-only'))
    await savePersonal(control)
    await control.command('click', testId('automation-detail-close'))
    await openPersonal(control, name, `workday-personal-${source}-off`)
    await checked(control, testId('automation-workday-only'), false)
    await control.command('click', testId('automation-detail-close'))
  }

  async function openRules(control) {
    await selectCollaborationProjectView(control, CONTENT, 'manage')
    await control.command(
      'clickWhenEnabled',
      scoped('collaboration-project-settings-automatic-processing')
    )
    await control.command('waitFor', scoped('automatic-processing'))
  }

  async function verifyProject(control, source) {
    let project
    await control.command('clickWhenEnabled', testId('workspace-tab-select-fixed-board'))
    await selectCollaborationDomain(control, CONTENT, source)
    if (source === 'local') {
      const name = `Workday local project ${process.pid}`
      await createLocalCollaborationProject(control, CONTENT, name)
      project = (await rpc(control, 'projects.list')).find(item => item.name === name)
      assert.ok(project, 'The checkpoint must create its own local project')
    } else {
      project = cloudProject
      await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
      await control.command('waitFor', scoped('collaboration-board'), {
        timeoutMs: workbenchReadyTimeoutMs,
      })
    }
    const rules = async () =>
      source === 'local'
        ? (await rpc(control, 'projects.list')).find(item => item.id === project.id).metadata
            .automatic_processing_rules
        : request(`/api/v1/cloud-projects/${project.id}/automations`)
    await openRules(control)
    await control.command('clickWhenEnabled', scoped('automatic-processing-create'))
    await control.command(
      'click',
      `${CONTENT} label:has(> [data-testid="automatic-processing-trigger-schedule"])`
    )
    await control.command('select', scoped('automatic-processing-schedule-frequency'), {
      value: 'daily',
    })
    await checked(control, scoped('automatic-processing-workday-only'), false)
    await control.command('click', scoped('automatic-processing-workday-only'))
    // Human targets require no model or execution-environment fixtures for saving a rule.
    await control.command('click', scoped('automatic-processing-target-kind-human'))
    await control.command('click', scoped('automatic-processing-target'))
    await control.command(
      'waitFor',
      `${CONTENT} [data-testid^="automatic-processing-target-option-human-"]`
    )
    const ids = JSON.parse(
      await control.command('getTestIdOrder', scoped('automatic-processing-target-picker'))
    )
    const member = ids.find(id => id.startsWith('automatic-processing-target-option-human-'))
    assert.ok(member, 'The real project owner must be an available target')
    await control.command('click', scoped(member))
    await control.command('click', scoped('automatic-processing-enabled'))
    await control.command('clickWhenEnabled', scoped('automatic-processing-save'))
    await control.command('waitFor', scoped('automatic-processing-form'), { visible: false })
    await waitValue(
      async () => (await rules()).length,
      1,
      'Exactly one real project rule must be saved'
    )
    const [rule] = await rules()
    assert.equal(rule.workdayOnly, true)
    assert.equal(rule.cronExpression, '0 9 * * *')
    assert.equal(rule.enabled, false)
    await reloadMainWindow(control, `The ${source} project rule must survive reload`)
    await control.command('clickWhenEnabled', testId('workspace-tab-select-fixed-board'))
    if (source === 'local') {
      await enterLocalCollaborationWorkspace(control, CONTENT)
      await control.command(
        'clickWhenEnabled',
        inCollaborationSidebar(testId(`collaboration-workspace-project-${project.id}`), CONTENT)
      )
    } else {
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
      await control.command('waitFor', scoped('collaboration-board'))
    }
    await openRules(control)
    await control.command('clickWhenEnabled', scoped(`automatic-processing-edit-${rule.id}`))
    await checked(control, scoped('automatic-processing-workday-only'), true)
    assert.equal(
      await control.command('getValue', scoped('automatic-processing-schedule-frequency')),
      'daily'
    )
    await control.command('click', scoped('automatic-processing-workday-only'))
    await control.command('clickWhenEnabled', scoped('automatic-processing-save'))
    await control.command('waitFor', scoped('automatic-processing-form'), { visible: false })
    await waitValue(
      async () => (await rules())[0].workdayOnly,
      false,
      'Clearing the filter must persist through the owning API'
    )
    await control.command('clickWhenEnabled', scoped(`automatic-processing-edit-${rule.id}`))
    await checked(control, scoped('automatic-processing-workday-only'), false)
    await control.command('clickWhenEnabled', scoped('automatic-processing-cancel'))
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', { name: `Workday ${process.pid}` })
      cloudProject = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `Workday cloud project ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await verifyPersonal(control, 'local')
      await verifyPersonal(control, 'cloud')
      await verifyProject(control, 'local')
      await verifyProject(control, 'cloud')
    },
    async cleanup() {
      if (cloudProject) {
        const current = await request(`/api/v1/cloud-projects/${cloudProject.id}`)
        await request(
          `/api/v1/cloud-projects/${cloudProject.id}?version=${current.version}`,
          'DELETE'
        )
      }
      if (workspace) {
        const current = await request(`/api/v1/workspaces/${workspace.id}`)
        await request(`/api/v1/workspaces/${workspace.id}?version=${current.version}`, 'DELETE')
      }
    },
  }
}
