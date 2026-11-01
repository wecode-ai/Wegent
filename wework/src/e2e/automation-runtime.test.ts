import { afterEach, describe, expect, test, vi } from 'vitest'
import { expandCompletedProcessing } from '../../e2e/desktop/modules/streaming-text-fixture.mjs'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import * as desktopHost from '@/api/dsh/desktopHost'
import {
  fillDesktopControlElement,
  isWeworkAutomationEnabled,
  runDesktopControlClient,
  seedDesktopE2ELocalModels,
  seedDesktopE2ERuntime,
} from './automation'
import {
  clearLocalModelConfigs,
  listLegacyLocalModelConfigs,
} from '@/features/model-settings/localModelSettings'
import { replaceProviderModelConfigs } from '@/features/model-settings/providerModelState'

afterEach(() => {
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  clearLocalModelConfigs()
  replaceProviderModelConfigs([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function providerModel(id: string, enabled = true) {
  return {
    id,
    displayName: id,
    modelId: id,
    baseUrl: 'https://provider.example/v1',
    apiFormat: 'openai-chat-completions' as const,
    toolProfile: 'function' as const,
    webSearchMode: 'disabled' as const,
    imageGenerationEnabled: false,
    catalogReady: true,
    enabled,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('Electron desktop E2E automation', () => {
  test('reports metric cardinality across missing, mounted, and duplicate DOM surfaces', async () => {
    const surface = document.createElement('section')
    surface.dataset.testid = 'layout-cardinality-surface'
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100))
    const duplicate = surface.cloneNode() as HTMLElement
    const results: Array<{ ok: boolean; value?: string; error?: string }> = []
    let polls = 0
    vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        polls += 1
        if (polls === 2) document.body.append(surface)
        if (polls === 3) document.body.append(duplicate)
        if (polls > 3) return Promise.resolve(new Response(null, { status: 410 }))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: String(polls),
              action: 'getElementMetrics',
              selector: '[data-testid="layout-cardinality-surface"]',
            })
          )
        )
      }
      if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
      return Promise.resolve(new Response('{}'))
    })
    try {
      await runDesktopControlClient('http://127.0.0.1:43111', 'main')
      expect(results.map(result => result.ok)).toEqual([true, true, true])
      expect(results.map(result => JSON.parse(result.value!).length)).toEqual([0, 1, 2])
      expect(JSON.parse(results[1].value!)[0].width).toBe(200)
    } finally {
      surface.remove()
      duplicate.remove()
    }
  })

  test.each([false, true])(
    'allows an authenticated RPC to overlap later commands and reports its failure: %s',
    async failHeldRequest => {
      let resolveHeld!: (value: unknown) => void
      let rejectHeld!: (error: Error) => void
      const held = new Promise((resolve, reject) => {
        resolveHeld = resolve
        rejectHeld = reject
      })
      const requestRuntime = vi.fn(async (input: { url: string }) => {
        if (input.url.endsWith('/held')) return held
        if (failHeldRequest) rejectHeld(new Error('Held RPC failed'))
        else resolveHeld({ status: 200, body: 'held result' })
        return { status: 200, body: 'overlapping result' }
      })
      const verificationWindow = window as Window & { weworkElectronVerification?: unknown }
      verificationWindow.weworkElectronVerification = { requestRuntime }
      const command = (id: string): DesktopControlCommand => ({
        id,
        action: 'fetchLocalRuntime',
        selector: 'body',
        value: JSON.stringify({ url: `http://127.0.0.1:3000/wework/${id}` }),
      })
      const commands: DesktopControlCommand[] = [
        command('held'),
        { id: 'origin', action: 'getLocationOrigin', selector: 'body' },
        command('overlapping'),
      ]
      const results: Array<{ id: string; ok: boolean; value?: string; error?: string }> = []
      vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
        if (url.includes('/commands?')) {
          const next = commands.shift()
          return next
            ? Promise.resolve(new Response(JSON.stringify(next)))
            : new Promise<Response>(() => {})
        }
        if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
        return Promise.resolve(new Response('{}'))
      })
      void runDesktopControlClient('http://127.0.0.1:43111', 'main')
      try {
        await vi.waitFor(() => expect(results).toHaveLength(3))
        expect(requestRuntime).toHaveBeenCalledTimes(2)
        expect(results[0]).toMatchObject({ id: 'origin', ok: true, value: window.location.origin })
        expect(results.find(result => result.id === 'overlapping')).toMatchObject({
          ok: true,
          value: JSON.stringify({ status: 200, body: 'overlapping result' }),
        })
        expect(results.find(result => result.id === 'held')).toMatchObject(
          failHeldRequest
            ? { ok: false, error: 'Held RPC failed' }
            : { ok: true, value: JSON.stringify({ status: 200, body: 'held result' }) }
        )
      } finally {
        delete verificationWindow.weworkElectronVerification
      }
    }
  )

  test('registers before polling and stops when the server retires the client', async () => {
    let register!: (response: Response) => void
    const registration = new Promise<Response>(resolve => {
      register = resolve
    })
    const fetch = vi.fn((url: string) => {
      if (url.endsWith('/ready')) return registration
      return Promise.resolve(new Response(null, { status: 410 }))
    })
    vi.stubGlobal('fetch', fetch)
    const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:43111/ready')
    register(new Response('{}'))
    await client
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toContain('/commands?clientId=')
  })

  test.each([
    { html: 'interrupted', query: 'interrupted', text: 'interrupted', occurrence: 0 },
    {
      html: 'interrupted before <strong>interrupted</strong> after',
      query: 'interrupted',
      text: 'interrupted before interrupted after',
      occurrence: 1,
    },
    {
      html: '<button data-search-excluded>İ</button>İ before <strong>İ</strong> after',
      query: 'i\u0307',
      text: 'İ before İ after',
      occurrence: 1,
    },
  ])(
    'reads the active highlight at occurrence $occurrence in the exact requested message',
    async ({ html, query, text, occurrence }) => {
      const fixture = document.createElement('div')
      fixture.innerHTML = `
      <input data-testid="conversation-find-input">
      <p data-testid="highlight-message">${html}</p>
      <p data-testid="highlight-message">The operation was interrupted after useful output</p>
    `
      document.body.append(fixture)
      fixture.querySelector('input')!.value = query
      const [message, partial] = fixture.querySelectorAll('p')
      const range = document.createRange()
      const target = message.querySelector('strong') ?? message
      range.selectNodeContents(target)
      const targetText = target.textContent
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
                text,
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
          query,
          ranges: [
            {
              text: targetText,
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

  test('acknowledges refresh before activating the native menu that unloads the renderer', async () => {
    const activate = vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(true)
    let acknowledgeResult!: (value: Response) => void
    const acknowledgement = new Promise<Response>(resolve => {
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
              id: 'menu-refresh',
              action: 'refreshFromApplicationMenu',
              selector: 'body',
            })
          )
        )
      }
      if (url.endsWith('/results')) return acknowledgement
      return Promise.resolve(new Response('{}'))
    })
    vi.stubGlobal('fetch', fetch)
    const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:43111/results', expect.anything())
    )
    expect(activate).not.toHaveBeenCalled()
    acknowledgeResult(new Response('{}'))
    await client
    expect(activate).toHaveBeenCalledExactlyOnceWith('e2e.activateApplicationMenu', {
      id: 'view.refresh',
    })
    expect(polls).toBe(1)
  })

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

  test.each(['element', 'scroll'])(
    'stops %s sampling explicitly after the observed action completes',
    async kind => {
      const root = document.createElement('div')
      root.dataset.testid = 'metrics-sampling-root'
      document.body.append(root)
      const commands =
        kind === 'element'
          ? [
              { id: 'start-metrics', action: 'startElementMetricsSampling', value: '10000' },
              { id: 'stop-metrics', action: 'stopElementMetricsSampling' },
            ]
          : [
              {
                id: 'start-scroll',
                action: 'startScrollStabilitySampling',
                value: JSON.stringify({
                  durationMs: 10000,
                  scrollerSelector: '[data-testid="metrics-sampling-root"]',
                }),
              },
              { id: 'stop-scroll', action: 'stopScrollStabilitySampling' },
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
    }
  )

  test('does not turn an acknowledgement failure into a failed UI action', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
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
        expect.any(String)
      )
      const diagnostic = vi
        .mocked(console.error)
        .mock.calls.find(call => call[0] === '[Wework] Desktop E2E result acknowledgement failed:')
      expect(JSON.parse(String(diagnostic?.[1]))).toMatchObject({
        action: 'click',
        actionSucceeded: true,
        error: 'Failed to fetch',
      })
      const transport = debug.mock.calls
        .filter(call => call[0] === '[Wework] Runtime task create diagnostic')
        .map(call => JSON.parse(String(call[1])))
        .find(entry => entry.stage === 'desktop-control-result-transport')
      expect(transport).toMatchObject({
        commandId: 'acknowledgement-click',
        responseStatus: null,
        serverReceivedAt: null,
        elapsedMs: expect.any(Number),
        maxEventLoopLagMs: expect.any(Number),
      })
    } finally {
      debug.mockRestore()
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

  test('seeds local model fixtures without configuring a cloud connection', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      modelServerUrl: 'http://127.0.0.1:43111',
      seedLocalModels: true,
    }

    await seedDesktopE2ERuntime()

    expect(fetch).not.toHaveBeenCalled()
    expect(listLegacyLocalModelConfigs().map(model => model.id)).toEqual(
      expect.arrayContaining([
        'desktop-e2e-responses',
        'desktop-e2e-vision',
        'desktop-e2e-vision-main',
      ])
    )
  })

  test('propagates cloud identity failures after seeding local models', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
      .mockRejectedValueOnce(new Error('identity unavailable'))
    vi.stubGlobal('fetch', fetch)
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      cloudBackendUrl: 'https://cloud.example.com',
      modelServerUrl: 'http://127.0.0.1:43111',
      seedLocalModels: true,
    }

    await expect(seedDesktopE2ERuntime()).rejects.toThrow('identity unavailable')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(listLegacyLocalModelConfigs().map(model => model.id)).toContain('desktop-e2e-responses')
  })

  test('treats non-successful cloud identity responses as failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    )
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      cloudBackendUrl: 'https://cloud.example.com',
      modelServerUrl: 'http://127.0.0.1:43111',
      seedLocalModels: true,
    }

    await expect(seedDesktopE2ERuntime()).rejects.toThrow('E2E cloud identity returned 401')
  })

  test('skips a dependent model when Provider owns its vision proxy', () => {
    replaceProviderModelConfigs([providerModel('desktop-e2e-vision')])

    seedDesktopE2ELocalModels({ seedLocalModels: true }, 'http://127.0.0.1:43111')

    const standaloneIds = listLegacyLocalModelConfigs().map(model => model.id)
    expect(standaloneIds).toContain('desktop-e2e-responses')
    expect(standaloneIds).not.toContain('desktop-e2e-vision')
    expect(standaloneIds).not.toContain('desktop-e2e-vision-main')
  })
})
