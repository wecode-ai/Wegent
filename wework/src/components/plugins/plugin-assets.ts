import { convertFileSrc } from '@tauri-apps/api/core'

function isLocalAssetPath(value: string): boolean {
  if (value.startsWith('file://')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  return value.startsWith('/')
}

function localPathFromFileUrl(value: string): string {
  if (!value.startsWith('file://')) return value

  try {
    const pathname = decodeURIComponent(new URL(value).pathname)
    return pathname.match(/^\/[a-zA-Z]:\//) ? pathname.slice(1) : pathname
  } catch {
    return value
  }
}

export function resolvePluginAssetUrl(value?: string | null): string {
  const source = value?.trim()
  if (!source) return ''
  if (!isLocalAssetPath(source)) return source

  try {
    return convertFileSrc(localPathFromFileUrl(source))
  } catch {
    return source
  }
}
