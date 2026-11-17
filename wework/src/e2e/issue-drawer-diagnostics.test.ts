import { afterEach, expect, test, vi } from 'vitest'
import { collectIssueDrawerDiagnostics } from './issue-drawer-diagnostics'

afterEach(() => {
  document.body.replaceChildren()
  history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

test('captures close state and retained instance records without Issue content or route IDs', () => {
  history.replaceState(
    {},
    '',
    '/wework/app/todo?projectId=private-project&itemId=private-issue&focusRequest=private-focus&token=private-token'
  )
  document.body.innerHTML =
    '<div class="issue-conversation-drawers" data-diagnostic-instance="42" data-dismissing="true" data-has-conversation="false" style="transform:translateX(100px)">private-issue-body</div>'
  const track = document.querySelector<HTMLElement>('.issue-conversation-drawers')!
  Object.defineProperty(track, 'getAnimations', {
    value: () => [{ playState: 'paused', currentTime: 55, pending: false }],
  })
  const previous = {
    id: 1,
    timestamp: '2026-11-18T00:00:00Z',
    args: ['[Wework] Issue drawer diagnostic', '{"instanceId":41,"phase":"unmounted"}'],
  }
  const snapshot = collectIssueDrawerDiagnostics([
    previous,
    { id: 2, timestamp: previous.timestamp, args: ['unrelated', 'private-unrelated-log'] },
  ])

  expect(snapshot).toMatchObject({
    route: { isTodo: true, hasProjectId: true, hasItemId: true, hasFocusRequest: true },
    tracks: [
      {
        instanceId: 42,
        dismissing: true,
        hasConversation: false,
        animations: [{ property: 'other', playState: 'paused', currentTime: 55 }],
      },
    ],
    lifecycle: [previous],
  })
  expect(JSON.stringify(snapshot)).not.toContain('private-')
})

test('reports collection failure without throwing into the existing failure snapshot', () => {
  document.body.innerHTML = '<div class="issue-conversation-drawers"></div>'
  const track = document.querySelector<HTMLElement>('.issue-conversation-drawers')!
  Object.defineProperty(track, 'getAnimations', {
    value: () => {
      throw new Error('Unavailable')
    },
  })
  expect(collectIssueDrawerDiagnostics([])).toEqual({ unavailable: true })
})
