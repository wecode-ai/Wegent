import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  reloadMainWindow,
  waitForLocalExecutorReady,
  waitForWorkbenchTask,
} from './workspace-flows.mjs'

const MENU = '[data-testid="work-item-context-menu"]'
const OPTIONS = `${MENU} [role="option"]`
const SEARCH = '[data-testid="project-space-picker-search"]'
const SORT = '[data-testid="project-space-picker-sort"]'
const CHANGE = '[data-testid="work-item-change-board"]'
const GROUPING = '[data-testid="project-space-picker-toggle-workspaces"]'
const CLEAR_SEARCH = '[data-testid="project-space-picker-clear-search"]'
const EMPTY = '[data-testid="project-space-picker-empty"]'

const projectKey = project => `backend:${project.id}`
const optionSelector = project =>
  `${OPTIONS}[data-project-space-key=${JSON.stringify(projectKey(project))}]`
const groupSelector = key =>
  `[data-testid="project-space-picker-group"][data-group-key=${JSON.stringify(key)}]`

function isTransientPickerError(error) {
  return /Unable to find selector|Timed out waiting for selector/.test(String(error))
}

export function createPickerSession(control, timeoutMs) {
  const state = {
    groupByWorkspace: false,
    groupSelector: groupSelector('all'),
    query: '',
    order: 'name-asc',
  }

  const raw = (action, selector, options = {}) => control.command(action, selector, options)
  const menuOpen = async () => Number(await raw('getElementCount', MENU)) > 0

  async function openMenu() {
    await raw('clickWhenEnabled', CHANGE, { visible: true, timeoutMs })
    await raw('waitFor', MENU, { visible: true, stableMs: 500, timeoutMs })
    await raw('waitFor', `${CHANGE}[aria-expanded="true"]`, { timeoutMs })
  }

  async function restoreState() {
    const groupingPressed = await raw('getAttribute', GROUPING, { value: 'aria-pressed' })
    if (groupingPressed !== String(state.groupByWorkspace)) {
      await raw('clickWhenEnabled', GROUPING, { visible: true, timeoutMs })
    }
    const groupPressed = await raw('getAttribute', state.groupSelector, {
      value: 'aria-pressed',
    })
    if (groupPressed !== 'true') {
      await raw('clickWhenEnabled', state.groupSelector, { visible: true, timeoutMs })
    }
    if ((await raw('getValue', SORT)) !== state.order) {
      await raw('select', SORT, { value: state.order })
    }
    if ((await raw('getValue', SEARCH)) !== state.query) {
      await raw('fill', SEARCH, { value: state.query })
    }
  }

  async function ensureOpenState() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!(await menuOpen())) await openMenu()
        await restoreState()
        return
      } catch (error) {
        if (!isTransientPickerError(error) || attempt === 2) throw error
      }
    }
  }

  async function command(action, selector, options = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ensureOpenState()
      try {
        return await raw(action, selector, options)
      } catch (error) {
        if (!isTransientPickerError(error) || attempt === 2) throw error
      }
    }
  }

  async function setGroupByWorkspace(enabled) {
    if (state.groupByWorkspace === enabled) return
    await command('clickWhenEnabled', GROUPING, { visible: true, timeoutMs })
    state.groupByWorkspace = enabled
    state.groupSelector = groupSelector('all')
    await command('waitFor', `${GROUPING}[aria-pressed="${enabled}"]`, { timeoutMs })
  }

  async function optionKeys() {
    const count = Number(await command('getElementCount', OPTIONS))
    const keys = []
    for (let index = 1; index <= count; index += 1) {
      keys.push(
        await command('getAttribute', `${OPTIONS}:nth-child(${index})`, {
          value: 'data-project-space-key',
        })
      )
    }
    return keys
  }

  return {
    open: ensureOpenState,
    command,
    optionKeys,
    async setQuery(query) {
      await command('fill', SEARCH, { value: query })
      state.query = query
    },
    async setOrder(order) {
      await command('select', SORT, { value: order })
      state.order = order
    },
    setGroupByWorkspace,
    async selectGroup(selector) {
      await command('clickWhenEnabled', selector, { visible: true, timeoutMs })
      state.groupSelector = selector
    },
    async clearSearch() {
      await command('clickWhenEnabled', CLEAR_SEARCH, { visible: true, timeoutMs })
      state.query = ''
    },
  }
}

async function assertProjects(picker, projects, timeoutMs, message) {
  let keys = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (projects.length) {
      await picker.command('waitFor', optionSelector(projects[0]), { timeoutMs })
    } else {
      await picker.command('waitFor', EMPTY, { timeoutMs })
    }
    keys = await picker.optionKeys()
    if (keys.length === projects.length) break
  }
  assert.deepEqual(keys, projects.map(projectKey), message)
}

/*
 * Project data refreshes can briefly replace the picker's controls. Keep the
 * intended filter state and reopen the menu after an exact selector timeout.
 */
