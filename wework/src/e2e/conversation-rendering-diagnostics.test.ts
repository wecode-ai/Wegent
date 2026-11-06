import { afterEach, expect, test, vi } from 'vitest'
import { collectConversationRenderingDiagnostics } from './conversation-rendering-diagnostics'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const nativeState = async (capability: string) =>
  capability === 'window.getState'
    ? {
        platform: 'linux',
        visible: true,
        maximized: true,
        focused: false,
        bounds: { x: 0, y: 0, width: 1280, height: 720 },
        normalBounds: { x: 4, y: 0, width: 1272, height: 716 },
        ignoredSecret: 'credential-never-capture',
      }
    : { backgroundThrottling: false, backgroundTimerThrottlingDisabled: false }

test('captures virtualizer inputs, fresh viewport geometry, ancestors and native visibility without text', async () => {
  document.body.innerHTML = `<main data-testid="desktop-workbench-main" data-active-workbench-pane="true">
    <div data-testid="desktop-workbench-content" style="visibility:hidden">
      <div data-conversation-message-list data-conversation-layout-width="0"
        data-conversation-message-count="2" data-conversation-visible-count="2"
        data-conversation-virtual-messages="true" data-conversation-viewport-ready="false"
        data-conversation-virtualizer-enabled="false" data-conversation-virtual-row-count="0"
        data-conversation-virtual-range="null" data-conversation-scroll-rect="null"
        data-conversation-scroll-connected="false" data-conversation-scroll-element="none">
        <span data-message-id="private-message" data-testid="message-assistant">private-prompt-never-capture</span>
      </div>
    </div></main>`
  const viewport = document.querySelector<HTMLElement>('[data-testid="desktop-workbench-content"]')!
  vi.spyOn(viewport, 'clientWidth', 'get').mockReturnValue(420)
  vi.spyOn(viewport, 'clientHeight', 'get').mockReturnValue(643)
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280)
  const snapshot = await collectConversationRenderingDiagnostics(nativeState)
  const lists = snapshot.elements.lists.items
  expect(snapshot.document).toMatchObject({
    widthAtLeast1280: true,
    messageCount: 1,
    assistantCount: 1,
  })
  expect(lists[0]).toMatchObject({
    viewportContainsList: true,
    inputs: {
      layoutWidth: 0,
      messageCount: 2,
      visibleCount: 2,
      viewportReady: false,
      virtualizerEnabled: false,
      virtualRowCount: 0,
      scrollConnected: false,
    },
    ancestors: [
      expect.objectContaining({
        clientWidth: 420,
        clientHeight: 643,
        style: expect.objectContaining({ visibility: 'hidden' }),
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    ],
  })
  expect(snapshot.native.window).toMatchObject({
    status: 'ok',
    value: {
      maximized: true,
      visible: true,
      bounds: { width: 1280 },
      normalBounds: { width: 1272 },
    },
  })
  expect(JSON.stringify(snapshot)).not.toMatch(
    /private-message|private-prompt|credential-never-capture/
  )
})

test('distinguishes an absent message list from existing unpainted DOM without enabling memory diagnostics', async () => {
  document.body.innerHTML =
    '<div data-testid="desktop-workbench-content" hidden><article data-message-id="message" data-testid="message-assistant"></article></div>'
  const snapshot = await collectConversationRenderingDiagnostics(nativeState)
  expect(snapshot.elements.lists.count).toBe(0)
  expect(snapshot.elements.viewports.items[0]).toMatchObject({ hidden: true, connected: true })
  expect(snapshot.document.assistantCount).toBe(1)
})

test('whitelists range, native state and binding markers and reports native failures explicitly', async () => {
  document.body.innerHTML =
    '<div data-conversation-message-list data-conversation-scroll-element="private-binding" data-conversation-virtual-range=\'{"startIndex":0,"endIndex":1,"private":"secret"}\' data-conversation-scroll-rect="invalid"></div>'
  const snapshot = await collectConversationRenderingDiagnostics(async () => {
    throw new Error('credential-never-capture')
  })
  expect(snapshot.elements.lists.items[0]).toMatchObject({
    inputs: {
      scrollElement: 'other',
      virtualRange: { startIndex: 0, endIndex: 1 },
      scrollRect: { invalid: true },
    },
  })
  expect(snapshot.native).toEqual({
    window: { status: 'error', name: 'Error' },
    background: { status: 'error', name: 'Error' },
  })
  expect(JSON.stringify(snapshot)).not.toMatch(/private-binding|secret|credential-never-capture/)
})

test('reads current geometry again on each explicit snapshot', async () => {
  const viewport = document.createElement('div')
  viewport.dataset.testid = 'desktop-workbench-content'
  document.body.append(viewport)
  const height = vi.spyOn(viewport, 'clientHeight', 'get').mockReturnValue(0)
  const first = await collectConversationRenderingDiagnostics(nativeState)
  height.mockReturnValue(643)
  const second = await collectConversationRenderingDiagnostics(nativeState)
  expect(first.elements.viewports.items[0].clientHeight).toBe(0)
  expect(second.elements.viewports.items[0].clientHeight).toBe(643)
})
