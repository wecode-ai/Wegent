import type { BrowserWindow } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import { prepareStartupMainWindow } from './startup-window-handoff.js'

function fixture() {
  const calls: string[] = []
  const bounds = { x: 120, y: 80, width: 1200, height: 800 }
  const main = {
    getBounds: () => bounds,
    getMediaSourceId: () => 'window:12:0',
    hide: vi.fn(() => calls.push('hide')),
    isDestroyed: () => false,
    maximize: vi.fn(() => calls.push('maximize')),
    setBounds: vi.fn(() => calls.push('bounds')),
    setOpacity: vi.fn((value: number) => calls.push(`opacity:${value}`)),
    showInactive: vi.fn(() => calls.push('show-inactive')),
    webContents: {
      capturePage: vi.fn(async () => {
        calls.push('painted')
        return { isEmpty: () => false }
      }),
    },
  }
  const splash = {
    getBounds: () => bounds,
    isMaximized: () => false,
    moveAbove: vi.fn(() => calls.push('splash-above')),
  }
  const prepare = (show = true) =>
    prepareStartupMainWindow(
      main as unknown as BrowserWindow,
      splash as unknown as BrowserWindow,
      show
    )
  return { prepare, main, splash, calls, bounds }
}

describe('preparing the native startup destination', () => {
  test('aligns geometry and native stacking, then exposes a painted main behind the splash', async () => {
    const { prepare, main, splash, calls, bounds } = fixture()
    expect(await prepare()).toEqual({ main: bounds, splash: bounds })
    expect(main.setBounds).toHaveBeenCalledWith(bounds)
    expect(splash.moveAbove).toHaveBeenCalledWith('window:12:0')
    expect(calls).toEqual([
      'opacity:0',
      'bounds',
      'show-inactive',
      'splash-above',
      'painted',
      'opacity:1',
    ])
    expect(main.maximize).not.toHaveBeenCalled()
  })

  test('keeps controlled background startup hidden while still waiting for a painted frame', async () => {
    const { prepare, main, splash, calls } = fixture()
    await prepare(false)
    expect(main.showInactive).not.toHaveBeenCalled()
    expect(splash.moveAbove).not.toHaveBeenCalled()
    expect(calls).toEqual(['opacity:0', 'bounds', 'painted', 'opacity:1'])
  })

  test('preserves maximized startup geometry without taking focus', async () => {
    const { prepare, main, splash } = fixture()
    splash.isMaximized = () => true
    await prepare()
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(main.showInactive).toHaveBeenCalledOnce()
  })

  test('hides a failed destination and restores its opacity before propagating failure', async () => {
    const { prepare, main, calls } = fixture()
    main.webContents.capturePage.mockRejectedValueOnce(new Error('Renderer stopped'))
    await expect(prepare()).rejects.toThrow('Renderer stopped')
    expect(calls.slice(-2)).toEqual(['hide', 'opacity:1'])
  })

  test('refuses to expose a destination with no composited frame', async () => {
    const { prepare, main } = fixture()
    main.webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true })
    await expect(prepare()).rejects.toThrow('did not produce a frame')
    expect(main.hide).toHaveBeenCalledOnce()
    expect(main.setOpacity).toHaveBeenLastCalledWith(1)
  })
})
