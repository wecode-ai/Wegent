// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  createPickerSession,
  createProjectSpacePickerRegression,
} from '../e2e/desktop/modules/project-space-picker.mjs'

const MENU = '[data-testid="work-item-context-menu"]'
const SEARCH = '[data-testid="project-space-picker-search"]'
const SORT = '[data-testid="project-space-picker-sort"]'
const CHANGE = '[data-testid="work-item-change-board"]'
const GROUPING = '[data-testid="project-space-picker-toggle-workspaces"]'
const ALL_GROUP = '[data-testid="project-space-picker-group"][data-group-key="all"]'
const spaceGroup = key =>
  `[data-testid="project-space-picker-group"][data-group-key=${JSON.stringify(key)}]`

function fixtureBackend({ failCreateAt } = {}) {
  const resources = new Map()
  const failures = new Map()
  const calls = []
  const preparationFailure = new Error('Project creation failed')
  let creates = 0
  const request = async (pathname, { method = 'GET', body } = {}) => {
    const path = pathname.split('?')[0]
    const key = `${method} ${path}`
    calls.push(key)
    if (failures.has(key)) throw failures.get(key)
    if (method === 'POST') {
      creates += 1
      if (creates === failCreateAt) throw preparationFailure
      const resource = { status: 'active', ...JSON.parse(body), id: String(creates), version: 1 }
      const collection = path.endsWith('/workspaces')
        ? 'workspaces'
        : path.endsWith('/projects')
          ? 'cloud-projects'
          : 'loop-items'
      assert.ok(collection !== 'loop-items' || path.endsWith('/loop-items'))
      resources.set(`/api/v1/${collection}/${resource.id}`, resource)
      return resource
    }
    const resource = resources.get(path)
    assert.ok(resource, `Unknown fixture: ${path}`)
    if (method === 'DELETE') {
      if (path.includes('/loop-items/')) assert.equal(resource.status, 'completed')
      else {
        assert.equal(
          new URLSearchParams(pathname.split('?')[1]).get('version'),
          String(resource.version)
        )
      }
      resource.status = 'archived'
      resource.version += 1
    }
    return resource
  }
  return { request, resources, failures, calls, preparationFailure }
}

function pickerControl() {
  const state = {
    open: false,
    groupByWorkspace: false,
    group: 'all',
    sort: 'name-asc',
    query: '',
  }
  let failNextSelect = false
  const requireOpen = () => {
    if (!state.open) throw new Error(`Unable to find selector "${MENU}"`)
  }
  const groupKey = selector => {
    const match = /data-group-key=("(?:[^"\\]|\\.)*")/.exec(selector)
    return match ? JSON.parse(match[1]) : null
  }

  return {
    state: () => ({ ...state }),
    remount() {
      Object.assign(state, {
        open: false,
        groupByWorkspace: false,
        group: 'all',
        sort: 'name-asc',
        query: '',
      })
    },
    failNextSelect() {
      failNextSelect = true
    },
    async command(action, selector, options = {}) {
      if (action === 'getElementCount' && selector === MENU) return Number(state.open)
      if (action === 'clickWhenEnabled' && selector === CHANGE) {
        state.open = true
        return ''
      }
      requireOpen()
      if (action === 'waitFor') return ''
      if (action === 'getAttribute' && selector === GROUPING) {
        return String(state.groupByWorkspace)
      }
      if (
        action === 'getAttribute' &&
        selector.startsWith('[data-testid="project-space-picker-group"]')
      ) {
        return String(state.group === groupKey(selector))
      }
      if (action === 'clickWhenEnabled' && selector === GROUPING) {
        state.groupByWorkspace = !state.groupByWorkspace
        state.group = 'all'
        return ''
      }
      if (action === 'clickWhenEnabled' && selector === ALL_GROUP) {
        state.group = 'all'
        return ''
      }
      if (action === 'clickWhenEnabled' && selector.includes('data-group-key=')) {
        state.group = groupKey(selector)
        return ''
      }
      if (action === 'getValue' && selector === SORT) return state.sort
      if (action === 'getValue' && selector === SEARCH) return state.query
      if (action === 'select' && selector === SORT) {
        if (failNextSelect) {
          failNextSelect = false
          state.open = false
          throw new Error(`Timed out waiting for selector "${SORT}"`)
        }
        state.sort = options.value
        return options.value
      }
      if (action === 'fill' && selector === SEARCH) {
        state.query = options.value
        return options.value
      }
      throw new Error(`Unexpected picker command: ${action} ${selector}`)
    },
  }
}

