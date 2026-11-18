import assert from 'node:assert/strict'
import { createElement, Fragment, useEffect, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { stopBoundStandIn } from '../e2e/desktop/modules/stand-in-instance-flows.mjs'
import { installWeworkAutomationBridge, runDesktopControlClient } from '../src/e2e/automation'
import { WorkspaceTabsProvider } from '../src/features/workspace-tabs/WorkspaceTabsContext'
import { useWorkspaceTabs } from '../src/features/workspace-tabs/workspaceTabsContextValue'
import { labels } from '../src/features/workspace-tabs/workspaceTabsTestLabels'
import { CloudConnectionContext } from '../src/features/cloud-connection/CloudConnectionContext'
import { PersonalStandInWorkspace } from '../src/features/todo/PersonalStandInWorkspace'
import { StandInOverviewPage } from '../src/features/todo/StandInOverviewPage'
import { newStandInRole } from '../src/api/personalStandIn'
import * as runtimeEnvironment from '../src/lib/runtime-environment'
import * as clipboard from '../src/e2e/clipboard'
import '../src/i18n'

const fixtures = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: fixtures.request }))
vi.mock('../src/features/todo/weworkPlatformApi', () => ({
  createWeworkPlatformApi: () => ({ projects: { list: async () => [] } }),
}))
vi.mock('../src/features/todo/localWorkspaceApi', () => ({ createLocalWorkspaceApi: () => null }))
vi.mock('../src/features/todo/StandInConversation', () => ({ StandInConversation: () => null }))

const fixedTabs = [
  { id: 'fixed-task', kind: 'task', title: labels.task, contentRoute: '/', fixed: true },
  { id: 'fixed-board', kind: 'board', title: labels.board, contentRoute: '/todo', fixed: true },
]
const devices = []
const performanceDescriptor = Object.getOwnPropertyDescriptor(
  performance,
  'setResourceTimingBufferSize'
)

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/todo?workspaceTab=fixed-board')
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  vi.stubEnv('VITE_WEWORK_E2E_CLOUD_BACKEND_URL', '')
  vi.stubEnv('VITE_WEWORK_E2E_MODEL_SERVER_URL', '')
  vi.spyOn(runtimeEnvironment, 'isDesktopRuntime').mockReturnValue(false)
  vi.spyOn(clipboard, 'installDesktopE2EClipboard').mockImplementation(() => {})
  Object.defineProperty(performance, 'setResourceTimingBufferSize', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  delete window.__WEWORK_E2E__
  delete window.__WEWORK_RUNTIME_CONFIG__
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  if (performanceDescriptor)
    Object.defineProperty(performance, 'setResourceTimingBufferSize', performanceDescriptor)
  else Reflect.deleteProperty(performance, 'setResourceTimingBufferSize')
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function boundInstance({ reportStopped = true } = {}) {
  const target = { userId: 7, deviceId: 'remote-executor', backendUrl: 'https://cloud.test' }
  let binding = { status: 'active', version: 3, target }
  const settings = {
    userId: 7,
    executionDeviceId: target.deviceId,
    version: 1,
    roles: [newStandInRole(target.deviceId, 'reviewer')],
  }
  const api = {
    binding: vi.fn(async (_device, operation = 'get', version) => {
      if (operation === 'get') return binding
      assert.equal(version, binding.version)
      assert.equal(binding.target, target)
      if (operation === 'beginStop') {
        assert.equal(binding.status, 'active')
        binding = { ...binding, status: 'stopping', version: binding.version + 1 }
      } else {
        assert.equal(operation, 'completeStop')
        assert.equal(binding.status, 'stopping')
        binding = { ...binding, status: 'stopped', version: binding.version + 1 }
      }
      return binding
    }),
    lifecycle: vi.fn(async (userId, deviceId, operation) => {
      assert.equal(userId, target.userId)
      assert.equal(deviceId, target.deviceId)
      assert.equal(operation, 'stop')
      return { ...settings, lifecycle: { status: 'stopped' } }
    }),
    personalGet: vi.fn(async () => settings),
    personalSave: vi.fn(),
    memories: vi.fn(async () => []),
    onboarding: vi.fn(async () => ({ state: { version: 1, completed: false } })),
    completeOnboarding: vi.fn(),
    connectionProviders: vi.fn(async () => ({ items: [] })),
    catalog: vi.fn(async () => ({ models: [] })),
    personalAgents: vi.fn(async () => []),
    inbox: vi.fn(async () => ({ items: [], sourceErrors: [] })),
    proposal: vi.fn(async () => null),
    processingStatus: vi.fn(async () => ({ pendingCount: 0, running: false, actions: [] })),
  }
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local-device' }),
    modelApi: { listModels: async () => ({ data: [] }) },
    standInApi: api,
  }
  fixtures.request.mockImplementation(async (_control, method, params) => {
    assert.equal(method, 'runtime.stand_in.binding')
    assert.deepEqual(params, { operation: 'get' })
    return reportStopped ? binding : { ...binding, status: 'active' }
  })
  return { api, services, settings, target, getBinding: () => binding }
}

