import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'

export async function showPopoutWindow(): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('show_popout_window')
}

export async function dismissPopoutWindow(): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('dismiss_popout_window')
}

export async function setPopoutWindowExpanded(expanded: boolean): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('set_popout_window_expanded', { expanded })
}

export async function setPopoutWindowOverlayActive(active: boolean): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('set_popout_window_overlay_active', { active })
}

export async function openPopoutTaskInMain(address: {
  deviceId: string
  taskId: string
}): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('open_popout_task_in_main', address)
}
