import {
  invokeDesktopHost,
  subscribeDesktopHostEvents,
  type DesktopHostEvent,
} from '@/api/dsh/desktopHost'
import type { Attachment } from '@/types/api'
import type { UnlistenFn } from './disposeDesktopListener'

export const APPSHOT_CAPTURED_EVENT = 'wework-appshot-captured'
export const APPSHOT_FAILED_EVENT = 'wework-appshot-failed'

export type AppshotPermission = 'screenCapture' | 'accessibility'

export interface AppshotsStatus {
  supported: boolean
  shortcut: string | null
  shortcutRegistered: boolean
  screenCapturePermissionGranted: boolean
  accessibilityPermissionGranted: boolean
}

interface AppshotTextPayload {
  filename: string
  fileSize: number
  path: string
  textLength: number
  textPreview: string
}

interface AppshotCapturedPayload {
  id: string
  filename: string
  mimeType: string
  fileSize: number
  path: string
  textAttachment: AppshotTextPayload | null
}

const deliveredAppshots = new Set<string>()
let attachmentIdSeed = 0

export async function getAppshotsStatus(): Promise<AppshotsStatus> {
  return invokeDesktopHost<AppshotsStatus>('appshots.getStatus')
}

export async function openAppshotsPermissionSettings(permission: AppshotPermission): Promise<void> {
  await invokeDesktopHost<void>('appshots.openPermissionSettings', { permission })
}

export async function captureAppshot(): Promise<void> {
  await invokeDesktopHost<void>('appshots.capture')
}

export async function subscribeToAppshots(
  onAttachments: (attachments: Attachment[]) => void
): Promise<UnlistenFn> {
  const handleEvent = (event: DesktopHostEvent): void => {
    if (event.type === APPSHOT_FAILED_EVENT) {
      const message = typeof event.payload.message === 'string' ? event.payload.message : null
      console.error('[Wework] Appshot failed:', message ?? 'Unknown capture failure')
      return
    }
    if (event.type !== APPSHOT_CAPTURED_EVENT) return

    const payload = parseCapturedPayload(event.payload)
    if (!payload || deliveredAppshots.has(payload.id)) return
    deliveredAppshots.add(payload.id)
    onAttachments(attachmentsFromPayload(payload))
  }

  return Promise.resolve(
    subscribeDesktopHostEvents(handleEvent, {
      replay: event => event.type === APPSHOT_CAPTURED_EVENT,
    })
  )
}

function parseCapturedPayload(payload: Record<string, unknown>): AppshotCapturedPayload | null {
  if (
    typeof payload.id !== 'string' ||
    !payload.id ||
    typeof payload.filename !== 'string' ||
    !payload.filename ||
    typeof payload.mimeType !== 'string' ||
    !payload.mimeType ||
    !isNonNegativeInteger(payload.fileSize) ||
    typeof payload.path !== 'string' ||
    !payload.path
  ) {
    return null
  }
  return {
    id: payload.id,
    filename: payload.filename,
    mimeType: payload.mimeType,
    fileSize: payload.fileSize,
    path: payload.path,
    textAttachment: parseTextPayload(payload.textAttachment),
  }
}

function parseTextPayload(value: unknown): AppshotTextPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  if (
    typeof payload.filename !== 'string' ||
    !payload.filename ||
    !isNonNegativeInteger(payload.fileSize) ||
    typeof payload.path !== 'string' ||
    !payload.path ||
    !isNonNegativeInteger(payload.textLength) ||
    typeof payload.textPreview !== 'string'
  ) {
    return null
  }
  return {
    filename: payload.filename,
    fileSize: payload.fileSize,
    path: payload.path,
    textLength: payload.textLength,
    textPreview: payload.textPreview,
  }
}

function attachmentsFromPayload(payload: AppshotCapturedPayload): Attachment[] {
  const createdAt = new Date().toISOString()
  const groupId = `appshot-${payload.id}`
  const image: Attachment = {
    id: nextAttachmentId(),
    filename: payload.filename,
    file_size: payload.fileSize,
    mime_type: payload.mimeType,
    status: 'ready',
    file_extension: fileExtension(payload.filename),
    created_at: createdAt,
    local_path: payload.path,
    local_preview_url: payload.path,
    ui_group_id: groupId,
    ui_group_role: 'primary',
    ui_kind: 'appshot',
  }
  if (!payload.textAttachment) return [image]
  return [
    image,
    {
      id: nextAttachmentId(),
      filename: payload.textAttachment.filename,
      file_size: payload.textAttachment.fileSize,
      mime_type: 'text/plain',
      status: 'ready',
      text_length: payload.textAttachment.textLength,
      text_preview: payload.textAttachment.textPreview,
      file_extension: fileExtension(payload.textAttachment.filename),
      created_at: createdAt,
      local_path: payload.textAttachment.path,
      local_preview_url: payload.textAttachment.path,
      ui_group_id: groupId,
      ui_group_role: 'companion',
      ui_kind: 'appshot',
    },
  ]
}

function nextAttachmentId(): number {
  attachmentIdSeed += 1
  return -(Date.now() * 1000 + attachmentIdSeed)
}

function fileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex >= 0 ? filename.slice(dotIndex) : ''
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
