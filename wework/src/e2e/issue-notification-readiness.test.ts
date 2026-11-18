// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/issue-notification-read.scenario.mjs'
import { createBarrier } from '../test/async-barrier'

const active = '[data-workspace-tab-content][aria-hidden="false"]'
const close = `${active} [data-testid="cloud-todo-detail-close"]`
const detail = `${active} [data-testid="collaboration-issue-detail"]`
const badge = '[data-testid="wework-notifications-unread"]'

afterEach(() => vi.unstubAllGlobals())

async function fixture(closeError?: Error) {
  const notices: { id: string; item_id: string; read_at: string | null }[] = []
  let issueCount = 0
  let currentIssue = ''
  const closed: string[] = []
  const entered = [createBarrier(), createBarrier()]
  const ready = [createBarrier(), createBarrier()]
  const unread = () => notices.filter(item => !item.read_at).length
  const readIssue = (id: string) => {
    currentIssue = id
    notices.filter(item => item.item_id === id).forEach(item => (item.read_at = 'read'))
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options?: RequestInit) => {
      const path = new URL(input).pathname
      let value: unknown
      if (path === '/api/v1/wework-notifications') {
        if (options?.method === 'POST') {
          const body = JSON.parse(String(options.body))
          const notice = { id: `notice-${notices.length}`, item_id: body.item_id, read_at: null }
          notices.push(notice)
          value = { ...body, ...notice }
        } else value = { items: notices, unread_count: unread() }
      } else if (path.endsWith('/loop-items')) {
        value = { id: `issue-${++issueCount}`, is_unread: false }
      } else value = { id: path.endsWith('/projects') ? 'project' : 'workspace' }
      return Response.json(value)
    })
  )
  const command = vi.fn(
    async (
      action: string,
      selector: string,
      options?: { text?: string; visible?: boolean; value?: string }
    ) => {
      if (action === 'getElementCount') return 0
      if (action === 'activateSystemNotification' || action === 'openWeworkScheme') {
        readIssue(options!.value!.split('/').at(-1)!)
      } else if (selector === close) {
        // The badge has updated while the refreshed drawer control is still absent.
        if (action === 'click') throw new Error('The close control is not mounted yet')
        expect(action).toBe('clickWhenEnabled')
        if (closeError) throw closeError
        const index = closed.length
        entered[index].release()
        await ready[index].promise
        closed.push(currentIssue)
      } else if (action === 'waitFor' && selector === detail && options?.visible === false) {
        expect(closed).toContain(currentIssue)
      } else if (
        action === 'click' &&
        selector.endsWith('[data-testid="cloud-todo-card-issue-3"]')
      ) {
        readIssue('issue-3')
      } else if (action === 'waitFor' && selector === badge) {
        expect(unread()).toBe(options?.visible === false ? 0 : Number(options?.text))
      }
      return undefined
    }
  )
  const scenario = createDesktopScenario({ uiTimeoutMs: 1000 })
  await scenario.prepareCloud({ backendUrl: 'http://fixture.test', authToken: 'fixture-token' })
  return { command, scenario, notices, closed, entered, ready }
}

test('both notification entry points wait for the refreshed drawer before closing it', async () => {
  const state = await fixture()
  const verification = state.scenario.verify({ command: state.command })
  try {
    for (let index = 0; index < 2; index += 1) {
      await Promise.race([state.entered[index].promise, verification])
      expect(state.closed).toHaveLength(index)
      expect(state.notices[2].read_at).toBeNull()
      expect(
        state.command.mock.calls.filter(
          ([action, selector]) => action === 'waitFor' && selector === detail
        )
      ).toHaveLength(index)
      state.ready[index].release()
    }
    await verification
    expect(state.closed).toEqual(['issue-1', 'issue-2'])
    expect(state.notices).toHaveLength(4)
    expect(state.notices.every(item => item.read_at === 'read')).toBe(true)
  } finally {
    state.ready.forEach(barrier => barrier.release())
  }
})

test('an unavailable owned close control fails without retrying or advancing to the next Issue', async () => {
  const error = new Error('Owned drawer close control stayed unavailable')
  const state = await fixture(error)
  await expect(state.scenario.verify({ command: state.command })).rejects.toBe(error)
  expect(state.closed).toEqual([])
  expect(state.notices[1].read_at).toBeNull()
  expect(state.command.mock.calls.filter(([, selector]) => selector === close)).toHaveLength(1)
  expect(
    state.command.mock.calls.some(
      ([action, selector]) => action === 'waitFor' && selector === detail
    )
  ).toBe(false)
})
