import { beforeEach, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, action: string) => unknown>(),
  closed: null as (() => void) | null,
  window: {
    isDestroyed: vi.fn(() => false),
    show: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(),
    loadFile: vi.fn(async () => undefined),
    webContents: { id: 17, send: vi.fn() },
    once: vi.fn(),
  },
  create: vi.fn(),
  activationPolicy: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  copy: vi.fn(),
  logs: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    whenReady: async () => undefined,
    quit: fixture.quit,
    relaunch: fixture.relaunch,
    getPath: () => '/logs',
    setActivationPolicy: fixture.activationPolicy,
  },
  BrowserWindow: class {
    constructor(options: unknown) {
      fixture.create(options)
      return fixture.window
    }
  },
  nativeTheme: { shouldUseDarkColors: false },
  clipboard: { writeText: fixture.copy },
  shell: { openPath: fixture.logs },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, action: string) => unknown) =>
      fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.handlers.clear()
  fixture.closed = null
  fixture.window.once.mockImplementation((_name, callback) => {
    fixture.closed = callback
  })
  fixture.window.destroy.mockImplementation(() => {
    fixture.closed?.()
  })
  fixture.window.loadFile.mockResolvedValue(undefined)
})

test('opens a recovery window without using persistent profile storage or exiting', async () => {
  const { showStartupRecovery } = await import('./startup-recovery-window.js')
  const original = new Error('migration data is incompatible')
  await showStartupRecovery(original)
  expect(fixture.create).toHaveBeenCalledWith(
    expect.objectContaining({
      webPreferences: expect.objectContaining({
        partition: 'wework-startup-recovery',
        sandbox: true,
        nodeIntegration: false,
      }),
    })
  )
  expect(fixture.window.show).toHaveBeenCalledOnce()
  if (process.platform === 'darwin')
    expect(fixture.activationPolicy).toHaveBeenCalledWith('regular')
  expect(fixture.quit).not.toHaveBeenCalled()
  expect(fixture.relaunch).not.toHaveBeenCalled()
  const invoke = fixture.handlers.get('startup-recovery-window')!
  expect(await invoke({ sender: { id: 17 } }, 'state')).toEqual({
    phase: 'failed',
    ready: false,
    error: original.message,
  })
  await expect(invoke({ sender: { id: 99 } }, 'retry')).rejects.toThrow('another window')
  expect(fixture.relaunch).not.toHaveBeenCalled()
  await invoke({ sender: { id: 17 } }, 'retry')
  expect(fixture.relaunch).toHaveBeenCalledOnce()
  expect(fixture.quit).toHaveBeenCalledOnce()
})

test('shares one recovery window and displays the latest error', async () => {
  const { showStartupRecovery } = await import('./startup-recovery-window.js')
  await Promise.all([
    showStartupRecovery(new Error('first')),
    showStartupRecovery(new Error('second')),
  ])
  await showStartupRecovery(new Error('third'))
  expect(fixture.create).toHaveBeenCalledOnce()
  const invoke = fixture.handlers.get('startup-recovery-window')!
  await invoke({ sender: { id: 17 } }, 'copy')
  expect(fixture.copy).toHaveBeenCalledWith('third')
  await invoke({ sender: { id: 17 } }, 'logs')
  expect(fixture.logs).toHaveBeenCalledWith('/logs')
  await expect(invoke({ sender: { id: 17 } }, 'delete-data')).rejects.toThrow('Unknown')
})

test('app activation reopens closed recovery without requiring a workbench or runtime', async () => {
  const { focusStartupRecoveryIfActive, showStartupRecovery } =
    await import('./startup-recovery-window.js')
  expect(focusStartupRecoveryIfActive()).toBe(false)
  expect(fixture.create).not.toHaveBeenCalled()
  await showStartupRecovery(new Error('services stopped during failed installation'))
  fixture.closed?.()
  expect(fixture.handlers.size).toBe(0)
  expect(focusStartupRecoveryIfActive()).toBe(true)
  await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledTimes(2))
  const invoke = fixture.handlers.get('startup-recovery-window')!
  expect(await invoke({ sender: { id: 17 } }, 'state')).toEqual({
    phase: 'failed',
    ready: false,
    error: 'services stopped during failed installation',
  })
  expect(fixture.quit).not.toHaveBeenCalled()
})

test('releases a failed window so a later explicit retry can open it', async () => {
  fixture.window.loadFile.mockRejectedValueOnce(new Error('file unavailable'))
  const { showStartupRecovery } = await import('./startup-recovery-window.js')
  await expect(showStartupRecovery(new Error('startup failed'))).rejects.toThrow('file unavailable')
  expect(fixture.handlers.size).toBe(0)
  await showStartupRecovery(new Error('try again'))
  expect(fixture.create).toHaveBeenCalledTimes(2)
  expect(fixture.quit).not.toHaveBeenCalled()
})
