import { EventEmitter } from 'node:events'
import type { WebContents, WebFrameMain } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import {
  LIGHTWEIGHT_WORKBENCH_FRAME_NAME,
  protectLightweightWorkbenchFrames,
} from './lightweight-workbench-navigation.js'

function fixture(url = 'about:blank') {
  const contents = new EventEmitter()
  const parent = { name: '', url: 'http://127.0.0.1:1234/', parent: null } as WebFrameMain
  const frame = { name: LIGHTWEIGHT_WORKBENCH_FRAME_NAME, url, parent } as WebFrameMain
  protectLightweightWorkbenchFrames(contents as WebContents)
  contents.emit('frame-created', {}, { frame })
  const navigate = (destination: string, initiator: WebFrameMain | null = parent) => {
    const event = {
      url: destination,
      frame,
      initiator,
      isMainFrame: false,
      isSameDocument: false,
      preventDefault: vi.fn(),
    }
    // Electron emits one typed details object, not the legacy navigation arguments.
    contents.emit('will-frame-navigate', event)
    return event.preventDefault
  }
  return { contents, frame, parent, navigate }
}

describe('lightweight workbench frame navigation', () => {
  test('permits only the initial parent-owned srcDoc load', () => {
    const { frame, navigate } = fixture()
    expect(navigate('about:srcdoc')).not.toHaveBeenCalled()
    expect(navigate('about:srcdoc')).toHaveBeenCalledOnce()
    frame.url = 'about:srcdoc'
    expect(navigate('about:srcdoc')).toHaveBeenCalledOnce()
  })

  test.each([
    'https://remote.test/replacement',
    'http://127.0.0.1:1234/other',
    'data:text/html,replacement',
    'file:///tmp/replacement.html',
    'about:blank',
    'about:srcdoc',
  ])('rejects replacement with %s after the application renames itself', destination => {
    const { frame, navigate } = fixture('about:srcdoc')
    frame.name = 'renamed-by-application'
    expect(navigate(destination, frame)).toHaveBeenCalledOnce()
  })

  test('rejects self-initiated initial loads and protects descendants and other targets', () => {
    const { contents, frame, parent, navigate } = fixture()
    expect(navigate('about:srcdoc', frame)).toHaveBeenCalledOnce()
    frame.name = ''
    const child = { name: '', url: 'about:blank', parent: frame } as WebFrameMain
    contents.emit('frame-created', {}, { frame: child })
    for (const target of [child, parent, null]) {
      const event = {
        frame: target,
        initiator: frame,
        url: 'https://remote.test/',
        preventDefault: vi.fn(),
      }
      contents.emit('will-frame-navigate', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })

  test('blocks redirects without depending on the frame name or a previous navigation event', () => {
    const { contents, frame } = fixture('about:srcdoc')
    frame.name = ''
    const event = { frame, url: 'https://remote.test/', preventDefault: vi.fn() }
    contents.emit('will-redirect', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  test('leaves ordinary browser frames alone and installs each policy once', () => {
    const { contents, parent } = fixture()
    protectLightweightWorkbenchFrames(contents as WebContents)
    expect(contents.listenerCount('will-frame-navigate')).toBe(1)
    const ordinary = { name: 'ordinary', url: 'about:srcdoc', parent } as WebFrameMain
    const event = {
      frame: ordinary,
      initiator: parent,
      url: 'https://ordinary.test/',
      preventDefault: vi.fn(),
    }
    contents.emit('will-frame-navigate', event)
    contents.emit('will-redirect', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
