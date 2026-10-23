import { afterEach, expect, test, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { installE2ERendererCpuProfiling } from './e2e-renderer-cpu-profile.js'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function fixture() {
  let loaded = () => {}
  let destroyed = false
  const contents = {
    id: 4,
    debugger: {
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      sendCommand: vi.fn(async (method: string) =>
        method === 'Profiler.stop' ? { profile: { nodes: [], samples: [1] } } : {}
      ),
    },
    isDestroyed: () => destroyed,
    on: vi.fn((_event: 'did-finish-load', listener: () => void) => {
      loaded = listener
    }),
  }
  return {
    contents,
    load: () => loaded(),
    destroy: () => {
      destroyed = true
    },
  }
}

test('does not enable profiling outside an explicitly configured isolated E2E run', () => {
  const f = fixture()
  installE2ERendererCpuProfiling(f.contents, {
    WEWORK_E2E_RENDERER_CPU_PROFILE_DIRECTORY: '/evidence',
  })
  expect(f.contents.on).not.toHaveBeenCalled()
  expect(f.contents.debugger.sendCommand).not.toHaveBeenCalled()
})

test('saves bounded CPU samples and stops when the renderer is destroyed', async () => {
  vi.useFakeTimers()
  const f = fixture()
  installE2ERendererCpuProfiling(f.contents, {
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: 'http://localhost',
    WEWORK_E2E_RENDERER_CPU_PROFILE_DIRECTORY: '/evidence',
  })
  f.load()
  f.load()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(writeFile).toHaveBeenCalledExactlyOnceWith(
    '/evidence/renderer-4-0.cpuprofile',
    JSON.stringify({ nodes: [], samples: [1] }),
    { mode: 0o600 }
  )
  expect(f.contents.debugger.attach).not.toHaveBeenCalled()
  f.destroy()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(writeFile).toHaveBeenCalledTimes(1)
  expect(
    f.contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Profiler.start')
  ).toHaveLength(2)
})
