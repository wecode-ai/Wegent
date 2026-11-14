import { afterEach, expect, test, vi } from 'vitest'
import { verifyCollaborationExpNotificationTab } from '../../e2e/desktop/modules/collaboration-exp-issue-flows.mjs'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import * as desktopHost from '@/api/dsh/desktopHost'
import type { DesktopControlResult } from './desktop-control-command'
import { runDesktopControlClient } from './automation'

const initialLocation = window.location.href
const experimentId = 'workspace-tab-select-fixed-collaboration-exp'
const pendingId = 'workspace-tab-select-pending-interactions'
const tabSelector = `[data-testid="${experimentId}"]`
const appSelector = '[data-testid="collaboration-exp-app"]'
const experimentRoute =
  '/collaboration-exp?view=tasks&projectStore=local&projectId=personal&issueId=selected&future=keep&workspaceTab=fixed-collaboration-exp&workspaceTabTitle=Experiment'

afterEach(() => {
  document.body.replaceChildren()
  window.history.replaceState(null, '', initialLocation)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function startControlProtocol() {
  const commands: DesktopControlCommand[] = []
  const pending: Array<DesktopControlCommand> = []
  const results = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >()
  let poll: ((response: Response) => void) | undefined
  let stopped = false
  vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
    if (url.includes('/commands?')) {
      const next = pending.shift()
      if (next) return Response.json(next)
      if (stopped) return new Response(null, { status: 410 })
      return new Promise<Response>(resolve => {
        poll = resolve
      })
    }
    if (url.endsWith('/results')) {
      const result = JSON.parse(String(options?.body)) as DesktopControlResult
      const waiting = results.get(result.id)
      if (!waiting) throw new Error(`Unexpected control result: ${result.id}`)
      results.delete(result.id)
      if (result.ok) waiting.resolve(result.value ?? '')
      else waiting.reject(new Error(result.error))
    }
    return Response.json({})
  })
  const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')
  return {
    commands,
    control: {
      command(action: string, selector: string, options: Partial<DesktopControlCommand> = {}) {
        const command = { ...options, id: String(commands.length), action, selector }
        commands.push(command)
        return new Promise<string>((resolve, reject) => {
          results.set(command.id, { resolve, reject })
          if (poll) {
            const deliver = poll
            poll = undefined
            deliver(Response.json(command))
          } else pending.push(command)
        })
      },
    },
    async close() {
      stopped = true
      poll?.(new Response(null, { status: 410 }))
      await client
    },
  }
}

type NavigationFault = 'duplicate' | 'query' | 'identity' | 'count'

function mountNotificationNavigation(fault?: NavigationFault) {
  window.history.replaceState(null, '', experimentRoute)
  document.body.innerHTML = `<button role="tab" aria-selected="true" data-testid="${experimentId}">Experiment</button><main data-testid="collaboration-exp-app">Tasks</main>`
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 100, 30)
  )
  const experiment = document.querySelector<HTMLButtonElement>(tabSelector)!
  const app = document.querySelector<HTMLElement>(appSelector)!
  let pending: HTMLButtonElement | undefined
  let notifications = 0
  const appendTab = (id: string) => {
    const tab = document.createElement('button')
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', 'false')
    tab.dataset.testid = id
    document.body.append(tab)
    return tab
  }
  experiment.addEventListener('click', () => {
    pending?.setAttribute('aria-selected', 'false')
    experiment.setAttribute('aria-selected', 'true')
    app.style.display = ''
    const route = new URL(experimentRoute, window.location.origin)
    if (fault === 'query') route.searchParams.delete('future')
    window.history.replaceState(null, '', route)
  })
  return vi.spyOn(desktopHost, 'invokeDesktopHost').mockImplementation(async (method, params) => {
    if (method !== 'e2e.activateNotification') throw new Error(`Unexpected host command: ${method}`)
    notifications += 1
    pending ??= appendTab(pendingId)
    if (fault === 'identity' && notifications === 2)
      pending.dataset.testid = `${pendingId}-replaced`
    if (fault === 'count' && notifications === 2) appendTab('workspace-tab-select-unexpected')
    if (fault === 'duplicate' && notifications === 1) appendTab(experimentId)
    experiment.setAttribute('aria-selected', 'false')
    pending.setAttribute('aria-selected', 'true')
    app.style.display = 'none'
    const requestKey = new URL(String(params?.url)).pathname.split('/').at(-1)!
    window.history.replaceState(
      null,
      '',
      `/pending-interactions?workspaceTab=pending-interactions&interaction=${requestKey}`
    )
    return true as never
  })
}

async function verifyNavigation(fault?: NavigationFault) {
  const native = mountNotificationNavigation(fault)
  const protocol = startControlProtocol()
  try {
    await verifyCollaborationExpNotificationTab({
      control: protocol.control,
      conversation: { deviceId: 'native-device', taskId: 'bound-task' },
      appSelector,
      tabSelector,
      click: (control: typeof protocol.control, selector: string) =>
        control.command('click', selector),
      uiTimeoutMs: 1000,
    })
    return { native, commands: protocol.commands }
  } finally {
    await protocol.close()
  }
}

test('retains the notification tab identity, singleton, count and complete experiment query through the real control protocol', async () => {
  const { native, commands } = await verifyNavigation()
  expect(native.mock.calls).toEqual(
    ['experiment-navigation-first', 'experiment-navigation-second'].map(requestKey => [
      'e2e.activateNotification',
      { url: `wework://interactions/native-device/bound-task/${requestKey}` },
    ])
  )
  const metrics = commands.filter(command => command.action === 'getElementMetrics')
  expect(metrics).toHaveLength(4)
  for (const command of metrics) {
    expect(JSON.parse(command.value!)).toMatchObject({ includeText: true })
    if (command.selector.includes('[aria-selected="true"]'))
      expect(JSON.parse(command.value!)).toMatchObject({ waitForMatch: true })
  }
  expect(window.location.pathname + window.location.search).toBe(experimentRoute)
})

test.each([
  ['duplicate', /2 !== 1/],
  ['query', /The original experiment query must be retained/],
  ['identity', /pending-interactions-replaced/],
  ['count', /Repeated notifications must reuse one tab/],
] as const)(
  'rejects %s regressions through actual renderer snapshots and metrics',
  async (fault, message) => {
    await expect(verifyNavigation(fault)).rejects.toThrow(message)
  }
)
