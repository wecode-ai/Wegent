import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `分身项目启用-${process.pid}`
const OTHER_PROJECT = `保留分身项目-${process.pid}`
const USER_ID = 9001

/** A project connection must visibly enable a previously disabled personal stand-in. */
export function createDesktopScenario({ uiTimeoutMs }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, OTHER_PROJECT)
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const projects = await rpc('projects.list', {})
      const project = projects.find(row => row.name === PROJECT)
      const otherProject = projects.find(row => row.name === OTHER_PROJECT)
      assert.ok(project)
      assert.ok(otherProject)
      const projectRow = `${CONTENT} [data-testid="collaboration-workspace-project-${project.id}"]`
      const otherProjectRow = `${CONTENT} [data-testid="collaboration-workspace-project-${otherProject.id}"]`
      const badge = '.collaboration-project-sidebar-badge'
      await control.command('waitFor', projectRow)
      await control.command('waitFor', otherProjectRow)
      await control.command('waitFor', `${projectRow} ${badge}`, { visible: false })
      await control.command('waitFor', `${otherProjectRow} ${badge}`, { visible: false })
      const otherRef = { id: otherProject.id, store: 'local' }
      const settings = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      const role = {
        id: 'project-enable',
        name: '项目启用分身',
        enabled: false,
        prompt: '',
        version: 0,
        executionDeviceId: settings.executionDeviceId,
        collaboration: {
          enabled: true,
          allProjects: false,
          projects: [otherRef],
          excludedProjects: [],
          tags: [],
        },
      }
      await rpc('runtime.stand_in.personal.save', {
        userId: USER_ID,
        settings: { ...settings, roles: [role] },
      })
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-project-select"]')
      await control.command('select', '[data-testid="stand-in-project-select"]', { value: role.id })
      await control.command('waitFor', '[data-testid="stand-in-save"]', {
        text: '开启并用于此项目',
      })
      await control.command('waitFor', '[data-testid="stand-in-project-enable-help"]', {
        text: '其他项目',
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-dialog"]', { visible: false })
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-enabled"]`)
      await control.command(
        'waitFor',
        `${projectRow} [data-testid="stand-in-project-${project.id}"]`
      )
      await control.command(
        'waitFor',
        `${otherProjectRow} [data-testid="stand-in-project-${otherProject.id}"]`
      )
      const saved = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      assert.equal(saved.roles[0].enabled, true)
      assert.equal(saved.roles[0].collaboration.enabled, true)
      assert.equal(saved.roles[0].collaboration.allProjects, false)
      assert.deepEqual(saved.roles[0].collaboration.projects, [
        otherRef,
        { id: project.id, store: 'local' },
      ])
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-project-summary"]', {
        text: '已开启',
      })
      await control.command('waitFor', '[data-testid="stand-in-save"]', { text: '停用于此项目' })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-dialog"]', { visible: false })
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-enabled"]`, {
        visible: false,
      })
      await control.command('waitFor', projectRow)
      await control.command('waitFor', `${projectRow} ${badge}`, { visible: false })
      await control.command(
        'waitFor',
        `${otherProjectRow} [data-testid="stand-in-project-${otherProject.id}"]`
      )
      const disconnected = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      assert.equal(disconnected.roles[0].enabled, true)
      assert.equal(disconnected.roles[0].collaboration.enabled, true)
      assert.deepEqual(disconnected.roles[0].collaboration.projects, [otherRef])
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-save"]', {
        text: '开启并用于此项目',
      })
      await control.command('waitFor', '[data-testid="stand-in-project-summary"]', {
        text: '未开启',
      })
      await control.command('click', '[data-testid="stand-in-cancel"]')
      await control.command('click', `${CONTENT} [data-testid="collaboration-primary-stand-in"]`)
      await control.command('waitFor', '[data-testid="stand-in-overview-role-project-enable"]', {
        text: '项目启用分身',
      })
      await control.command('waitFor', '[data-testid="stand-in-overview-role-project-enable"]', {
        text: '已开启',
      })
      await control.command('waitFor', '[data-testid="stand-in-activity"]', {
        text: '尚无处理记录',
      })
    },
  }
}