test('restores picker filters and retries after a transient remount', async () => {
  const control = pickerControl()
  const picker = createPickerSession(control, 1_000)
  const targetGroup = spaceGroup('backend:space-a')
  await picker.open()
  await picker.setQuery('Picker')
  await picker.setOrder('name-desc')
  await picker.setGroupByWorkspace(true)
  await picker.selectGroup(targetGroup)

  control.remount()
  assert.equal(await picker.command('getValue', SEARCH), 'Picker')
  assert.deepEqual(control.state(), {
    open: true,
    groupByWorkspace: true,
    group: 'backend:space-a',
    sort: 'name-desc',
    query: 'Picker',
  })

  control.failNextSelect()
  await picker.setOrder('name-asc')
  assert.deepEqual(control.state(), {
    open: true,
    groupByWorkspace: true,
    group: 'backend:space-a',
    sort: 'name-asc',
    query: 'Picker',
  })
})

test('cleans every recorded fixture after a partial preparation failure', async () => {
  const backend = fixtureBackend({ failCreateAt: 5 })
  const regression = createProjectSpacePickerRegression({ request: backend.request })
  await assert.rejects(regression.prepare(), error => error === backend.preparationFailure)
  assert.equal(backend.resources.size, 4)

  await regression.cleanup()

  assert.ok([...backend.resources.values()].every(resource => resource.status === 'archived'))
  const calls = backend.calls.length
  await regression.cleanup()
  assert.equal(backend.calls.length, calls, 'Completed cleanup must not request a stopped backend')
})

test('attempts all fixtures, reports all failures, and allows failed cleanup to be completed', async () => {
  const backend = fixtureBackend()
  const regression = createProjectSpacePickerRegression({ request: backend.request })
  await regression.prepare()
  const paths = [...backend.resources.keys()]
  const project = paths.find(path => path.includes('/cloud-projects/'))
  const workspace = paths.find(path => path.includes('/workspaces/'))
  const readFailure = new Error('Project lookup failed')
  const deleteFailure = new Error('Workspace deletion failed')
  backend.failures.set(`GET ${project}`, readFailure)
  backend.failures.set(`DELETE ${workspace}`, deleteFailure)

  await assert.rejects(regression.cleanup(), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [readFailure, deleteFailure])
    return true
  })

  for (const [path, resource] of backend.resources) {
    assert.equal(resource.status, [project, workspace].includes(path) ? 'active' : 'archived')
  }
  backend.failures.clear()
  await regression.cleanup()
  assert.ok([...backend.resources.values()].every(resource => resource.status === 'archived'))
  const calls = backend.calls.length
  await regression.cleanup()
  assert.equal(backend.calls.length, calls)
})

test('archives the Issue before its project and continues cleanup after an Issue failure', async () => {
  const backend = fixtureBackend()
  const regression = createProjectSpacePickerRegression({ request: backend.request })
  await regression.prepare()
  const issue = [...backend.resources.keys()].find(path => path.includes('/loop-items/'))
  const failure = new Error('Issue archival failed')
  backend.failures.set(`DELETE ${issue}`, failure)

  await assert.rejects(regression.cleanup(), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [failure])
    return true
  })

  for (const [path, resource] of backend.resources) {
    assert.equal(resource.status, path === issue ? 'completed' : 'archived')
  }
  const issueDelete = backend.calls.indexOf(`DELETE ${issue}`)
  const projectDelete = backend.calls.findIndex(call =>
    call.startsWith('DELETE /api/v1/cloud-projects/')
  )
  assert.ok(
    issueDelete >= 0 && issueDelete < projectDelete,
    'Issue cleanup must precede project cleanup'
  )
  backend.failures.clear()
  await regression.cleanup()
  assert.ok([...backend.resources.values()].every(resource => resource.status === 'archived'))
  const calls = backend.calls.length
  await regression.cleanup()
  assert.equal(backend.calls.length, calls)
})
