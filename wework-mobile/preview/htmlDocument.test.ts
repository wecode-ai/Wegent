import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { installHtmlReadingBridge } from './htmlDocument'

describe('isolated HTML reading controls', () => {
  function fixture() {
    const handlers = new Map<string, (event: unknown) => void>()
    const parent = { postMessage: vi.fn() }
    const host = { dataset: { theme: '' }, style: { setProperty: vi.fn() } }
    const scrollTo = vi.fn()
    const mountModes = vi.fn((_host, _mode, theme) => {
      host.dataset.theme = theme
    })
    runInNewContext(`(${installHtmlReadingBridge.toString()})(mountModes, 'styles', 'light')`, {
      parent,
      mountModes,
      scrollTo,
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        handlers.set(type, listener),
      document: { createElement: () => host, body: { prepend: vi.fn() } },
    })
    handlers.get('DOMContentLoaded')!({})
    return {
      host,
      mountModes,
      scrollTo,
      send: (type: string, value: unknown, source: unknown = parent) =>
        handlers.get('message')!({
          source,
          data: { channel: 'wework-html-reading', type, value },
        }),
    }
  }

  it('changes the existing controls theme without rebuilding the controls or moving the document', () => {
    const { host, send, mountModes, scrollTo } = fixture()
    expect(host.dataset.theme).toBe('light')
    send('theme', 'dark')
    expect(host.dataset.theme).toBe('dark')
    send('theme', 'light')
    expect(host.dataset.theme).toBe('light')
    expect(mountModes).toHaveBeenCalledOnce()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('rejects unknown themes and messages from another frame', () => {
    const { host, send } = fixture()
    send('theme', 'dark', {})
    send('theme', 'system')
    send('theme', { theme: 'dark' })
    expect(host.dataset.theme).toBe('light')
  })
})
