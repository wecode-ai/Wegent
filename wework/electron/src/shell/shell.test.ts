import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, test, vi } from 'vitest'

describe('Electron startup shell', () => {
  test('renders initialization and failure states and retries the runtime', async () => {
    const elements = new Map(
      [
        '#runtime-status',
        '#details',
        '#reload-dsh',
        '#runtime-overlay',
        '.runtime-card',
        '.runtime-failure-backdrop',
        '#loading-status',
      ].map(selector => [
        selector,
        {
          dataset: {} as Record<string, string>,
          disabled: false,
          hidden: false,
          textContent: '',
          addEventListener: vi.fn(),
        },
      ])
    )
    const state = {
      phase: 'initializing',
      ready: false,
      error: null as string | null,
    }
    const listeners: Array<() => void> = []
    const reloadDsh = vi.fn().mockResolvedValue(undefined)
    const source = await readFile(resolve(import.meta.dirname, 'shell.js'), 'utf8')
    const context = vm.createContext({
      document: {
        querySelector: (selector: string) => elements.get(selector),
      },
      window: {
        weworkElectron: {
          getRuntimeState: () => Promise.resolve({ ...state }),
          onRuntimeChanged: (listener: () => void) => listeners.push(listener),
          reloadDsh,
        },
      },
    })

    vm.runInContext(source, context)
    await vi.waitFor(() => {
      expect(elements.get('#runtime-status')?.textContent).toBe('正在初始化 Core DSH…')
      expect(elements.get('#runtime-overlay')?.dataset.phase).toBe('initializing')
      expect(elements.get('#reload-dsh')?.hidden).toBe(true)
      expect(elements.get('.runtime-card')?.hidden).toBe(true)
      expect(elements.get('.runtime-failure-backdrop')?.hidden).toBe(true)
      expect(elements.get('#loading-status')?.textContent).toBe('正在准备本地运行时…')
    })

    state.phase = 'failed'
    state.error = 'dsh-core startup timed out'
    listeners[0]?.()
    await vi.waitFor(() => {
      expect(elements.get('#runtime-status')?.textContent).toBe(
        '运行时启动失败：dsh-core startup timed out'
      )
      expect(elements.get('#reload-dsh')?.textContent).toBe('重试启动')
      expect(elements.get('#runtime-overlay')?.dataset.phase).toBe('failed')
      expect(elements.get('#details')?.hidden).toBe(false)
      expect(elements.get('#reload-dsh')?.hidden).toBe(false)
      expect(elements.get('.runtime-card')?.hidden).toBe(false)
      expect(elements.get('.runtime-failure-backdrop')?.hidden).toBe(false)
    })

    const clickHandler = vi.mocked(elements.get('#reload-dsh')?.addEventListener).mock
      .calls[0]?.[1] as (() => Promise<void>) | undefined
    await clickHandler?.()
    expect(reloadDsh).toHaveBeenCalledOnce()
  })
})
