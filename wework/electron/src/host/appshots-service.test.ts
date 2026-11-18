import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GetWindowStateInput, WindowInfo, WindowStateOutput } from '@trycua/cua-driver'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AppshotsService,
  appshotText,
  selectFrontmostWindow,
  type AppshotDriver,
} from './appshots-service.js'

const electronMocks = vi.hoisted(() => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
  openExternal: vi.fn(async () => undefined),
  beep: vi.fn(),
  screenRecordingStatus: 'granted',
  accessibilityTrusted: true,
}))

vi.mock('electron', () => ({
  globalShortcut: electronMocks.globalShortcut,
  shell: {
    beep: electronMocks.beep,
    openExternal: electronMocks.openExternal,
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => electronMocks.screenRecordingStatus),
    isTrustedAccessibilityClient: vi.fn(() => electronMocks.accessibilityTrusted),
  },
}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  )
  electronMocks.globalShortcut.register.mockClear()
  electronMocks.globalShortcut.unregister.mockClear()
  electronMocks.openExternal.mockClear()
  electronMocks.beep.mockClear()
})

function windowInfo(overrides: Partial<WindowInfo>): WindowInfo {
  return {
    windowId: 1n,
    pid: 200,
    appName: 'Safari',
    title: 'Example',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    isOnScreen: true,
    layer: 0,
    zIndex: 1n,
    onCurrentSpace: true,
    ...overrides,
  }
}

async function captureFixture(options: {
  windows: WindowInfo[]
  state?: Partial<WindowStateOutput>
  permissions?: { screenRecording: boolean; accessibility: boolean }
}) {
  const captureRoot = await mkdtemp(join(tmpdir(), 'wework-appshots-'))
  temporaryDirectories.push(captureRoot)
  const published: Array<{ type: string; payload: Record<string, unknown> }> = []
  const showMain = vi.fn(async () => undefined)
  const playSound = vi.fn(async () => undefined)
  const driver: AppshotDriver = {
    listWindows: vi.fn(async () => ({ windows: options.windows })),
    getWindowState: vi.fn(async (input: GetWindowStateInput) => {
      await writeFile(input.screenshotOutFile as string, 'png')
      return {
        pid: input.pid,
        windowId: input.windowId,
        appName: 'Safari',
        windowTitle: 'Example',
        treeMarkdown: 'Example heading\nBody text',
        images: [],
        ...options.state,
      }
    }),
    shutdown: vi.fn(async () => undefined),
  }
  const service = new AppshotsService({
    captureRoot,
    events: {
      publish: (type, payload) => {
        published.push({ type, payload })
        return published.length
      },
    },
    showMain,
    playSound,
    platform: 'darwin',
    appPid: 100,
    readPermissions: vi.fn(
      async () =>
        options.permissions ?? {
          screenRecording: true,
          accessibility: true,
        }
    ),
    requestPermissions: vi.fn(
      async () =>
        options.permissions ?? {
          screenRecording: true,
          accessibility: true,
        }
    ),
    createDriver: vi.fn(async () => driver),
    createId: () => 'capture-1',
  })
  return { captureRoot, driver, playSound, published, service, showMain }
}

