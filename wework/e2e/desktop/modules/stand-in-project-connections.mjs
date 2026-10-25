import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { createLocalCollaborationProject } from './workspace-flows.mjs'

const USER = 9001
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const ROLE = 'project-connection-names'

/** Resolve saved project references to names in both personal connection editors. */
export async function verifyStandInProjectConnectionNames(control, uiTimeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const name = `连接名称回归-${process.pid}`
  await createLocalCollaborationProject(control, CONTENT, name)
  const projects = await rpc('projects.list', {})
  const project = projects.find(row => row.name === name)
  assert.ok(project)
  const settings = await rpc('runtime.stand_in.personal.get', { userId: USER })
  const collaboration = {
    enabled: true,
    allProjects: false,
    projects: [{ id: project.id, store: 'local' }],
    excludedProjects: [],
    tags: [],
  }
  await rpc('runtime.stand_in.personal.save', {
    userId: USER,
    settings: {
      ...settings,
      primary: { ...settings.primary, collaboration },
      roles: [
        ...settings.roles,
        {
          id: ROLE,
          name: '连接名称测试分身',
          enabled: false,
          prompt: '',
          executionDeviceId: settings.executionDeviceId,
          version: 0,
          collaboration,
        },
      ],
    },
  })
  await control.command('click', `${CONTENT} [data-testid="collaboration-primary-stand-in"]`)
  await control.command('click', '[data-testid="stand-in-settings-open"]')
  const row = `[data-testid="stand-in-connection-project-local-${project.id}"]`
  await control.command('waitFor', row, { text: name })
  await control.command('click', '[data-testid="stand-in-primary-cancel"]')
  await control.command('click', `[data-testid="stand-in-overview-role-${ROLE}"]`)
  await control.command('click', '[data-testid="stand-in-settings-open"]')
  await control.command('click', '[data-testid="stand-in-connections-open"]')
  await control.command('waitFor', row, { text: name })
  await control.command('click', row)
  await control.command('waitFor', `[data-testid="stand-in-connect-project-${project.id}"]`)
  assert.equal(
    await control.command(
      'getAttribute',
      `[data-testid="stand-in-connect-project-${project.id}"]`,
      {
        value: 'aria-label',
      }
    ),
    name
  )
  await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
  await control.command('click', '[data-testid="stand-in-connections-open"]')
  await control.command('waitFor', row, { text: name })
  const saved = await rpc('runtime.stand_in.personal.get', { userId: USER })
  assert.deepEqual(
    saved.roles.find(role => role.id === ROLE).collaboration.projects,
    collaboration.projects
  )
  await control.command('click', '[data-testid="stand-in-cancel"]')
}
