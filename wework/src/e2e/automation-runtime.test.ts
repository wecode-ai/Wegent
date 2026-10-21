import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  fillDesktopControlElement,
  isWeworkAutomationEnabled,
  runDesktopControlClient,
} from './automation'

afterEach(() => {
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Electron desktop E2E automation', () => {
  test.each([
    { html: 'interrupted', occurrence: 0 },
    { html: 'interrupted before <strong>interrupted</strong> after', occurrence: 1 },
  ])(
    'reads the active highlight at occurrence $occurrence in the exact requested message',
    async ({ html, occurrence }) => {
      const fixture = document.createElement('div')
      fixture.innerHTML = `
      <input data-testid="conversation-find-input" value="interrupted">
      <p data-testid="highlight-message">${html}</p>
      <p data-testid="highlight-message">The operation was interrupted after useful output</p>
    `
      document.body.append(fixture)
      const [message, partial] = fixture.querySelectorAll('p')
      const range = document.createRange()
      range.selectNodeContents(message.querySelector('strong') ?? message)
      const partialRange = document.createRange()
      partialRange.selectNodeContents(partial)
      const collapsed = document.createRange()
      collapsed.setStart(message.firstChild!, 0)
      Object.assign(range, {
        getBoundingClientRect: () => ({
          top: 100,
          bottom: 120,
          left: 20,
          right: 90,
          width: 70,
          height: 20,
        }),
      })
      const highlights = new Map([
        ['conversation-search-fixture', new Set([partialRange])],
        ['conversation-search-fixture-active', new Set([range, partialRange, collapsed])],
        ['unrelated-active', new Set([range])],
      ])
      vi.stubGlobal('CSS', { highlights })
      const results: Array<{ ok: boolean; value: string }> = []
      let polls = 0
      vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
        if (url.includes('/commands?')) {
          polls += 1
          if (polls > 1) return new Promise<Response>(() => {})
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'read-highlight',
                action: 'getConversationSearchHighlightMetrics',
                selector: '[data-testid="highlight-message"]',
                text: message.textContent,
              })
            )
          )
        }
        if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
        return Promise.resolve(new Response('{}'))
      })
      void runDesktopControlClient('http://127.0.0.1:43111', 'main')
      try {
        await vi.waitFor(() => expect(results).toHaveLength(1))
        expect(results[0].ok).toBe(true)
        expect(JSON.parse(results[0].value)).toEqual({
          query: 'interrupted',
          ranges: [
            {
              text: 'interrupted',
              occurrence,
              top: 100,
              bottom: 120,
              left: 20,
              right: 90,
              width: 70,
              height: 20,
            },
          ],
        })
        expect(highlights.get('conversation-search-fixture-active')?.size).toBe(3)
      } finally {
        fixture.remove()
      }
    }
  )

  test('stops frame sampling explicitly after the observed action completes', async () => {
    const root = document.createElement('div')
    root.dataset.testid = 'metrics-sampling-root'
    document.body.append(root)
    const commands = [
      { id: 'start-metrics', action: 'startElementMetricsSampling', value: '10000' },
      { id: 'stop-metrics', action: 'stopElementMetricsSampling' },
    ]
    const results: Array<{ ok: boolean; value?: string }> = []
    vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        const command = commands.shift()
        if (!command) return new Promise<Response>(() => {})
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...command,
              selector: '[data-testid="metrics-sampling-root"]',
            })
          )
        )
      }
      if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
      return Promise.resolve(new Response('{}'))
    })
    void runDesktopControlClient('http://127.0.0.1:43111', 'main')
    try {
      await vi.waitFor(() => expect(results).toHaveLength(2))
      expect(results.every(result => result.ok)).toBe(true)
      const sample = JSON.parse(results[1].value!)
      expect(sample.done).toBe(true)
      expect(sample.frames.length).toBeGreaterThan(0)
      expect(sample.frames.at(-1).time).toBeLessThan(10000)
    } finally {
      root.remove()
    }
  })

  test('does not turn an acknowledgement failure into a failed UI action', async () => {
    const button = document.createElement('button')
    button.dataset.testid = 'control-acknowledgement-button'
    const clicked = vi.fn()
    button.onclick = clicked
    document.body.append(button)
    const results: Array<{ ok: boolean }> = []
    let polls = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        polls += 1
        if (polls > 1) return new Promise<Response>(() => {})
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'acknowledgement-click',
              action: 'click',
              selector: '[data-testid="control-acknowledgement-button"]',
            })
          )
        )
      }
      if (url.endsWith('/results')) {
        results.push(JSON.parse(String(options?.body)))
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve(new Response('{}'))
    })
    void runDesktopControlClient('http://127.0.0.1:43111', 'main')
    try {
      await vi.waitFor(() => expect(polls).toBe(2))
      expect(clicked).toHaveBeenCalledOnce()
      expect(results).toHaveLength(1)
      expect(results[0].ok).toBe(true)
      expect(console.error).toHaveBeenCalledWith(
        '[Wework] Desktop E2E result acknowledgement failed:',
        expect.objectContaining({ action: 'click', actionSucceeded: true })
      )
    } finally {
      button.remove()
    }
  })

  test('acknowledges a completed action before polling for another command', async () => {
    const button = document.createElement('button')
    button.dataset.testid = 'control-ordering-button'
    const clicked = vi.fn()
    button.onclick = clicked
    document.body.append(button)
    let acknowledgeResult!: (value: Response) => void
    const resultAcknowledgement = new Promise<Response>(resolve => {
      acknowledgeResult = resolve
    })
    let polls = 0
    const fetch = vi.fn((url: string) => {
      if (url.includes('/commands?')) {
        polls += 1
        if (polls > 1) return new Promise<Response>(() => {})
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'ordered-click',
              action: 'click',
              selector: '[data-testid="control-ordering-button"]',
            })
          )
        )
      }
      if (url.endsWith('/results')) return resultAcknowledgement
      return Promise.resolve(new Response('{}'))
    })
    vi.stubGlobal('fetch', fetch)
    void runDesktopControlClient('http://127.0.0.1:43111', 'main')
    try {
      await vi.waitFor(() => expect(clicked).toHaveBeenCalledOnce())
      expect(polls).toBe(1)
      acknowledgeResult(new Response('{}'))
      await vi.waitFor(() => expect(polls).toBe(2))
    } finally {
      button.remove()
    }
  })

  test('is enabled by an injected runtime control URL', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      controlUrl: 'http://127.0.0.1:43111',
    }

    expect(isWeworkAutomationEnabled()).toBe(true)
  })

  test('is disabled explicitly for isolated plugin development instances', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      controlUrl: 'http://127.0.0.1:43111',
      disabled: true,
    }

    expect(isWeworkAutomationEnabled()).toBe(false)
  })

  test('allows an isolated plugin development instance to opt into desktop control', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      controlUrl: 'http://127.0.0.1:43111',
      windowLabel: 'plugin-development-example',
    }

    expect(isWeworkAutomationEnabled()).toBe(true)
  })

  test('fills a contenteditable through its atomic value setter when available', async () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    const updateApplicationState = vi.fn()
    Object.defineProperty(editor, 'value', {
      configurable: true,
      set: nextValue => {
        updateApplicationState(String(nextValue))
      },
    })
    document.body.append(editor)

    await fillDesktopControlElement(editor, 'WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK')

    expect(updateApplicationState).toHaveBeenCalledWith('WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK')
  })
})
