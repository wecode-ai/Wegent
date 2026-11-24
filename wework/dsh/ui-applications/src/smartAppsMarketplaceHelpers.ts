import JSZip from 'jszip'
import { type HarnessAppManifest } from '@/api/local/harnessApps'

export const MAX_SMART_APP_PACKAGE_BYTES = 50 * 1024 * 1024
export const MAX_SMART_APP_ICON_BYTES = 512 * 1024
export const MAX_SMART_APP_SCREENSHOT_BYTES = 2 * 1024 * 1024

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function formatUpdatedAt(value: string, language: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ''
  const elapsed = timestamp - Date.now()
  const absoluteElapsed = Math.abs(elapsed)
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (absoluteElapsed < 60 * 60 * 1000) {
    return formatter.format(Math.round(elapsed / (60 * 1000)), 'minute')
  }
  if (absoluteElapsed < 24 * 60 * 60 * 1000) {
    return formatter.format(Math.round(elapsed / (60 * 60 * 1000)), 'hour')
  }
  return formatter.format(Math.round(elapsed / (24 * 60 * 60 * 1000)), 'day')
}

export function readDataUrl(file: File, errorMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error(errorMessage))
    reader.readAsDataURL(file)
  })
}

export function validatePublishImage(
  file: File,
  kind: 'icon' | 'screenshot',
  t: (key: string, fallback: string) => string
): string | null {
  const supportedTypes =
    kind === 'icon'
      ? new Set(['image/png', 'image/webp'])
      : new Set(['image/png', 'image/webp', 'image/jpeg'])
  if (!supportedTypes.has(file.type)) {
    return kind === 'icon'
      ? t('workbench.smart_apps_error_icon_format', '图标仅支持 PNG 或 WebP 格式。')
      : t('workbench.smart_apps_error_screenshot_format', '截图仅支持 PNG、WebP 或 JPEG 格式。')
  }
  const limit = kind === 'icon' ? MAX_SMART_APP_ICON_BYTES : MAX_SMART_APP_SCREENSHOT_BYTES
  if (file.size <= limit) return null
  return kind === 'icon'
    ? t('workbench.smart_apps_error_icon_too_large', '图标不能超过 512 KB。')
    : t('workbench.smart_apps_error_screenshot_too_large', '单张截图不能超过 2 MB。')
}

export async function readManifest(
  file: File,
  messages: { missingManifest: string; invalidPackage: string }
): Promise<HarnessAppManifest> {
  const archive = await JSZip.loadAsync(file)
  const candidates = Object.values(archive.files).filter(entry => {
    const parts = entry.name.split('/').filter(Boolean)
    return !entry.dir && parts.at(-1) === 'plugin-manifest.json' && parts.length <= 2
  })
  if (candidates.length !== 1) throw new Error(messages.missingManifest)
  const manifest = JSON.parse(await candidates[0].async('string')) as HarnessAppManifest
  if (manifest.type !== 'deepseek-harness-plugin-bundle') {
    throw new Error(messages.invalidPackage)
  }
  return manifest
}
