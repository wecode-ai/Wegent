import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('opt-in chat layout diagnostic cache', () => {
  let record: typeof import('./chatLayoutDiagnostics').recordChatLayoutDiagnostic
  const loadFileSystem = vi.fn()
  const writeAsStringAsync = vi.fn<(path: string, snapshot: string) => Promise<void>>()
  const warn = vi.fn()
  let cacheDirectory: string | null

  async function advance(milliseconds: number) {
    await vi.advanceTimersByTimeAsync(milliseconds)
    await vi.dynamicImportSettled()
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    vi.stubEnv('EXPO_PUBLIC_CHAT_LAYOUT_DIAGNOSTICS', '1')
    vi.spyOn(console, 'warn').mockImplementation(warn)
    warn.mockClear()
    loadFileSystem.mockClear()
    writeAsStringAsync.mockReset().mockResolvedValue(undefined)
    cacheDirectory = 'file:///app/Library/Caches/'
    vi.doMock('expo-file-system/legacy', () => {
      loadFileSystem()
      return {
        get cacheDirectory() {
          return cacheDirectory
        },
        writeAsStringAsync,
      }
    })
    record = (await import('./chatLayoutDiagnostics')).recordChatLayoutDiagnostic
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.doUnmock('expo-file-system/legacy')
  })

  it.each([undefined, '0'])(
    'never loads or accesses the file system when disabled (%s)',
    async flag => {
      vi.stubEnv('EXPO_PUBLIC_CHAT_LAYOUT_DIAGNOSTICS', flag)
      record('{"epoch":1}')
      await advance(1000)

      expect(loadFileSystem).not.toHaveBeenCalled()
      expect(writeAsStringAsync).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('batches snapshots in Library/Caches and starts writes at least 500ms apart', async () => {
    record('{"epoch":1}')
    record('{"epoch":2}')
    await advance(499)
    expect(loadFileSystem).not.toHaveBeenCalled()
    await advance(1)
    expect(writeAsStringAsync).toHaveBeenCalledExactlyOnceWith(
      'file:///app/Library/Caches/chat-layout-diagnostics.jsonl',
      '{"epoch":1}\n{"epoch":2}\n'
    )

    record('{"epoch":3}')
    await advance(499)
    expect(writeAsStringAsync).toHaveBeenCalledOnce()
    await advance(1)
    expect(writeAsStringAsync).toHaveBeenCalledTimes(2)
    expect(writeAsStringAsync.mock.lastCall![1]).toBe('{"epoch":1}\n{"epoch":2}\n{"epoch":3}\n')
  })

  it('retains only the latest 1000 records', async () => {
    for (let epoch = 0; epoch < 1005; epoch += 1) record(JSON.stringify({ epoch }))
    await advance(500)

    const lines = writeAsStringAsync.mock.lastCall![1].trimEnd().split('\n')
    expect(lines).toHaveLength(1000)
    expect(lines[0]).toBe('{"epoch":5}')
    expect(lines.at(-1)).toBe('{"epoch":1004}')
  })

  it('serializes slow writes and coalesces every queued record into the newest snapshot', async () => {
    let finishFirst!: () => void
    writeAsStringAsync.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve
        })
    )
    record('{"epoch":1}')
    await advance(500)
    record('{"epoch":2}')
    await advance(500)
    record('{"epoch":3}')
    expect(writeAsStringAsync).toHaveBeenCalledOnce()

    finishFirst()
    await advance(0)
    expect(writeAsStringAsync).toHaveBeenCalledTimes(2)
    expect(writeAsStringAsync.mock.lastCall![1]).toBe('{"epoch":1}\n{"epoch":2}\n{"epoch":3}\n')
    await advance(1000)
    expect(writeAsStringAsync).toHaveBeenCalledTimes(2)
  })

  it('reports write failure and includes retained records in the next successful snapshot', async () => {
    const failure = new Error('No space available')
    writeAsStringAsync.mockRejectedValueOnce(failure)
    expect(() => record('{"epoch":1}')).not.toThrow()
    await advance(500)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[ChatLayout] Failed to write diagnostic cache snapshot',
      failure
    )
    expect(vi.getTimerCount()).toBe(0)

    record('{"epoch":2}')
    await advance(500)
    expect(writeAsStringAsync).toHaveBeenCalledTimes(2)
    expect(writeAsStringAsync.mock.lastCall![1]).toBe('{"epoch":1}\n{"epoch":2}\n')
  })

  it('reports an unavailable cache directory without writing to another location', async () => {
    cacheDirectory = null
    record('{"epoch":1}')
    await advance(500)

    expect(writeAsStringAsync).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[ChatLayout] Failed to write diagnostic cache snapshot',
      expect.objectContaining({ message: 'The application cache directory is unavailable' })
    )
  })
})
