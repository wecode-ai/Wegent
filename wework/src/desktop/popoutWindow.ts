import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { createTrayTaskMenuId } from './trayTaskMenuId'

export async function showPopoutWindow(): Promise<void> {
  await invokeDesktopHost('window.showPopout')
}

export async function dismissPopoutWindow(): Promise<void> {
  await invokeDesktopHost('window.dismissPopout')
}

export type PopoutWindowMode = 'composer' | 'menu' | 'conversation'

export async function setPopoutWindowMode(mode: PopoutWindowMode): Promise<void> {
  await invokeDesktopHost('window.setPopoutMode', { mode })
}

export async function openPopoutTaskInMain(address: {
  deviceId: string
  taskId: string
}): Promise<void> {
  await invokeDesktopHost('window.openPopoutTaskInMain', {
    taskAddressId: createTrayTaskMenuId(address),
  })
}
