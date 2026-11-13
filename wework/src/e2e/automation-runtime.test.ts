import { afterEach, describe, expect, test, vi } from 'vitest'
import { expandCompletedProcessing } from '../../e2e/desktop/modules/streaming-text-fixture.mjs'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import * as desktopHost from '@/api/dsh/desktopHost'
import * as nativeKey from './native-key-acknowledgement'
import { getDesktopControlDiagnostics } from './desktop-control-diagnostics'
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
  listLocalModelConfigs,
} from '@/features/model-settings/localModelSettings'
import { replaceProviderModelConfigs } from '@/features/model-settings/providerModelState'
import * as codexPlugins from '@/api/local/codexPlugins'
import { toInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'

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

function installNativeModelOwner() {
  let providers: import('@/features/model-settings/providerModelConfiguration').ModelProvider[] = []
  let revision = 0
  const original = desktopHost.invokeDesktopHost
  return vi.spyOn(desktopHost, 'invokeDesktopHost').mockImplementation(async (method, params) => {
    if (method === 'modelConfiguration.read')
      return {
        providers,
        revision: String(revision),
        path: '/fixture/model.yml',
        loadedAt: '',
      } as never
    if (method === 'modelConfiguration.save') {
      providers = params?.providers as typeof providers
      revision += 1
      return { providers, revision: String(revision) } as never
    }
    if (method === 'modelConfiguration.runtime')
      return {
        revision: String(revision),
        models: providers.flatMap(provider => provider.models.map(model => ({ provider, model }))),
      } as never
    return original(method, params)
  })
}

describe('Electron desktop E2E automation', () => {
  test('forwards startup splash size changes through the native host', async () => {
    const previous = { width: 1000, height: 620, maximized: false }
    const native = vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(previous as never)
    const results: Array<{ ok: boolean; value: string }> = []
    let polls = 0
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        if (++polls > 1) return new Response(null, { status: 410 })
        return new Response(
          JSON.stringify({
            id: 'startup-size-roundtrip',
            action: 'setStartupSplashSize',
            selector: 'body',
            value: JSON.stringify({ width: 1100, height: 620 }),
          })
        )
      }
      if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
      return new Response('{}')
    })
    await runDesktopControlClient('http://127.0.0.1:43111', 'main')
    expect(native).toHaveBeenCalledWith('e2e.setStartupSplashSize', {
      width: 1100,
      height: 620,
    })
    expect(results).toContainEqual(
      expect.objectContaining({ ok: true, value: JSON.stringify(previous) })
    )
  })

  test.each([undefined, false, true])(
    'preserves window maximization through the host command (%s)',
    async maximized => {
      const previous = { width: 1272, height: 716, maximized: true }
      const native = vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(previous as never)
      const results: Array<{ ok: boolean; value: string }> = []
      let polls = 0
      vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
        if (url.includes('/commands?')) {
          if (++polls > 1) return new Response(null, { status: 410 })
          return new Response(
            JSON.stringify({
              id: 'window-state-roundtrip',
              action: 'setMainWindowSize',
              selector: 'body',
              value: JSON.stringify({ width: 1040, height: 760, maximized }),
            })
          )
        }
        if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
        return new Response('{}')
      })
      await runDesktopControlClient('http://127.0.0.1:43111', 'main')
      expect(native).toHaveBeenCalledWith('e2e.setMainWindowSize', {
        width: 1040,
        height: 760,
        maximized: maximized ?? false,
      })
      expect(results).toContainEqual(
        expect.objectContaining({ ok: true, value: JSON.stringify(previous) })
      )
    }
  )

  test.each([
    'no-catalog',
    'local-only',
    'prefer-local',
    'legacy-all',
    'legacy-selected',
    'empty-inventory',
    'no-inventory',
  ] as const)('reads live plugin inventory diagnostics with a %s catalog', async mode => {
    const snapshot = (name: string): codexPlugins.LocalCodexPluginsState => {
      const plugin = toInstalledPlugin(
        { name: 'wegent', path: '/plugins', plugins: [] },
        { name, installed: true, enabled: true },
        undefined,
        key => key
      )
      return {
        deviceId: 'diagnostic-device',
        installedPlugins: [plugin],
        sourceReads: { store: { status: 'fulfilled', items: [plugin] } },
        marketplaceItems: [],
        marketplaces: [],
        selectedMarketplaceId: 'wegent',
        marketplacePath: '/plugins',
        installRegistryPath: '',
      }
    }
    const local = snapshot('local-tool')
    const all = snapshot('older-all-tool')
    const selected = snapshot('selected-tool')
    const peek = vi
      .spyOn(codexPlugins, 'peekLocalCodexPluginsReadState')
      .mockImplementation(params => {
        if (params?.marketplaceKinds?.includes('local'))
          return mode === 'local-only' || mode === 'prefer-local' ? local : null
        if (params?.mergeAllMarketplaces)
          return mode === 'prefer-local' || mode === 'legacy-all' ? all : null
        return mode === 'legacy-selected' ? selected : null
      })
    const live = snapshot('live-tool')
    const expectedKeys = mode === 'empty-inventory' || mode === 'no-inventory' ? [] : ['live-tool']
    const liveItems = mode === 'empty-inventory' ? [] : live.installedPlugins
    const inventory = vi.spyOn(codexPlugins, 'peekLocalInstalledPluginInventory').mockReturnValue(
      mode === 'no-inventory'
        ? null
        : {
            deviceId: live.deviceId,
            items: liveItems,
            sourceReads: { store: { status: 'fulfilled', items: liveItems } },
          }
    )
    const results: Array<{ ok: boolean; value?: string }> = []
    let polls = 0
    vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        if (++polls > 1) return new Promise<Response>(() => {})
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'plugin-source-diagnostics',
              action: 'getComposerPluginInventoryDiagnostics',
              selector: 'body',
            })
          )
        )
      }
      if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
      return Promise.resolve(new Response('{}'))
    })
    void runDesktopControlClient('http://127.0.0.1:43111', 'main')
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0].ok).toBe(true)
    const diagnostics = JSON.parse(results[0].value!)
    expect(diagnostics.installedSourceReads).toEqual(
      mode === 'no-inventory' ? {} : { store: { status: 'fulfilled', pluginKeys: expectedKeys } }
    )
    expect(
      diagnostics.installedPlugins.map((plugin: { pluginKey: string }) => plugin.pluginKey)
    ).toEqual(expectedKeys)
    expect(inventory).toHaveBeenCalledTimes(1)
    expect(peek).not.toHaveBeenCalled()
  })
  test.each([false, true])(
    'reports atomic metric cardinality with includeText=%s',
    async includeText => {
      const surface = document.createElement('section')
      surface.dataset.testid = 'layout-cardinality-surface'
      surface.textContent = 'Loaded receipt'
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
                value: includeText ? 'includeText' : undefined,
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
        expect(JSON.parse(results[1].value!)[0]).toMatchObject({
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        })
        const metrics = JSON.parse(results[2].value!)
        expect(metrics[0]).not.toHaveProperty('attributes')
        expect(metrics[0]).not.toHaveProperty('visible')
        if (includeText) {
          expect(
            metrics.map((item: { testId: string; text: string }) => [item.testId, item.text])
          ).toEqual([
            ['layout-cardinality-surface', 'Loaded receipt'],
            ['layout-cardinality-surface', ''],
          ])
        } else {
          expect(metrics[0]).not.toHaveProperty('text')
          expect(metrics[0]).not.toHaveProperty('testId')
        }
      } finally {
        surface.remove()
        duplicate.remove()
      }
    }
  )

  test.each(['unknown-to-known', 'project-zero-to-one'])(
    'captures selected attributes, text and geometry coherently through %s',
    async transition => {
      const tab = document.createElement('button')
      tab.dataset.testid = 'snapshot-tab'
      tab.dataset.privateFixture = 'never export unrequested attributes'
      const counter = document.createElement('span')
      counter.dataset.testid = 'snapshot-counter'
      vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 150, 30))
      vi.spyOn(counter, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 30, 20))
      const questions = transition === 'unknown-to-known' ? 1 : 0
      const update = (ready: boolean) => {
        const projects = ready ? (questions ? 0 : 1) : questions ? null : 0
        tab.dataset.pendingQuestionCount = String(questions)
        tab.dataset.projectCountState = projects == null ? 'unknown' : 'known'
        if (projects == null) delete tab.dataset.projectPendingCount
        else tab.dataset.projectPendingCount = String(projects)
        tab.title = projects == null ? '待你处理' : `待你处理（${questions + projects}）`
        tab.replaceChildren('待你处理')
        if (projects != null) {
          counter.textContent = `（${questions + projects}）`
          tab.append(counter)
        }
      }
      update(false)
      document.body.append(tab)
      const results: Array<{ ok: boolean; value?: string }> = []
      let polls = 0
      vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
        if (url.includes('/commands?')) {
          if (++polls > 2) return Promise.resolve(new Response(null, { status: 410 }))
          return Promise.resolve(
            Response.json({
              id: String(polls),
              action: 'getElementMetrics',
              selector: '[data-testid="snapshot-tab"], [data-testid="snapshot-counter"]',
              value: JSON.stringify({
                includeText: true,
                attributeNames: [
                  'title',
                  'data-pending-question-count',
                  'data-project-pending-count',
                  'data-project-count-state',
                ],
              }),
            })
          )
        }
        if (url.endsWith('/results')) {
          results.push(JSON.parse(String(options?.body)))
          update(true)
        }
        return Promise.resolve(new Response('{}'))
      })
      try {
        await runDesktopControlClient('http://127.0.0.1:43111', 'main')
        expect(results.map(result => result.ok)).toEqual([true, true])
        const before = JSON.parse(results[0].value!)
        const after = JSON.parse(results[1].value!)
        expect(before[0].attributes['data-project-count-state']).toBe(
          questions ? 'unknown' : 'known'
        )
        expect(before).toHaveLength(questions ? 1 : 2)
        expect(after).toHaveLength(2)
        expect(after[0]).toMatchObject({
          width: 150,
          text: '待你处理（1）',
          attributes: {
            title: '待你处理（1）',
            'data-project-count-state': 'known',
            'data-pending-question-count': String(questions),
            'data-project-pending-count': questions ? '0' : '1',
          },
        })
        expect(after[1]).toMatchObject({ text: '（1）', width: 30, visible: true })
        expect(JSON.stringify(after)).not.toContain('privateFixture')
        expect(JSON.stringify(after)).not.toContain('never export')
      } finally {
        tab.remove()
      }
    }
  )

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
    expect(
      getDesktopControlDiagnostics()
        .filter(entry => entry.commandId === 'menu-refresh')
        .map(entry => entry.phase)
    ).toEqual(['command-decoded', 'start-acknowledged', 'action-completed', 'result-acknowledged'])
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

  test.each([null, 'ready', 'started', 'results'] as const)(
    'consumes nonempty acknowledgement bodies including HTTP failure at %s',
    async failedEndpoint => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const button = document.createElement('button')
      button.dataset.testid = 'control-response-body-button'
      const clicked = vi.fn()
      button.onclick = clicked
      document.body.append(button)
      const acknowledgements: Array<{ endpoint: string; response: Response }> = []
      let polls = 0
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.includes('/commands?')) {
          if (++polls > 1) return new Response(null, { status: 410 })
          return new Response(
            JSON.stringify({
              id: 'response-body-click',
              action: 'click',
              selector: '[data-testid="control-response-body-button"]',
            })
          )
        }
        const endpoint = new URL(url).pathname.slice(1)
        if (['ready', 'started', 'results'].includes(endpoint)) {
          const response = new Response('{"ok":true}\n', {
            status: endpoint === failedEndpoint ? 503 : 200,
          })
          acknowledgements.push({ endpoint, response })
          return response
        }
        return new Response(null, { status: 204 })
      })
      try {
        const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')
        if (failedEndpoint === 'ready') {
          await expect(client).rejects.toThrow('registration failed with 503')
        } else {
          await client
        }
        expect(acknowledgements.map(entry => entry.endpoint)).toEqual(
          failedEndpoint === 'ready'
            ? ['ready']
            : failedEndpoint === 'started'
              ? ['ready', 'started']
              : ['ready', 'started', 'results']
        )
        expect(acknowledgements.every(entry => entry.response.bodyUsed)).toBe(true)
        expect(clicked).toHaveBeenCalledTimes(
          failedEndpoint === 'ready' || failedEndpoint === 'started' ? 0 : 1
        )
      } finally {
        button.remove()
      }
    }
  )

  test('finishes reading the result acknowledgement before polling again', async () => {
    const button = document.createElement('button')
    button.dataset.testid = 'control-ack-stream-button'
    const clicked = vi.fn()
    button.onclick = clicked
    document.body.append(button)
    let finishBody!: () => void
    let bodyClosed = false
    const acknowledgement = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}\n'))
          finishBody = () => {
            if (bodyClosed) return
            bodyClosed = true
            controller.close()
          }
        },
      })
    )
    let polls = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/commands?')) {
        if (++polls > 1) return new Response(null, { status: 410 })
        return new Response(
          JSON.stringify({
            id: 'streamed-ack',
            action: 'click',
            selector: '[data-testid="control-ack-stream-button"]',
          })
        )
      }
      return url.endsWith('/results') ? acknowledgement : new Response('{"ok":true}\n')
    })
    const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')
    try {
      await vi.waitFor(() => expect(acknowledgement.bodyUsed).toBe(true))
      expect(clicked).toHaveBeenCalledOnce()
      expect(polls).toBe(1)
      finishBody()
      await client
      expect(polls).toBe(2)
    } finally {
      finishBody()
      await client
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

  test.each([
    ['Macintosh', 'Meta+A'],
    ['Windows', 'Control+A'],
    ['Linux', 'Control+A'],
  ])('fills a shadow-root editor through native selection on %s', async (platform, selectAll) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    const host = document.createElement('div')
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    host.attachShadow({ mode: 'open' }).append(editor)
    document.body.append(host)
    const native = vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(undefined as never)
    vi.spyOn(nativeKey, 'sendNativeKeyAndWait').mockImplementation(
      async (_target, _phase, send) => {
        await send()
      }
    )
    try {
      await fillDesktopControlElement(editor, 'first\nsecond')
      expect(
        native.mock.calls.map(([method, params]) => [method, params?.key ?? params?.text])
      ).toEqual([
        ['e2e.focusMainWindow', undefined],
        ['e2e.pressKey', selectAll],
        ['e2e.insertText', 'first'],
        ['e2e.pressKey', 'Enter'],
        ['e2e.insertText', 'second'],
      ])
      native.mockClear()
      await fillDesktopControlElement(editor, '')
      expect(native.mock.calls.map(([method, params]) => [method, params?.key])).toEqual([
        ['e2e.focusMainWindow', undefined],
        ['e2e.pressKey', selectAll],
        ['e2e.pressKey', 'Backspace'],
      ])
    } finally {
      host.remove()
    }
  })

  test('waits for a disabled select to accept changes before acknowledging selection', async () => {
    const select = document.createElement('select')
    select.dataset.testid = 'busy-role-select'
    select.disabled = true
    select.innerHTML =
      '<option value="Developer">Member</option><option value="Maintainer">Admin</option>'
    document.body.append(select)
    const changed = vi.fn()
    select.addEventListener('change', changed)
    const results: Array<{ ok: boolean; value: string }> = []
    let polls = 0
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        if (++polls > 1) return new Response(null, { status: 410 })
        return new Response(
          JSON.stringify({
            id: 'busy-role-choice',
            action: 'select',
            selector: '[data-testid="busy-role-select"]',
            value: 'Maintainer',
            timeoutMs: 1000,
          })
        )
      }
      if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
      return new Response('{}')
    })
    const client = runDesktopControlClient('http://127.0.0.1:43111', 'main')
    try {
      await vi.waitFor(() =>
        expect(getDesktopControlDiagnostics()).toContainEqual(
          expect.objectContaining({ commandId: 'busy-role-choice', phase: 'start-acknowledged' })
        )
      )
      expect(select.value).toBe('Developer')
      expect(changed).not.toHaveBeenCalled()
      expect(results).toEqual([])
      select.disabled = false
      await client
      expect(select.value).toBe('Maintainer')
      expect(changed).toHaveBeenCalledOnce()
      expect(results).toEqual([expect.objectContaining({ ok: true, value: 'Admin' })])
    } finally {
      select.disabled = false
      await client
      select.remove()
    }
  })

  test('delivers native shortcuts to the focused editor inside a shadow root', async () => {
    const host = document.createElement('div')
    const editor = document.createElement('textarea')
    editor.dataset.testid = 'shadow-native-editor'
    editor.scrollIntoView = vi.fn()
    host.attachShadow({ mode: 'open' }).append(editor)
    document.body.append(host)
    const native = vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(undefined as never)
    const delivery = vi
      .spyOn(nativeKey, 'sendNativeKeyAndWait')
      .mockImplementation(async (target, _phase, send) => {
        expect(document.activeElement).toBe(host)
        expect(host.shadowRoot?.activeElement).toBe(target)
        await send()
      })
    let polls = 0
    const results: Array<{ ok: boolean; value: string }> = []
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        if (++polls > 1) return new Response(null, { status: 410 })
        return new Response(
          JSON.stringify({
            id: 'shadow-shortcut',
            action: 'nativePress',
            selector: '[data-testid="shadow-native-editor"]',
            key: 'Control+z',
          })
        )
      }
      if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
      return new Response('{}')
    })
    try {
      await runDesktopControlClient('http://127.0.0.1:43111', 'main')
      expect(results).toEqual([
        expect.objectContaining({ ok: true, value: 'shadow-native-editor' }),
      ])
      expect(delivery).toHaveBeenCalledWith(editor, 'press', expect.any(Function))
      expect(native).toHaveBeenLastCalledWith('e2e.pressKey', {
        windowLabel: 'main',
        key: 'Control+z',
        phase: 'press',
        focus: false,
      })
    } finally {
      host.remove()
    }
  })

  test('seeds local model fixtures without configuring a cloud connection', async () => {
    const owner = installNativeModelOwner()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      modelServerUrl: 'http://127.0.0.1:43111',
      seedLocalModels: true,
    }

    await seedDesktopE2ERuntime()

    expect(fetch).not.toHaveBeenCalled()
    expect(listLocalModelConfigs().map(model => model.id)).toEqual(
      expect.arrayContaining([
        'desktop-e2e-responses',
        'desktop-e2e-vision',
        'desktop-e2e-vision-main',
      ])
    )
    expect(listLegacyLocalModelConfigs()).toEqual([])
    expect(
      listLocalModelConfigs().find(model => model.id === 'desktop-e2e-vision-main')
    ).toMatchObject({
      toolProfile: 'function',
      codexToolCompatibility: 'standard',
    })
    expect(owner).toHaveBeenCalledWith('modelConfiguration.save', expect.any(Object))
  })

  test('does not advertise fixture readiness when native ownership cannot be established', async () => {
    vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue({
      providers: [],
      revision: 'unavailable',
      error: 'Native model owner unavailable',
    })
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      modelServerUrl: 'http://127.0.0.1:43111',
      seedLocalModels: true,
    }
    await expect(seedDesktopE2ERuntime()).rejects.toThrow('Native model owner unavailable')
  })

  test('propagates cloud identity failures after seeding local models', async () => {
    const owner = installNativeModelOwner()
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
    expect(listLocalModelConfigs().map(model => model.id)).toContain('desktop-e2e-responses')
    expect(listLegacyLocalModelConfigs()).toEqual([])
    expect(owner).toHaveBeenCalledWith('modelConfiguration.save', expect.any(Object))
  })

  test('treats non-successful cloud identity responses as failures', async () => {
    const owner = installNativeModelOwner()
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
    expect(listLegacyLocalModelConfigs()).toEqual([])
    expect(owner).toHaveBeenCalledWith('modelConfiguration.save', expect.any(Object))
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
