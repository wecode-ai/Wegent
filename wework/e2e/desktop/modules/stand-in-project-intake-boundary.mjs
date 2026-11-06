import assert from 'node:assert/strict'
import { createLocalCollaborationProject } from './workspace-flows.mjs'

/** Existing roles receive only assignments made after each project connection. */
export async function verifyProjectIntakeBoundary({
  control,
  rpc,
  userId,
  sourceProject,
  waitForExecution,
  timeoutMs,
}) {
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  const name = `分身接入边界-${process.pid}`
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await createLocalCollaborationProject(control, content, name)
  const project = (await rpc('projects.list', {})).find(row => row.name === name)
  assert.ok(project)
  const ref = { id: project.id, store: 'local' }
  const create = title =>
    rpc('todos.create', {
      project_id: project.id,
      todo: { title, assignee_user_id: userId },
    })
  const bindings = issue => rpc('todos.bindings', { task_id: issue.id })
  const save = settings => rpc('runtime.stand_in.personal.save', { userId, settings })
  const read = () => rpc('runtime.stand_in.personal.get', { userId })
  let settings = await read()
  const template = settings.roles.find(role => role.id === 'default')
  assert.ok(template)
  const roleId = 'project-boundary-regression'
  const role = {
    ...template,
    id: roleId,
    name: '项目接入边界回归',
    enabled: true,
    agentId: undefined,
    agentProject: undefined,
    collaboration: {
      enabled: true,
      allProjects: false,
      projects: [{ id: sourceProject.id, store: 'local' }],
      excludedProjects: [],
      tags: [],
    },
  }
  settings = await save({ ...settings, roles: [role] })
  const sourceBoundary = settings.roles[0].projectBoundaries[0].enabledAfter
  const historical = await create('接入分身前已分配，不应自动处理')
  settings.roles[0].collaboration.projects.push(ref)
  settings = await save(settings)
  assert.equal(
    settings.roles[0].projectBoundaries.find(row => row.id === sourceProject.id).enabledAfter,
    sourceBoundary,
    'Connecting another project must preserve pending assignments in the existing project'
  )
  const fresh = await create('接入后新分配，应正常处理')
  await waitForExecution(control, fresh.id, timeoutMs, [roleId])
  assert.equal((await bindings(historical)).length, 0)

  settings = await read()
  settings.roles[0].collaboration.projects = settings.roles[0].collaboration.projects.filter(
    row => row.id !== project.id
  )
  await save(settings)
  const disconnected = await create('断开期间分配，重连后不应补处理')
  settings = await read()
  settings.roles[0].collaboration.projects.push(ref)
  await save(settings)
  const afterReconnect = await create('重新接入后分配，应正常处理')
  await waitForExecution(control, afterReconnect.id, timeoutMs, [roleId])

  // The same old Issue becomes eligible only through a genuinely new assignment.
  let updated = await rpc('todos.update', {
    project_id: project.id,
    task_id: historical.id,
    todo: { version: historical.version, assignee_user_id: 2 },
  })
  updated = await rpc('todos.update', {
    project_id: project.id,
    task_id: historical.id,
    todo: { version: updated.version, assignee_user_id: userId },
  })
  await waitForExecution(control, updated.id, timeoutMs, [roleId])
  // Observe another complete polling interval to catch delayed historical intake.
  const deadline = Date.now() + 11000
  while (Date.now() < deadline) {
    assert.equal((await bindings(disconnected)).length, 0)
    assert.equal((await bindings(fresh)).length, 1)
    assert.equal((await bindings(afterReconnect)).length, 1)
    assert.equal((await bindings(historical)).length, 1)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  settings = await read()
  settings.roles[0].enabled = false
  await save(settings)
}
