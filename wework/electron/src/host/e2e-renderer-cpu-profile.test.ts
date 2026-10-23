import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { afterEach, expect, test, vi } from 'vitest'
import { installE2ERendererCpuProfile } from './e2e-renderer-cpu-profile.js'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))
const enabled = { VITE_WEWORK_E2E: 'true', WEWORK_E2E_RENDERER_CPU_PROFILE: 'true' }

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    debugger: {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async (method: string) =>
        method === 'Profiler.stop'
          ? {
              profile: {
                nodes: [
                  {
                    callFrame: {
                      url: 'http://user:private-value@localhost/app.js?token=private-value#fragment',
                    },
                  },
                ],
              },
            }
          : {}
      ),
    },
  })
  return { contents, webContents: contents as unknown as WebContents }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

test('never attaches outside explicitly enabled isolated E2E sessions', () => {
  const { contents, webContents } = fixture()
  const dispose = installE2ERendererCpuProfile(webContents, '/diagnostics', {
    WEWORK_E2E_RENDERER_CPU_PROFILE: 'true',
  })
  contents.emit('did-finish-load')
  expect(contents.debugger.attach).not.toHaveBeenCalled()
  dispose()
})

test('writes bounded samples without URL credentials and stops on disposal', async () => {
  vi.useFakeTimers()
  const { contents, webContents } = fixture()
  const dispose = installE2ERendererCpuProfile(webContents, '/diagnostics', enabled)
  contents.emit('did-finish-load')
  await vi.advanceTimersByTimeAsync(5000)
  expect(mkdir).toHaveBeenCalledWith('/diagnostics', { recursive: true })
  expect(writeFile).toHaveBeenCalledWith(
    '/diagnostics/e2e-renderer-7-1.cpuprofile',
    expect.any(String)
  )
  const payload = String(vi.mocked(writeFile).mock.calls[0][1])
  expect(payload).toContain('http://localhost/app.js')
  expect(payload).not.toContain('private-value')
  dispose()
  expect(contents.debugger.detach).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('retains an existing debugger owner without changing application execution', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { contents, webContents } = fixture()
  contents.debugger.isAttached.mockReturnValue(true)
  const dispose = installE2ERendererCpuProfile(webContents, '/diagnostics', enabled)
  contents.emit('did-finish-load')
  await vi.advanceTimersByTimeAsync(0)
  expect(warn).toHaveBeenCalled()
  expect(contents.debugger.attach).not.toHaveBeenCalled()
  expect(contents.debugger.detach).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  dispose()
})
