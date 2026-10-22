import { beforeEach, describe, expect, test, vi } from 'vitest'
import { openPopoutTaskInMain, setPopoutWindowMode } from './popoutWindow'

const invokeDesktopHostMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invokeDesktopHostMock,
}))

describe('Popout Window desktop bridge', () => {
  beforeEach(() => {
    invokeDesktopHostMock.mockReset()
    invokeDesktopHostMock.mockResolvedValue(undefined)
  })

  test('routes the selected task to the main window through the desktop host', async () => {
    await openPopoutTaskInMain({ deviceId: 'local:device', taskId: 'task/1' })

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('window.openPopoutTaskInMain', {
      taskAddressId: 'local%3Adevice:task%2F1',
    })
  })

  test('uses one native layout mode for the composer and its menu', async () => {
    await setPopoutWindowMode('menu')

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('window.setPopoutMode', {
      mode: 'menu',
    })
  })
})
