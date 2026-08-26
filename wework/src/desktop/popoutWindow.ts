import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export async function showPopoutWindow(): Promise<void> {
  await invokeDesktopHost('window.showPopout')
}

export async function dismissPopoutWindow(): Promise<void> {
  await invokeDesktopHost('window.dismissPopout')
}

export async function setPopoutWindowExpanded(expanded: boolean): Promise<void> {
  void expanded
}

export async function setPopoutWindowOverlayActive(active: boolean): Promise<void> {
  void active
}

export async function openPopoutTaskInMain(address: {
  deviceId: string
  taskId: string
}): Promise<void> {
  window.dispatchEvent(new CustomEvent('wework:open-popout-task-in-main', { detail: address }))
}
