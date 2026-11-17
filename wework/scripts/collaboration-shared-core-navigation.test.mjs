// @vitest-environment node
import assert from 'node:assert/strict'
import { afterEach, expect, test, vi } from 'vitest'
import { createProjectOnlyNavigationRegression } from '../e2e/desktop/modules/project-only-navigation.mjs'
import {
  assertCreatedMembers,
  createOrdinaryTaskProject,
  selectProjectCreateMembers,
  verifyCollaborationMemberSettings,
} from '../e2e/desktop/modules/collaboration-member-settings.mjs'
import { projectCreateLabels } from '../../packages/collaboration/src/project-create/labels'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'

// These unit tests drive the actual navigation callers; other board regressions
// keep their own real E2E assertions in the shared-core checkpoint.
vi.mock('../e2e/desktop/modules/collaboration-board-preferences.mjs', () => ({
  verifyBoardPreferenceIsolation: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/collaboration-board-field-drag.mjs', () => ({
  createReadOnlyBoardIssues: async () => [{ id: 'assigned' }],
  verifyReadOnlyBoardDrag: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/collaboration-board-personal-view.mjs', async original => ({
  ...(await original()),
  createBoardFilterIssues: async () => [{ id: 'assigned' }],
  verifyPersonalAssigneeFilter: vi.fn(),
  verifyPersonalBoardGrouping: vi.fn(),
  selectProjectBoardGrouping: vi.fn(),
  assertProjectBoardGrouping: vi.fn(),
}))

