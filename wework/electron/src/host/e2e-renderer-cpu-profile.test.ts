import { afterEach, expect, test, vi } from 'vitest'
import { contentTracing } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installE2ERendererCpuProfiling } from './e2e-renderer-cpu-profile.js'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }))
vi.mock('electron', () => ({ contentTracing: { startRecording: vi.fn(), stopRecording: vi.fn() } }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function fixture() {
  let loaded = () => {}
  let destroyed = false
  const contents = {
    id: 4,
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
  expect(contentTracing.startRecording).not.toHaveBeenCalled()
})

test('saves bounded CPU samples and stops when the renderer is destroyed', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const directory = join(tmpdir(), 'wework-cpu-profile-evidence')
  installE2ERendererCpuProfiling(f.contents, {
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: 'http://localhost',
    WEWORK_E2E_RENDERER_CPU_PROFILE_DIRECTORY: directory,
  })
  f.load()
  f.load()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(contentTracing.stopRecording).toHaveBeenCalledExactlyOnceWith(
    join(directory, 'renderer-4-0.trace.json')
  )
  f.destroy()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(contentTracing.stopRecording).toHaveBeenCalledTimes(2)
  expect(contentTracing.startRecording).toHaveBeenCalledTimes(2)
})

test('caps the total profiles across reloads while the renderer remains alive', async () => {
  vi.useFakeTimers()
  const f = fixture()
  installE2ERendererCpuProfiling(f.contents, {
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: 'http://localhost',
    WEWORK_E2E_RENDERER_CPU_PROFILE_DIRECTORY: join(tmpdir(), 'bounded-cpu-evidence'),
    WEWORK_E2E_RENDERER_CPU_PROFILE_LIMIT: '2',
  })
  f.load()
  await vi.advanceTimersByTimeAsync(60_000)
  f.load()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(contentTracing.startRecording).toHaveBeenCalledTimes(2)
  expect(contentTracing.stopRecording).toHaveBeenCalledTimes(2)
})
