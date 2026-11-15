import type { Attachment } from '@/types/runtime'

/** Linux paths are runtime-owned files, never iOS file:// URLs or Backend attachments. */
export function localRuntimeFileReference(
  deviceId: string,
  path: string
): NonNullable<Attachment['workspace_file']> {
  if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))
    throw new Error('本机执行器返回了无效的附件路径')
  const separator = path.lastIndexOf('/')
  return { device_id: deviceId, workspace_path: path.slice(0, separator) || '/', path }
}

export function withLocalRuntimeFileReferences<T>(value: T, deviceId: string): T {
  if (Array.isArray(value))
    return value.map(item => withLocalRuntimeFileReferences(item, deviceId)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === 'attachments' && Array.isArray(item))
        return [
          key,
          item.map(attachment => {
            if (
              attachment &&
              typeof attachment === 'object' &&
              typeof attachment.local_path === 'string' &&
              attachment.local_path.startsWith('/')
            )
              return {
                ...attachment,
                workspace_file: localRuntimeFileReference(deviceId, attachment.local_path),
              }
            return attachment
          }),
        ]
      return [key, withLocalRuntimeFileReferences(item, deviceId)]
    })
  ) as T
}
