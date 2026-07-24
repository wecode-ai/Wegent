import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  evalEmbeddedBrowserJson,
  listenEmbeddedBrowserOpenRequests,
  relabelEmbeddedBrowser,
  requestEmbeddedBrowserOpen,
} from './embedded-browser'

const unlistenMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(unlistenMock),
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: vi.fn(() => true),
}))

const invokeMock = vi.mocked(invoke)

describe('embedded-browser', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('unwraps successful eval result values', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      value: [{ comment: 'Check this area' }],
    })

    await expect(evalEmbeddedBrowserJson('window.consume()')).resolves.toEqual([
      { comment: 'Check this area' },
    ])
  })

  test('keeps direct eval values for compatibility', async () => {
    invokeMock.mockResolvedValue([{ comment: 'Direct value' }])

    await expect(evalEmbeddedBrowserJson('window.consume()')).resolves.toEqual([
      { comment: 'Direct value' },
    ])
  })

  test('throws failed eval result errors', async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      error: 'Evaluation failed',
    })

    await expect(evalEmbeddedBrowserJson('window.consume()')).rejects.toThrow('Evaluation failed')
  })

  test('relabels an embedded browser through Tauri', async () => {
    invokeMock.mockResolvedValue(undefined)

    await relabelEmbeddedBrowser('workspace-browser-blank-0', 'workspace-browser-task-1')

    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_relabel', {
      fromLabel: 'workspace-browser-blank-0',
      toLabel: 'workspace-browser-task-1',
    })
  })

  test('routes frontend open requests to the active embedded browser listener', async () => {
    const handler = vi.fn()
    const unlisten = listenEmbeddedBrowserOpenRequests(handler)

    expect(requestEmbeddedBrowserOpen('http://localhost:3000')).toBe(true)
    expect(handler).toHaveBeenCalledWith({
      label: 'workspace-browser',
      url: 'http://localhost:3000/',
    })
    expect(requestEmbeddedBrowserOpen('asset://localhost/Users/me/workspace/trend.html')).toBe(true)
    expect(handler).toHaveBeenCalledWith({
      label: 'workspace-browser',
      url: 'asset://localhost/Users/me/workspace/trend.html',
    })
    expect(requestEmbeddedBrowserOpen('ftp://localhost/resource')).toBe(false)
    expect(handler).toHaveBeenCalledTimes(2)

    const release = await unlisten
    release?.()
  })
})
