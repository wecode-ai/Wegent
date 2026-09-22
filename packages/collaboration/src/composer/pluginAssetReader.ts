import { splitAbsoluteWorkspaceFilePath } from '@wegent/chat-core/workspace-file-contract'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'

/** Resolve device-owned images through the same addressed file reader as attachments. */
export function createComposerPluginAssetReader(
  read: SharedWorkspaceRuntimeApi['readWorkspaceFile'],
  deviceId: string
) {
  const pending = new Map<string, Promise<string>>()
  return (value: string): Promise<string> => {
    if (!/^(?:\/|[a-zA-Z]:[\\/]|file:)/.test(value)) return Promise.resolve(value)
    const existing = pending.get(value)
    if (existing) return existing
    const path = value.startsWith('file:')
      ? decodeURIComponent(new URL(value).pathname).replace(/^\/([a-zA-Z]:\/)/, '$1')
      : value
    const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(path)
    const extension = fileName.split('.').pop()?.toLowerCase()
    const mimeTypes: Record<string, string> = {
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      avif: 'image/avif',
      ico: 'image/x-icon',
    }
    const result = read(
      { device_id: deviceId, workspace_path: parentPath, path: fileName },
      mimeTypes[extension ?? '']
    )
      .then(
        blob =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error ?? new Error('Failed to read plugin image'))
            reader.readAsDataURL(blob)
          })
      )
      .finally(() => pending.delete(value))
    pending.set(value, result)
    return result
  }
}
