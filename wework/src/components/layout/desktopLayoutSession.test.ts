import { expect, test, vi } from 'vitest'
import {
  requestNewChatComposerFocus,
  WORKBENCH_NEW_CHAT_FOCUS_EVENT,
} from '@/lib/workbenchComposerFocus'
import { createDesktopLayoutSession, type DesktopLayoutInput } from './desktopLayoutSession'
import { createDesktopLayoutState } from './desktopLayoutState'

test('opening a saved task supersedes a pending new chat focus request', () => {
  const frames: FrameRequestCallback[] = []
  const animationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.push(callback)
    return frames.length
  })
  const session = createDesktopLayoutSession(createDesktopLayoutState('/'), 'test', null)
  const activatePane = vi.fn()
  const unsubscribe = session
    .observe({
      activatePane,
      blankPaneKey: 'blank:0',
      getImSettings: undefined,
      loadTranscript: vi.fn(),
      ownedRoute: '/',
      routeActive: true,
      runtimeWork: null,
      services: {} as DesktopLayoutInput['services'],
      sidebarCollapsed: false,
      workItemSurfaceOpen: true,
    })
    .subscribe(vi.fn())
  window.addEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, session.consumeComposer)
  try {
    requestNewChatComposerFocus()
    frames.shift()?.(0)
    expect(activatePane).toHaveBeenLastCalledWith('blank:0')

    requestNewChatComposerFocus()
    session.activateRuntimeTaskPane('runtime:device:goal-task')
    frames.shift()?.(1)

    expect(activatePane.mock.calls).toEqual([['blank:0'], ['runtime:device:goal-task']])
  } finally {
    window.removeEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, session.consumeComposer)
    unsubscribe()
    animationFrame.mockRestore()
  }
})