function OwnedStandInHost({ fixture }) {
  const tabs = useWorkspaceTabs()
  fixture.tabs = tabs
  const taskActive = tabs.activeTabId === 'fixed-task'
  const [taskVisited, setTaskVisited] = useState(taskActive)
  if (taskActive && !taskVisited) setTaskVisited(true)
  const task = tabs.tabs.find(tab => tab.id === 'fixed-task')
  // Fixed native board and task surfaces retain their host identity across routes.
  return createElement(
    Fragment,
    null,
    taskVisited &&
      createElement(
        'div',
        { hidden: !taskActive, 'aria-hidden': !taskActive },
        createElement(PersonalStandInWorkspace, {
          services: fixture.services,
          user: { id: 7 },
          devices,
          active: taskActive,
          contentRoute: task.contentRoute,
          entryRequestKey: fixture.entryRequestKeyForRoute?.(task.contentRoute),
          onClose: () => {},
        })
      ),
    !taskActive &&
      createElement(StandInOverviewPage, {
        services: fixture.services,
        userId: 7,
        api: {},
        devices,
        projects: [],
        initialDeviceId: fixture.target.deviceId,
      })
  )
}

function WorkspaceHost({ fixture }) {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }))
  useEffect(() => {
    const update = () =>
      setLocation({ pathname: window.location.pathname, search: window.location.search })
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  return createElement(
    WorkspaceTabsProvider,
    { ...location, storageScope: 'stand-in-stop-navigation', labels, fixedTabs },
    createElement(
      CloudConnectionContext.Provider,
      { value: { isConnected: true, apiBaseUrl: 'https://cloud.test' } },
      createElement(OwnedStandInHost, { fixture })
    )
  )
}

function desktopControl() {
  const commands = []
  return {
    commands,
    async command(action, selector, options = {}) {
      const command = { id: String(commands.length), action, selector, ...options }
      commands.push(command)
      let delivered = false
      let result
      vi.stubGlobal('fetch', async (url, request) => {
        if (url.includes('/commands?')) {
          if (delivered) return new Response(null, { status: 410 })
          delivered = true
          return new Response(JSON.stringify(command))
        }
        if (url.endsWith('/results')) result = JSON.parse(request.body)
        return new Response('{}')
      })
      await act(async () => runDesktopControlClient('http://127.0.0.1:43111', 'main'))
      assert.ok(result, `Missing result for ${action}`)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
  }
}

test('desktop navigation selects the owned task surface before stopping from unfinished board onboarding', async () => {
  const fixture = boundInstance()
  render(createElement(WorkspaceHost, { fixture }))
  await screen.findByTestId('stand-in-onboarding')
  const control = desktopControl()
  await control.command('navigate', 'body', { value: '/stand-in?profileId=@primary' })

  expect(fixture.tabs.activeTabId).toBe('fixed-task')
  expect(fixture.tabs.tabs.find(tab => tab.id === 'fixed-board')).toEqual(fixedTabs[1])
  expect(await screen.findByTestId('stand-in-primary-profile')).toBeInTheDocument()
  expect(fixture.getBinding().target).toBe(fixture.target)
  await stopBoundStandIn(control, 1000)
  expect(screen.getByTestId('stand-in-instance-stopped')).toBeInTheDocument()
  expect(fixture.getBinding().status).toBe('stopped')
  expect(fixture.api.lifecycle).toHaveBeenCalledExactlyOnceWith(7, 'remote-executor', 'stop')
  expect(fixture.api.completeOnboarding).not.toHaveBeenCalled()
  expect(fixtures.request).toHaveBeenCalledOnce()
})

test('the original stop helper opens the bound profile through the workspace navigation action', async () => {
  const fixture = boundInstance()
  render(createElement(WorkspaceHost, { fixture }))
  await screen.findByTestId('stand-in-onboarding')
  const control = desktopControl()
  await stopBoundStandIn(control, 1000)
  expect(fixture.tabs.activeTabId).toBe('fixed-task')
  expect(fixture.tabs.tabs.find(tab => tab.id === 'fixed-board')).toEqual(fixedTabs[1])
  expect(fixture.getBinding()).toEqual({ status: 'stopped', version: 5, target: fixture.target })
  expect(fixture.api.completeOnboarding).not.toHaveBeenCalled()
  expect(control.commands.filter(command => command.action === 'navigate')).toHaveLength(1)
})

test.each([true, false])(
  'opens primary settings in a retained task with onboarding completed=%s',
  async completed => {
    window.history.replaceState({}, '', '/stand-in?workspaceTab=fixed-task')
    const fixture = boundInstance()
    fixture.api.onboarding.mockResolvedValue({ state: { version: 1, completed } })
    render(createElement(WorkspaceHost, { fixture }))
    const overview = await screen.findByTestId('stand-in-overview')
    expect(screen.queryByTestId('stand-in-instance-stop')).not.toBeInTheDocument()
    const control = desktopControl()

    await control.command('navigate', 'body', { value: '/stand-in?profileId=@primary' })

    expect(fixture.tabs.activeTabId).toBe('fixed-task')
    expect(screen.getByTestId('stand-in-overview')).toBe(overview)
    expect(screen.queryByTestId('stand-in-primary-profile')).toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-instance-stop')).toBeInTheDocument()
    await stopBoundStandIn(control, 1000)
    expect(fixture.getBinding().status).toBe('stopped')
  }
)

test('returns from the board to the retained primary workspace without replacing its overview', async () => {
  window.history.replaceState({}, '', '/stand-in?workspaceTab=fixed-task')
  const fixture = boundInstance()
  fixture.api.onboarding.mockResolvedValue({ state: { version: 1, completed: true } })
  render(createElement(WorkspaceHost, { fixture }))
  const overview = await screen.findByTestId('stand-in-overview')
  act(() => fixture.tabs.selectTab('fixed-board'))
  const control = desktopControl()

  await control.command('navigate', 'body', { value: '/stand-in?profileId=@primary' })

  expect(fixture.tabs.activeTabId).toBe('fixed-task')
  expect(screen.getByTestId('stand-in-overview')).toBe(overview)
  expect(screen.getByTestId('stand-in-primary-profile')).toBeInTheDocument()
  await stopBoundStandIn(control, 1000)
  expect(fixture.getBinding().status).toBe('stopped')
})

test.each([false, true])(
  'keeps the same draft and guards a role route once with layout entry keys=%s',
  async layoutEntryKeys => {
    window.history.replaceState({}, '', '/stand-in?profileId=@primary&workspaceTab=fixed-task')
    const fixture = boundInstance()
    if (layoutEntryKeys)
      fixture.entryRequestKeyForRoute = vi.fn(route =>
        route === '/stand-in?profileId=reviewer' ? 1 : 0
      )
    render(createElement(WorkspaceHost, { fixture }))
    const user = userEvent.setup()
    const field = await screen.findByTestId('stand-in-preferences')
    await user.type(field, 'Keep this primary draft')
    const control = desktopControl()

    await control.command('navigate', 'body', { value: '/stand-in?profileId=@primary' })
    expect(screen.getByTestId('stand-in-preferences')).toBe(field)
    expect(field).toHaveValue('Keep this primary draft')
    expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()

    const readsBeforeRole = fixture.api.binding.mock.calls.length
    await control.command('navigate', 'body', { value: '/stand-in?profileId=reviewer' })
    if (layoutEntryKeys) expect(fixture.api.binding).toHaveBeenCalledTimes(readsBeforeRole + 1)
    await user.click(await screen.findByTestId('stand-in-primary-keep-editing'))
    expect(screen.getByTestId('stand-in-preferences')).toBe(field)
    expect(field).toHaveValue('Keep this primary draft')
    expect(screen.queryByTestId('stand-in-role-name')).not.toBeInTheDocument()

    await control.command('navigate', 'body', { value: '/stand-in?profileId=reviewer' })
    if (layoutEntryKeys) expect(fixture.api.binding).toHaveBeenCalledTimes(readsBeforeRole + 2)
    await user.click(await screen.findByTestId('stand-in-primary-discard'))
    expect(await screen.findByTestId('stand-in-role-name')).toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()
    expect(fixture.getBinding().target).toBe(fixture.target)
    expect(fixture.api.binding.mock.calls.every(call => !call[1])).toBe(true)
    expect(fixture.api.personalSave).not.toHaveBeenCalled()
    if (layoutEntryKeys)
      expect(fixture.entryRequestKeyForRoute).toHaveBeenCalledWith('/stand-in?profileId=reviewer')
  }
)

test('preserves a dirty memory panel until a retained profile request is confirmed', async () => {
  window.history.replaceState({}, '', '/stand-in?profileId=@primary&workspaceTab=fixed-task')
  const fixture = boundInstance()
  render(createElement(WorkspaceHost, { fixture }))
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-memory-open'))
  await user.click(await screen.findByTestId('stand-in-memory-add'))
  const field = screen.getByTestId('stand-in-memory-content')
  await user.type(field, 'Keep this memory draft')
  const control = desktopControl()

  await control.command('navigate', 'body', { value: '/stand-in?profileId=reviewer' })
  await user.click(await screen.findByTestId('stand-in-memory-keep'))
  expect(screen.getByTestId('stand-in-memory-content')).toBe(field)
  expect(field).toHaveValue('Keep this memory draft')

  await control.command('navigate', 'body', { value: '/stand-in?profileId=reviewer' })
  await user.click(await screen.findByTestId('stand-in-memory-discard'))
  expect(await screen.findByTestId('stand-in-role-name')).toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-memory-discard')).not.toBeInTheDocument()
  expect(fixture.getBinding().target).toBe(fixture.target)
  expect(fixture.api.personalSave).not.toHaveBeenCalled()
})

test('guards a different device before opening its role and retains the primary binding', async () => {
  window.history.replaceState({}, '', '/stand-in?profileId=@primary&workspaceTab=fixed-task')
  const fixture = boundInstance()
  fixture.api.personalGet.mockImplementation(async (userId, deviceId) => ({
    ...fixture.settings,
    userId,
    executionDeviceId: deviceId,
    roles: [newStandInRole(deviceId, 'reviewer')],
  }))
  render(createElement(WorkspaceHost, { fixture }))
  const user = userEvent.setup()
  const field = await screen.findByTestId('stand-in-preferences')
  await user.type(field, 'Keep this device draft')
  const control = desktopControl()
  const route = '/stand-in?deviceId=second-executor&profileId=reviewer'

  await control.command('navigate', 'body', { value: route })
  await user.click(await screen.findByTestId('stand-in-primary-keep-editing'))
  expect(screen.getByTestId('stand-in-preferences')).toBe(field)
  expect(field).toHaveValue('Keep this device draft')
  expect(fixture.api.personalGet.mock.calls.some(call => call[1] === 'second-executor')).toBe(false)

  await control.command('navigate', 'body', { value: route })
  await user.click(await screen.findByTestId('stand-in-primary-discard'))
  expect(await screen.findByTestId('stand-in-role-name')).toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-primary-discard')).not.toBeInTheDocument()
  expect(fixture.api.personalGet).toHaveBeenCalledWith(7, 'second-executor')
  expect(fixture.getBinding().target).toBe(fixture.target)
  expect(fixture.api.binding.mock.calls.every(call => !call[1])).toBe(true)

  await control.command('navigate', 'body', { value: '/stand-in?profileId=@primary' })
  expect(screen.getByTestId('stand-in-primary-profile')).toBeInTheDocument()
  expect(fixture.getBinding().target).toBe(fixture.target)
  expect(fixture.api.personalSave).not.toHaveBeenCalled()
})

test.each([true, false])(
  'an open bound profile still requires authoritative stopped state: %s',
  async reportStopped => {
    window.history.replaceState({}, '', '/stand-in?profileId=@primary&workspaceTab=fixed-task')
    const fixture = boundInstance({ reportStopped })
    render(createElement(WorkspaceHost, { fixture }))
    await screen.findByTestId('stand-in-instance-stop')
    const control = desktopControl()
    if (reportStopped) await stopBoundStandIn(control, 1000)
    else await assert.rejects(stopBoundStandIn(control, 1000), /active.*stopped/s)
    expect(control.commands.some(command => command.action === 'navigate')).toBe(false)
    expect(fixture.api.lifecycle).toHaveBeenCalledOnce()
    expect(fixture.api.completeOnboarding).not.toHaveBeenCalled()
  }
)

test('bridge navigation uses the same owned workspace route as the desktop command', async () => {
  const fixture = boundInstance()
  render(createElement(WorkspaceHost, { fixture }))
  await screen.findByTestId('stand-in-onboarding')
  const navigation = vi.fn()
  window.addEventListener('wework:e2e:navigation', navigation)
  try {
    await installWeworkAutomationBridge()
    await act(async () => window.__WEWORK_E2E__.navigate('/stand-in?profileId=@primary'))
    expect(fixture.tabs.activeTabId).toBe('fixed-task')
    expect(fixture.tabs.tabs.find(tab => tab.id === 'fixed-board')).toEqual(fixedTabs[1])
    expect(await screen.findByTestId('stand-in-instance-stop')).toBeInTheDocument()
    expect(navigation).toHaveBeenCalledOnce()
  } finally {
    window.removeEventListener('wework:e2e:navigation', navigation)
  }
})

test('standalone navigation retains the application base path and navigation notification', async () => {
  window.__WEWORK_RUNTIME_CONFIG__ = { appBasePath: '/wework/app' }
  const control = desktopControl()
  const navigation = vi.fn()
  window.addEventListener('wework:e2e:navigation', navigation)
  try {
    expect(
      await control.command('navigate', 'body', { value: 'stand-in?profileId=@primary' })
    ).toBe('/stand-in')
    expect(window.location.pathname).toBe('/wework/app/stand-in')
    expect(window.location.search).toBe('?profileId=@primary')
    expect(navigation).toHaveBeenCalledOnce()
  } finally {
    window.removeEventListener('wework:e2e:navigation', navigation)
  }
})