const content = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${content} ${selector}`
const owner = { id: 7, user_name: 'reader' }

function controlFixture(compact, memberSettings = false) {
  let fixedBoardMounted = true
  const command = vi.fn(async (action, selector, input) => {
    if (action === 'reloadMainWindow') fixedBoardMounted = false
    if (selector === '[data-testid="workspace-tab-select-fixed-board"]') {
      // A reconnected renderer can precede the restored shell tab's mount.
      if (action === 'waitFor' || action === 'clickWhenEnabled') fixedBoardMounted = true
      if (action === 'click')
        assert.ok(fixedBoardMounted, 'The restored Collaboration tab has not mounted')
    }
    if (action === 'getStartupSplashSnapshot') return JSON.stringify({ state: 'closed' })
    if (action === 'getElementCount') {
      if (selector.includes('collaboration-project-view-select')) return compact ? '1' : '0'
      return memberSettings && selector.includes('[role="cell"]') ? '4' : '0'
    }
    if (action === 'getAttribute') return 'true'
    if (selector.includes('collaboration-tab-') && action !== 'chooseWhenEnabled') {
      assert.equal(compact, false, 'Compact layout does not mount wide tabs')
      assert.equal(action, 'clickWhenEnabled')
      assert.deepEqual(input, { visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
    }
    if (action === 'chooseWhenEnabled') {
      assert.equal(
        selector,
        `${scoped('[data-testid="collaboration-project-view-select"]')}, ${scoped(`[data-testid="collaboration-tab-${input.value}"]`)}`
      )
      assert.deepEqual(input, {
        value: input.value,
        visible: true,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      })
    }
    return ''
  })
  return { command, readyCount: 1, awaitReadyAfter: vi.fn(async () => undefined) }
}

function backendFixture() {
  const projects = []
  const workspace = { id: 'workspace' }
  return vi.fn(async (url, input = {}) => {
    const path = new URL(url).pathname
    const method = input.method ?? 'GET'
    const reader = input.headers.Authorization === 'Bearer reader'
    let status = 200
    let value = {}
    if (path === '/api/admin/users') value = { id: 8, user_name: 'creator' }
    else if (path === '/api/auth/login') value = { access_token: 'creator' }
    else if (path === '/api/v1/workspaces' && method === 'POST') value = workspace
    else if (path === '/api/v1/workspaces') value = { items: [] }
    else if (path === '/api/v1/workspaces/workspace/projects') {
      value = {
        ...JSON.parse(input.body),
        id: `project-${projects.length}`,
        workspace_id: workspace.id,
      }
      projects.push(value)
    } else if (path.startsWith('/api/v1/workspaces/')) status = 404
    else if (path === '/api/v1/cloud-projects') {
      value = {
        items: projects.slice(0, 2).map((project, index) => ({
          ...project,
          access_role: index === 0 ? 'Viewer' : 'Developer',
          workspace_context: workspace,
          workspace_access_role: null,
          permission_sources: [
            index === 0
              ? { type: 'public', role: 'Viewer' }
              : { type: 'direct', role: 'Developer' },
          ],
        })),
      }
    } else if (reader && path.includes('/project-2')) status = 404
    else if (path.endsWith('/execution-environments')) value = { items: [] }
    else if (reader && method === 'POST' && path.endsWith('/loop-items')) status = 403
    else if (method === 'DELETE') status = 204
    else if (path === '/api/v1/loop-items/assigned') value = { assignee_user_id: owner.id }
    else if (path === '/api/v1/cloud-projects/project-1') value = { version: 1, board_config: {} }
    else if (!path.endsWith('/members'))
      assert.fail(`Unexpected fixture request: ${method} ${path}`)
    return status === 204 ? new Response(null, { status }) : Response.json(value, { status })
  })
}

afterEach(() => vi.unstubAllGlobals())

test('ordinary project creation starts at the real Tasks board and shares member selection', async () => {
  const project = { id: 'ordinary-project', name: 'Ordinary Tasks project' }
  const members = [
    { id: 8, user_name: 'alice' },
    { id: 9, user_name: 'bob' },
  ]
  const command = vi.fn(async action => (action === 'getElementCount' ? '0' : ''))
  const request = vi.fn(async () => ({ items: [project] }))
  expect(
    await createOrdinaryTaskProject({ command }, { name: project.name, members, owner, request })
  ).toEqual(project)
  expect(command).toHaveBeenCalledWith(
    'waitFor',
    '[data-testid="workspace-tab-content-fixed-task"] [data-testid="task-board-surface"]',
    { visible: true }
  )
  expect(command).toHaveBeenCalledWith('click', '[data-testid="task-board-create-project-space"]')
  for (const member of members) {
    expect(command).toHaveBeenCalledWith(
      'waitFor',
      `[data-testid="collaboration-project-create-selected-member-${member.id}"]`,
      { text: member.user_name }
    )
  }
  expect(request).toHaveBeenCalledWith('/api/v1/cloud-projects')
})

test.each(['duplicate', 'viewer', 'inherited-only'])(
  'both creation entries reject an unverified member roster: %s',
  async failure => {
    const member = {
      user_id: 8,
      role: failure === 'viewer' ? 'Viewer' : 'Developer',
      direct_role: failure === 'inherited-only' ? null : 'Developer',
    }
    const roster = [{ user_id: owner.id }, member, ...(failure === 'duplicate' ? [member] : [])]
    await expect(
      assertCreatedMembers(
        { command: vi.fn() },
        {
          scoped,
          members: [{ id: 8, user_name: 'alice' }],
          owner,
          project: { id: 'ordinary-project' },
          request: async () => roster,
        }
      )
    ).rejects.toThrow()
  }
)

test.each([0, 1])(
  'member creation follows the current search feedback and rejects a duplicate creator, count=%s',
  async creatorCount => {
    const members = [
      { id: 8, user_name: 'alice' },
      { id: 9, user_name: 'bob' },
    ]
    const command = vi.fn(async (action, selector, input) => {
      if (
        action === 'waitFor' &&
        selector === '[data-testid="collaboration-project-create-collaborator-menu"] p'
      ) {
        expect(input).toEqual({
          text: projectCreateLabels['zh-CN'].noMatchingCollaborators,
          visible: true,
          stableMs: 250,
        })
      }
      if (action === 'getElementCount') return String(creatorCount)
      return ''
    })

    const selection = selectProjectCreateMembers({ command }, { members, owner })
    if (creatorCount) {
      await expect(selection).rejects.toThrow(
        'Searching for the creator must not offer a duplicate project membership'
      )
      return
    }
    await selection
    for (const member of members) {
      expect(command).toHaveBeenCalledWith(
        'waitFor',
        `[data-testid="collaboration-project-create-selected-member-${member.id}"]`,
        { text: member.user_name }
      )
    }
  }
)

test.each([false, true])(
  'project-only shared-core navigation uses actual controls, compact=%s',
  async compact => {
    vi.stubGlobal('fetch', backendFixture())
    const regression = createProjectOnlyNavigationRegression({
      uiTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      executorHome: '/fixture',
    })
    await regression.prepare({ backendUrl: 'https://backend.invalid', authToken: 'reader' }, owner)
    const control = controlFixture(compact)
    await regression.verify(control, scoped)
    const switches = control.command.mock.calls.filter(([action]) => action === 'chooseWhenEnabled')
    // Both project-only entries and both later grouping checks must navigate.
    expect(switches).toHaveLength(4)
    expect(control.command).toHaveBeenCalledWith(
      'waitFor',
      scoped('[data-testid="cloud-project-header"]'),
      {
        text: `Public reader ${process.pid}`,
        timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      }
    )
  }
)

test.each([false, true])(
  'member settings enter and leave through actual controls, compact=%s',
  async compact => {
    const control = controlFixture(compact, true)
    const members = [
      { id: 8, user_name: 'alice' },
      { id: 9, user_name: 'bob' },
    ]
    const project = { id: 'project', name: 'Created project members' }
    const request = vi.fn(async () => [
      { user_id: owner.id, inherited_role: 'Maintainer' },
      ...members.map(member => ({
        user_id: member.id,
        user_name: member.user_name,
        role: 'Developer',
        direct_role: 'Developer',
      })),
    ])
    await verifyCollaborationMemberSettings(control, {
      scoped,
      owner,
      project,
      members,
      request,
    })
    const switches = control.command.mock.calls.filter(([action]) => action === 'chooseWhenEnabled')
    expect(switches).toHaveLength(3)
    expect(switches.map(([, , input]) => input.value)).toEqual(['manage', 'manage', 'board'])
    expect(control.command).toHaveBeenCalledWith(
      'waitFor',
      scoped('[data-testid="cloud-project-members-inheritance-note"]')
    )
    expect(request.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ['/api/v1/cloud-projects/project/members'])
    )
    expect(control.command).toHaveBeenCalledWith('getStartupSplashSnapshot', 'body')
    expect(control.command).toHaveBeenCalledWith('reloadMainWindow', 'body')
    expect(control.awaitReadyAfter).toHaveBeenCalledWith(1)
    expect(control.command).toHaveBeenCalledWith(
      'clickWhenEnabled',
      '[data-testid="workspace-tab-select-fixed-board"]',
      { visible: true }
    )
    expect(control.command).toHaveBeenCalledWith(
      'waitFor',
      scoped('[data-testid="cloud-project-header-title"]'),
      { text: project.name, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    for (const member of members) {
      const rowSelector = scoped(`[data-testid="cloud-project-member-${member.id}"]`)
      const rowWaits = control.command.mock.calls.filter(
        ([action, selector]) => action === 'waitFor' && selector === rowSelector
      )
      expect(rowWaits).toEqual([
        ['waitFor', rowSelector, { text: member.user_name }],
        ['waitFor', rowSelector, { text: member.user_name }],
      ])
    }
  }
)