async function selectGroup(picker, selector) {
  await picker.selectGroup(selector)
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
    await waitForLocalExecutorReady(control, workbenchReadyTimeoutMs)
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-task"]', {
      visible: true,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    const query = new URLSearchParams(address)
    await control.command('navigate', 'body', { value: `/runtime-tasks?${query}` })
    await waitForWorkbenchTask(
      control,
      address.taskId,
      'The project picker task did not finish restoring after navigation'
    )
    const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    assert.equal(state.workbench?.currentRuntimeTask?.taskId, address.taskId)
    // Restoring a task re-resolves its cloud binding asynchronously: the
    // composer drops its Issue binding, and with it the change-board control,
    // until the lookup returns. Wait for the post-restore control instead of
    // the one rendered before the restore, which the click would no longer hit.
    await control.command('waitFor', CHANGE, {
      visible: true,
      timeoutMs: workbenchReadyTimeoutMs,
    })
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
      // The session reopens and restores picker state if a binding refresh
      // replaces the visible control.
      const picker = createPickerSession(control, uiTimeoutMs)
      await picker.open()
      for (const project of projects) {
        await picker.command('waitFor', optionSelector(project), { timeoutMs: uiTimeoutMs })
      }
      assert.equal(await picker.command('getValue', SORT), 'name-asc')
      await picker.setQuery(marker)
      await assertProjects(
        picker,
        [project2, project10, sharedA, sharedB],
        uiTimeoutMs,
        'Default name order'
      )
      await picker.setOrder('name-desc')
      await assertProjects(
        picker,
        [sharedA, sharedB, project10, project2],
        uiTimeoutMs,
        'Descending name order'
      )

      assert.equal(
        await picker.command('getAttribute', GROUPING, { value: 'aria-pressed' }),
        'false',
        'The picker must default to storage groups'
      )
      await selectGroup(picker, groupSelector('backend'))
      await assertProjects(
        picker,
        [sharedA, sharedB, project10, project2],
        uiTimeoutMs,
        'Remote projects must include projects from both spaces'
      )
      await picker.setQuery(spaceB.name)
      await assertProjects(
        picker,
        [sharedB],
        uiTimeoutMs,
        'Storage grouping must retain space-name search'
      )
      await picker.setQuery(marker)
      await picker.setGroupByWorkspace(true)
      await selectGroup(picker, groupSelector(`backend:${spaceA.id}`))
      await assertProjects(
        picker,
        [sharedA, project10, project2],
        uiTimeoutMs,
        'Descending within Space A'
      )
      await picker.setOrder('name-asc')
      await assertProjects(
        picker,
        [project2, project10, sharedA],
        uiTimeoutMs,
        'Ascending within Space A'
      )
      await selectGroup(picker, groupSelector(`backend:${spaceB.id}`))
      await assertProjects(
        picker,
        [sharedB],
        uiTimeoutMs,
        'Space B must exclude all Space A projects'
      )
      await selectGroup(picker, groupSelector(`backend:${spaceA.id}`))
      await picker.setQuery(`${marker} Shared`)
      await assertProjects(
        picker,
        [sharedA],
        uiTimeoutMs,
        'Search and Space A must both constrain results'
      )
      await selectGroup(picker, groupSelector(`backend:${spaceB.id}`))
      await assertProjects(
        picker,
        [sharedB],
        uiTimeoutMs,
        'Same-named projects must retain their space identity'
      )

      await selectGroup(picker, groupSelector('all'))
      await picker.setQuery(spaceB.name)
      await assertProjects(
        picker,
        [sharedB],
        uiTimeoutMs,
        'Workspace name search must exclude other spaces'
      )
      await picker.setQuery(`${spaceB.name} ${sharedB.project_key}`)
      await assertProjects(
        picker,
        [sharedB],
        uiTimeoutMs,
        'Search must combine owning space and project key'
      )
      await picker.setQuery(marker)
      await selectGroup(
        picker,
        '[data-testid="project-space-picker-group"][data-group-key^="local"]'
      )
      await assertProjects(
        picker,
        [],
        uiTimeoutMs,
        'Local space must exclude matching cloud projects'
      )
      await picker.clearSearch()
      const localKeys = await picker.optionKeys()
      assert.ok(localKeys.length > 0, 'The local import fixture must be selectable')
      assert.ok(
        localKeys.every(key => key.startsWith('local:')),
        'Local space leaked cloud projects'
      )

      await selectGroup(picker, groupSelector('all'))
      await picker.setQuery(`${marker} Shared`)
      await assertProjects(
        picker,
        [sharedA, sharedB],
        uiTimeoutMs,
        'Duplicate names must remain separate options'
      )
      for (const [project, workspace] of [
        [sharedA, spaceA],
        [sharedB, spaceB],
      ]) {
        assert.equal(
          await picker.command('getAttribute', optionSelector(project), { value: 'aria-label' }),
          `${project.name} · ${workspace.name} · ${project.project_key}`
        )
      }
      await picker.command('press', SEARCH, { key: 'ArrowDown' })
      await picker.command('press', SEARCH, { key: 'Enter' })
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
      const reopened = createPickerSession(control, uiTimeoutMs)
      await reopened.open()
      await reopened.command('waitFor', `${optionSelector(sharedB)}[aria-selected="true"]`)
      assert.equal(
        await reopened.command('getAttribute', optionSelector(sharedA), {
          value: 'aria-selected',
        }),
        'false',
        'Reload selected both same-named projects'
      )
      assert.equal(
        await reopened.command('getValue', SEARCH),
        '',
        'Reopening retained a stale search'
      )
      assert.equal(await reopened.command('getValue', SORT), 'name-asc')
      assert.equal(
        await reopened.command('getAttribute', groupSelector('all'), { value: 'aria-pressed' }),
        'true'
      )
      await reopened.command('press', SEARCH, { key: 'Escape' })
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