describe('AppshotsService', () => {
  test('captures the frontmost non-Wework window and publishes image and text paths', async () => {
    const fixture = await captureFixture({
      windows: [
        windowInfo({ windowId: 1n, pid: 200, zIndex: 2n }),
        windowInfo({ windowId: 2n, pid: 300, appName: 'Notes', zIndex: 8n }),
        windowInfo({ windowId: 3n, pid: 100, appName: 'Wework', zIndex: 20n }),
      ],
    })

    await fixture.service.capture()

    expect(fixture.driver.getWindowState).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 300,
        windowId: 2n,
        includeAccessibilityTree: true,
        includeScreenshot: true,
        screenshotOutFile: join(fixture.captureRoot, 'capture-1', 'appshot.png'),
      })
    )
    expect(fixture.showMain).toHaveBeenCalledOnce()
    expect(fixture.published).toEqual([
      {
        type: 'wework-appshot-captured',
        payload: expect.objectContaining({
          id: 'capture-1',
          filename: 'appshot.png',
          mimeType: 'image/png',
          fileSize: 3,
          path: join(fixture.captureRoot, 'capture-1', 'appshot.png'),
          textAttachment: expect.objectContaining({
            filename: 'appshot-context.txt',
            path: join(fixture.captureRoot, 'capture-1', 'appshot-context.txt'),
            textPreview: expect.stringContaining('Safari — Example'),
          }),
        }),
      },
    ])
    await expect(
      readFile(join(fixture.captureRoot, 'capture-1', 'appshot-context.txt'), 'utf8')
    ).resolves.toContain('Body text')
  })

  test('keeps a completed capture when the optional sound cannot play', async () => {
    const fixture = await captureFixture({
      windows: [windowInfo({ windowId: 2n, pid: 300, zIndex: 8n })],
    })
    fixture.playSound.mockRejectedValueOnce(new Error('audio unavailable'))

    await expect(fixture.service.capture()).resolves.toBeUndefined()

    expect(fixture.published).toHaveLength(1)
    await expect(
      readFile(join(fixture.captureRoot, 'capture-1', 'appshot.png'), 'utf8')
    ).resolves.toBe('png')
  })

  test('requires screen recording access before starting the capture driver', async () => {
    const openScreenRecordingSettings = vi.fn(async () => undefined)
    const createDriver = vi.fn<() => Promise<AppshotDriver>>()
    const service = new AppshotsService({
      captureRoot: '/tmp/unused-appshots',
      events: { publish: vi.fn() },
      showMain: vi.fn(),
      platform: 'darwin',
      readPermissions: vi.fn(async () => ({ screenRecording: false, accessibility: true })),
      requestPermissions: vi.fn(async () => ({ screenRecording: false, accessibility: true })),
      openScreenRecordingSettings,
      createDriver,
    })

    await expect(service.capture()).rejects.toThrow('Screen recording access')
    expect(openScreenRecordingSettings).toHaveBeenCalledOnce()
    expect(createDriver).not.toHaveBeenCalled()
  })

  test('asks macOS for missing permissions only once per app session', async () => {
    const openScreenRecordingSettings = vi.fn(async () => undefined)
    const requestPermissions = vi.fn(async () => ({
      screenRecording: false,
      accessibility: false,
    }))
    const service = new AppshotsService({
      captureRoot: '/tmp/unused-appshots',
      events: { publish: vi.fn() },
      showMain: vi.fn(),
      platform: 'darwin',
      readPermissions: vi.fn(async () => ({ screenRecording: false, accessibility: false })),
      requestPermissions,
      openScreenRecordingSettings,
    })

    await expect(service.capture()).rejects.toThrow('Screen recording access')
    await expect(service.capture()).rejects.toThrow('Screen recording access')

    expect(requestPermissions).toHaveBeenCalledOnce()
    expect(openScreenRecordingSettings).toHaveBeenCalledTimes(2)
  })

  test('registers, updates, and clears the macOS global shortcut', async () => {
    const service = new AppshotsService({
      captureRoot: '/tmp/unused-appshots',
      events: { publish: vi.fn() },
      showMain: vi.fn(),
      platform: 'darwin',
      shortcutRegistry: electronMocks.globalShortcut,
      readPermissions: vi.fn(async () => ({ screenRecording: true, accessibility: true })),
    })

    service.configure('Command+Shift+3')
    await expect(service.status()).resolves.toEqual({
      supported: true,
      shortcut: 'Command+Shift+3',
      shortcutRegistered: true,
      screenCapturePermissionGranted: true,
      accessibilityPermissionGranted: true,
    })
    service.configure(null)

    expect(electronMocks.globalShortcut.register).toHaveBeenCalledWith(
      'Command+Shift+3',
      expect.any(Function)
    )
    expect(electronMocks.globalShortcut.unregister).toHaveBeenCalledWith('Command+Shift+3')
  })

  test('reports a saved but occupied shortcut as unavailable', async () => {
    electronMocks.globalShortcut.register.mockReturnValueOnce(false)
    const service = new AppshotsService({
      captureRoot: '/tmp/unused-appshots',
      events: { publish: vi.fn() },
      showMain: vi.fn(),
      platform: 'darwin',
      shortcutRegistry: electronMocks.globalShortcut,
      readPermissions: vi.fn(async () => ({ screenRecording: true, accessibility: true })),
    })

    expect(() => service.configure('Command+Shift+2')).toThrow('unavailable')
    await expect(service.status()).resolves.toMatchObject({
      shortcut: 'Command+Shift+2',
      shortcutRegistered: false,
    })
  })

  test('opens the requested native permission pane', async () => {
    const openScreenRecordingSettings = vi.fn(async () => undefined)
    const openAccessibilitySettings = vi.fn(async () => undefined)
    const service = new AppshotsService({
      captureRoot: '/tmp/unused-appshots',
      events: { publish: vi.fn() },
      showMain: vi.fn(),
      platform: 'darwin',
      openScreenRecordingSettings,
      openAccessibilitySettings,
    })

    await service.openPermissionSettings('screenCapture')
    await service.openPermissionSettings('accessibility')

    expect(openScreenRecordingSettings).toHaveBeenCalledOnce()
    expect(openAccessibilitySettings).toHaveBeenCalledOnce()
  })

  test('selects by native z-order and ignores own, hidden, and minimized windows', () => {
    const selected = selectFrontmostWindow(
      {
        windows: [
          windowInfo({ windowId: 1n, pid: 200, zIndex: 2n }),
          windowInfo({ windowId: 2n, pid: 200, zIndex: 12n, minimized: true }),
          windowInfo({ windowId: 3n, pid: 200, zIndex: 10n }),
          windowInfo({ windowId: 4n, pid: 100, zIndex: 30n }),
          windowInfo({ windowId: 5n, pid: 200, zIndex: 8n, isOnScreen: false }),
        ],
      },
      100
    )

    expect(selected?.windowId).toBe(3n)
  })

  test('keeps the accessibility tree text available to the attachment', () => {
    const target = windowInfo({})
    expect(
      appshotText(
        {
          pid: 200,
          windowId: 1n,
          appName: 'Safari',
          windowTitle: 'Example',
          treeMarkdown: 'Heading\nBody',
          images: [],
        },
        target
      )
    ).toBe('Safari — Example\n\nHeading\nBody')
  })
})
