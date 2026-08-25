import type { UnlistenFn } from './disposeDesktopListener'

export const APPSHOT_CAPTURED_EVENT = 'wework-appshot-captured'

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

export async function getAppshotsStatus(): Promise<AppshotsStatus> {
  return {
    supported: false,
    shortcut: 'CommandOrControl+Shift+2',
    shortcutRegistered: false,
    screenCapturePermissionGranted: false,
    accessibilityPermissionGranted: false,
  }
}

export async function openAppshotsPermissionSettings(permission: AppshotPermission): Promise<void> {
  void permission
  throw new Error('Appshots are not supported by the Electron desktop host')
}

export async function subscribeToAppshots(
  onAttachments: (attachments: import('@/types/api').Attachment[]) => void
): Promise<UnlistenFn> {
  void onAttachments
  return () => undefined
}
