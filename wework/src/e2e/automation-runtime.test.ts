import { afterEach, describe, expect, test, vi } from 'vitest'
import { expandCompletedProcessing } from '../../e2e/desktop/modules/streaming-text-fixture.mjs'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
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
  test.each([false, true])(
    'expands processing without a cross-command read/click race (initially expanded: %s)',
    async initiallyExpanded => {
      const root = document.createElement('div')
      root.dataset.testid = 'desktop-workbench-main'
      root.dataset.activeWorkbenchPane = 'true'
      const final = document.createElement('button')
      final.dataset.testid = 'final-processing-toggle'
      final.setAttribute('aria-expanded', String(initiallyExpanded))
      final.disabled = true
      const summary = document.createElement('button')
      summary.dataset.testid = 'processing-summary-toggle'
      summary.setAttribute('aria-expanded', 'false')
      const finalClicked = vi.fn(() => {
        final.setAttribute('aria-expanded', 'true')
        root.append(summary)
      })
      const summaryClicked = vi.fn(() => summary.setAttribute('aria-expanded', 'true'))
      final.onclick = finalClicked
      summary.onclick = summaryClicked
      root.append(final)
      if (initiallyExpanded) root.append(summary)
      document.body.append(root)

      const queued: DesktopControlCommand[] = []
      const pending = new Map<
        string,
        {
          command: DesktopControlCommand
          resolve: (value: string) => void
          reject: (error: Error) => void
        }
      >()
      let deliver: ((response: Response) => void) | undefined
      let sequence = 0
      vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
        if (url.includes('/commands?')) {
          const next = queued.shift()
          if (next) return Promise.resolve(new Response(JSON.stringify(next)))
          return new Promise<Response>(resolve => {
            deliver = resolve
          })
        }
        if (url.endsWith('/results')) {
          const result = JSON.parse(String(options?.body)) as {
            id: string
            ok: boolean
            value?: string
            error?: string
          }
          const operation = pending.get(result.id)!
          pending.delete(result.id)
          // Reproduce native recovery between the attribute response and the next click.
          if (
            operation.command.action === 'getAttribute' &&
            operation.command.selector.includes('final-processing-toggle')
          ) {
            final.remove()
          }
          if (!result.ok) root.append(final)
          if (result.ok) operation.resolve(result.value ?? '')
          else operation.reject(new Error(result.error))
        }
        return Promise.resolve(new Response('{}'))
      })
      void runDesktopControlClient('http://127.0.0.1:43111', 'main')
      const control = {
        command: (action: string, selector: string, options: Partial<DesktopControlCommand> = {}) =>
          new Promise<string>((resolve, reject) => {
            const command = { id: String(++sequence), action, selector, ...options }
            pending.set(command.id, { command, resolve, reject })
            if (deliver) {
              const send = deliver
              deliver = undefined
              send(new Response(JSON.stringify(command)))
            } else queued.push(command)
          }),
      }
      const enableFinal = window.setTimeout(() => {
        final.disabled = false
      }, 50)
      try {
        await expandCompletedProcessing(control, 1000)
        expect(final).toBeInTheDocument()
        expect(summary).toBeInTheDocument()
        expect(final).toHaveAttribute('aria-expanded', 'true')
        expect(summary).toHaveAttribute('aria-expanded', 'true')
        expect(finalClicked).toHaveBeenCalledTimes(initiallyExpanded ? 0 : 1)
        expect(summaryClicked).toHaveBeenCalledOnce()
      } finally {
        window.clearTimeout(enableFinal)
        root.remove()
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
