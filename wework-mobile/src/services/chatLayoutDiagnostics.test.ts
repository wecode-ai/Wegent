import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordChatLayoutDiagnostic } from './chatLayoutDiagnostics'
import { setDiagnosticRecording } from './mobileDiagnostics'

const fileSystem = vi.hoisted(() => ({ load: vi.fn(), write: vi.fn() }))
vi.mock('expo-file-system/legacy', () => {
  fileSystem.load()
  return { writeAsStringAsync: fileSystem.write }
})

afterEach(() => {
  setDiagnosticRecording(false)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('chat layout diagnostics without disk snapshots', () => {
  it.each([false, true])('creates no file writes or timers when recording=%s', enabled => {
    vi.useFakeTimers()
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    setDiagnosticRecording(enabled)
    for (let epoch = 0; epoch < 200; epoch++) recordChatLayoutDiagnostic(JSON.stringify({ epoch }))
    expect(output).toHaveBeenCalledTimes(enabled ? 200 : 0)
    expect(fileSystem.load).not.toHaveBeenCalled()
    expect(fileSystem.write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
