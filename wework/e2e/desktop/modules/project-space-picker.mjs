import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reloadMainWindow } from './workspace-flows.mjs'

const MENU = '[data-testid="work-item-context-menu"]'
const OPTIONS = `${MENU} [role="option"]`
const SEARCH = '[data-testid="project-space-picker-search"]'
const SORT = '[data-testid="project-space-picker-sort"]'
const CHANGE = '[data-testid="work-item-change-board"]'

const projectKey = project => `backend:${project.id}`
const optionSelector = project =>
  `${OPTIONS}[data-project-space-key=${JSON.stringify(projectKey(project))}]`
const groupSelector = key =>
  `[data-testid="project-space-picker-group"][data-group-key=${JSON.stringify(key)}]`

async function optionKeys(control) {
  const count = Number(await control.command('getElementCount', OPTIONS))
  const keys = []
  for (let index = 1; index <= count; index += 1) {
    keys.push(
      await control.command('getAttribute', `${OPTIONS}:nth-child(${index})`, {
        value: 'data-project-space-key',
      })
    )
  }
  return keys
}

async function assertProjects(control, projects, message) {
  assert.deepEqual(await optionKeys(control), projects.map(projectKey), message)
}

export function createProjectSpacePickerRegression({
  request,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const marker = `Picker-${randomUUID().slice(0, 8)}`
  const workspaces = []
  const projects = []
  let spaceA, spaceB, project2, project10, sharedA, sharedB, targetIssue
  let cleaned = false

  const create = (pathname, values) =>
    request(pathname, { method: 'POST', body: JSON.stringify(values) })

  async function createProject(workspace, suffix) {
    const project = await create(`/api/v1/workspaces/${workspace.id}/projects`, {
      name: `${marker} ${suffix}`,
    })
    projects.push(project)
    return project
  }

  async function openTask(control, address) {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    const query = new URLSearchParams(address)
    await control.command('navigate', 'body', { value: `/runtime-tasks?${query}` })
    await control.command('waitFor', CHANGE, {
      visible: true,
      timeoutMs: workbenchReadyTimeoutMs,
    })
    const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    assert.equal(state.workbench?.currentRuntimeTask?.taskId, address.taskId)
  }

  return {
    async prepare() {
      // Creation order deliberately disagrees with name and workspace ordering.
      spaceB = await create('/api/v1/workspaces', { name: `${marker} Zulu` })
      workspaces.push(spaceB)
      spaceA = await create('/api/v1/workspaces', { name: `${marker} Alpha` })
      workspaces.push(spaceA)
      sharedB = await createProject(spaceB, 'Shared')
      project10 = await createProject(spaceA, 'Project 10')
      sharedA = await createProject(spaceA, 'Shared')
      project2 = await createProject(spaceA, 'Project 2')
      targetIssue = await create(`/api/v1/cloud-projects/${sharedB.id}/loop-items`, {
        title: `${marker} selected Issue`,
        status: 'completed',
      })
    },

    async verify(control, address) {
      const { taskId } = address
      await openTask(control, address)
      await control.command('click', CHANGE)
      for (const project of projects) {
        await control.command('waitFor', optionSelector(project), { timeoutMs: uiTimeoutMs })
      }
      assert.equal(await control.command('getValue', SORT), 'name-asc')
      await control.command('fill', SEARCH, { value: marker })
      await assertProjects(control, [project2, project10, sharedA, sharedB], 'Default name order')
      await control.command('select', SORT, { value: 'name-desc' })
      await assertProjects(
        control,
        [sharedA, sharedB, project10, project2],
        'Descending name order'
      )

      await control.command('click', groupSelector(`backend:${spaceA.id}`))
      await assertProjects(control, [sharedA, project10, project2], 'Descending within Space A')
      await control.command('select', SORT, { value: 'name-asc' })
      await assertProjects(control, [project2, project10, sharedA], 'Ascending within Space A')
      await control.command('click', groupSelector(`backend:${spaceB.id}`))
      await assertProjects(control, [sharedB], 'Space B must exclude all Space A projects')
      await control.command('click', groupSelector(`backend:${spaceA.id}`))
      await control.command('fill', SEARCH, { value: `${marker} Shared` })
      await assertProjects(control, [sharedA], 'Search and Space A must both constrain results')
      await control.command('click', groupSelector(`backend:${spaceB.id}`))
      await assertProjects(
        control,
        [sharedB],
        'Same-named projects must retain their space identity'
      )

      await control.command('click', groupSelector('all'))
      await control.command('fill', SEARCH, { value: spaceB.name })
      await assertProjects(control, [sharedB], 'Workspace name search must exclude other spaces')
      await control.command('fill', SEARCH, { value: `${spaceB.name} ${sharedB.project_key}` })
      await assertProjects(control, [sharedB], 'Search must combine owning space and project key')
      await control.command('fill', SEARCH, { value: marker })
      await control.command(
        'click',
        '[data-testid="project-space-picker-group"][data-group-key^="local"]'
      )
      await control.command('waitFor', '[data-testid="project-space-picker-empty"]')
      await assertProjects(control, [], 'Local space must exclude matching cloud projects')
      await control.command('click', '[data-testid="project-space-picker-clear-search"]')
      const localKeys = await optionKeys(control)
      assert.ok(localKeys.length > 0, 'The local import fixture must be selectable')
      assert.ok(
        localKeys.every(key => key.startsWith('local:')),
        'Local space leaked cloud projects'
      )

      await control.command('click', groupSelector('all'))
      await control.command('fill', SEARCH, { value: `${marker} Shared` })
      await assertProjects(
        control,
        [sharedA, sharedB],
        'Duplicate names must remain separate options'
      )
      for (const [project, workspace] of [
        [sharedA, spaceA],
        [sharedB, spaceB],
      ]) {
        assert.equal(
          await control.command('getAttribute', optionSelector(project), { value: 'aria-label' }),
          `${project.name} · ${workspace.name} · ${project.project_key}`
        )
      }
      await control.command('press', SEARCH, { key: 'ArrowDown' })
      await control.command('press', SEARCH, { key: 'Enter' })
      const target = `[data-testid="task-board-association-item-${targetIssue.id}"]`
      await control.command('waitFor', target, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command('click', target)
      await control.command('waitFor', '[data-testid="task-board-move-confirm"]')
      await control.command('clickWhenEnabled', '[data-testid="task-board-move-confirm"]')
      await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      const boundContext = `[data-testid="project-space-context-pill"][title^=${JSON.stringify(targetIssue.title)}]`
      await control.command('waitFor', boundContext, { timeoutMs: uiTimeoutMs })
      const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const task = state.workbench?.currentRuntimeTask
      assert.equal(
        task?.taskId,
        taskId,
        'Project selection must preserve the original runtime task'
      )
      const query = new URLSearchParams({ device_id: task.deviceId, task_id: taskId })
      const context = await request(`/api/v1/runtime-tasks/cloud-context?${query}`)
      assert.equal(context.project.id, sharedB.id, 'Selection bound the wrong same-named project')
      assert.equal(context.loop_item_id, targetIssue.id, 'The selected Issue binding was not saved')

      await reloadMainWindow(control, 'The picker regression could not reconnect after reload')
      await openTask(control, address)
      await control.command('waitFor', boundContext, { timeoutMs: uiTimeoutMs })
      await control.command('click', CHANGE)
      await control.command('waitFor', `${optionSelector(sharedB)}[aria-selected="true"]`)
      assert.equal(
        await control.command('getAttribute', optionSelector(sharedA), { value: 'aria-selected' }),
        'false',
        'Reload selected both same-named projects'
      )
      assert.equal(
        await control.command('getValue', SEARCH),
        '',
        'Reopening retained a stale search'
      )
      assert.equal(await control.command('getValue', SORT), 'name-asc')
      assert.equal(
        await control.command('getAttribute', groupSelector('all'), { value: 'aria-pressed' }),
        'true'
      )
      await control.command('press', SEARCH, { key: 'Escape' })
    },

    async cleanup() {
      if (cleaned) return
      const failures = []
      if (targetIssue) {
        try {
          await request(`/api/v1/loop-items/${targetIssue.id}`, { method: 'DELETE' })
          targetIssue = null
        } catch (error) {
          failures.push(error)
        }
      }
      for (const [collection, values] of [
        ['cloud-projects', projects],
        ['workspaces', workspaces],
      ]) {
        for (const fixture of values) {
          try {
            const latest = await request(`/api/v1/${collection}/${fixture.id}`)
            if (latest.status !== 'archived') {
              await request(`/api/v1/${collection}/${fixture.id}?version=${latest.version}`, {
                method: 'DELETE',
              })
            }
          } catch (error) {
            failures.push(error)
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Project picker fixture cleanup failed')
      }
      cleaned = true
    },
  }
}
