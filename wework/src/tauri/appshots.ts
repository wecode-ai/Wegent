import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { Attachment } from '@/types/api'

export const APPSHOT_CAPTURED_EVENT = 'wework-appshot-captured'
export const APPSHOT_PERMISSION_REQUIRED_EVENT = 'wework-appshot-permission-required'

export type AppshotPermission = 'screenCapture' | 'accessibility'

export interface AppshotTextPayload {
  filename: string
  fileSize: number
  path: string
  textLength: number
  textPreview: string
}

export interface AppshotPayload {
  id: string
  filename: string
  mimeType: string
  fileSize: number
  path: string
  textAttachment: AppshotTextPayload | null
}

export interface AppshotsStatus {
  supported: boolean
  shortcut: string
  shortcutRegistered: boolean
  screenCapturePermissionGranted: boolean
  accessibilityPermissionGranted: boolean
}

function payloadToAttachments(payload: AppshotPayload): Attachment[] {
  const imageId = -Number(payload.id) * 10
  const groupId = `appshot-${payload.id}`
  const attachments: Attachment[] = [
    {
      id: imageId,
      filename: payload.filename,
      file_size: payload.fileSize,
      mime_type: payload.mimeType,
      status: 'ready',
      file_extension: '.png',
      created_at: new Date().toISOString(),
      local_path: payload.path,
      local_preview_url: payload.path,
      ui_group_id: groupId,
      ui_group_role: 'primary',
      ui_kind: 'appshot',
    },
  ]
  if (payload.textAttachment) {
    attachments.push({
      id: imageId - 1,
      filename: payload.textAttachment.filename,
      file_size: payload.textAttachment.fileSize,
      mime_type: 'text/plain',
      status: 'ready',
      text_length: payload.textAttachment.textLength,
      text_preview: payload.textAttachment.textPreview,
      file_extension: '.txt',
      created_at: new Date().toISOString(),
      local_path: payload.textAttachment.path,
      local_preview_url: payload.textAttachment.path,
      ui_group_id: groupId,
      ui_group_role: 'companion',
      ui_kind: 'appshot',
    })
  }
  return attachments
}

export async function getAppshotsStatus(): Promise<AppshotsStatus> {
  return invoke<AppshotsStatus>('get_appshots_status')
}

export async function openAppshotsPermissionSettings(permission: AppshotPermission): Promise<void> {
  await invoke('open_appshots_permission_settings', { permission })
}

export async function subscribeToAppshots(
  onAttachments: (attachments: Attachment[]) => void,
  onPermissionRequired: (permission: AppshotPermission) => void
): Promise<UnlistenFn> {
  const deliveredIds = new Set<string>()
  const acknowledge = async (id: string) => {
    try {
      await invoke('acknowledge_appshot', { id })
    } catch (error) {
      console.error('[Wework] Failed to acknowledge Appshot:', error)
    }
  }
  const deliver = async (payload: AppshotPayload) => {
    if (deliveredIds.has(payload.id)) return
    deliveredIds.add(payload.id)
    onAttachments(payloadToAttachments(payload))
    await acknowledge(payload.id)
  }

  const unlistenCaptured = await listen<AppshotPayload>(APPSHOT_CAPTURED_EVENT, event => {
    void deliver(event.payload).catch(error => {
      console.error('[Wework] Failed to deliver Appshot:', error)
    })
  })
  const unlistenPermission = await listen<AppshotPermission>(
    APPSHOT_PERMISSION_REQUIRED_EVENT,
    event => {
      onPermissionRequired(event.payload)
    }
  )
  const permissionRequired = await invoke<AppshotPermission | null>(
    'take_pending_appshots_permission'
  )
  if (permissionRequired) onPermissionRequired(permissionRequired)
  const pending = await invoke<AppshotPayload[]>('take_pending_appshots')
  for (const payload of pending) {
    await deliver(payload)
  }
  return () => {
    unlistenCaptured()
    unlistenPermission()
  }
}
