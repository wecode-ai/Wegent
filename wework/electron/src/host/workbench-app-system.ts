import { clipboard, dialog, Notification, shell, type BrowserWindow } from 'electron'
import { open, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { showRetainedNotification } from './notification-lifecycle.js'
import { readBoundedFile } from './bounded-file-reader.js'

const MAX_TEXT_BYTES = 2 * 1024 * 1024

export function workbenchText(value: unknown, name: string, limit = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${name} must be a non-empty string of at most ${limit} characters`)
  }
  return value
}

export function showWorkbenchNotification(
  appName: string,
  input: Record<string, unknown>,
  onClick: () => void
): void {
  if (!Notification.isSupported()) throw new Error('System notifications are unavailable')
  const title = workbenchText(input.title, 'Notification title', 256)
  const body = input.body === undefined ? '' : rawText(input.body, 'Notification body', 4096)
  showRetainedNotification(new Notification({ title: `${appName} · ${title}`, body }), onClick)
}

export async function invokeWorkbenchSystem(
  method: string,
  params: Record<string, unknown>,
  window: BrowserWindow | null,
  appName: string,
  onNotificationClick: () => void,
  authorize: () => Promise<void>
): Promise<unknown> {
  switch (method) {
    case 'notifications.show':
      showWorkbenchNotification(appName, params, onNotificationClick)
      return null
    case 'clipboard.readText':
      return clipboard.readText()
    case 'clipboard.writeText':
      clipboard.writeText(rawText(params.text, 'Clipboard text', MAX_TEXT_BYTES))
      return null
    case 'files.openText':
      return openText(fileDialogWindow(window), authorize)
    case 'files.saveText':
      return saveText(fileDialogWindow(window), params, authorize)
    case 'external.open': {
      const url = new URL(workbenchText(params.url, 'URL', 4096))
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Only HTTP, HTTPS and mailto links without credentials are allowed')
      }
      await shell.openExternal(url.href)
      await authorize()
      return null
    }
    default:
      throw new Error(`Unknown workbench method: ${method}`)
  }
}

function fileDialogWindow(window: BrowserWindow | null): BrowserWindow {
  if (!window || window.isDestroyed())
    throw new Error('Workbench view is unavailable for file dialogs')
  return window
}

function rawText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${name} must be text of at most ${maxBytes} bytes`)
  }
  return value
}

async function openText(
  window: BrowserWindow,
  authorize: () => Promise<void>
): Promise<{ name: string; text: string } | null> {
  const result = await dialog.showOpenDialog(window, { properties: ['openFile'] })
  await authorize()
  if (result.canceled || !result.filePaths[0]) return null
  const path = result.filePaths[0]
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    await authorize()
    if (!info.isFile() || info.size > MAX_TEXT_BYTES)
      throw new Error('Choose a text file under 2 MiB')
    const contents = await readBoundedFile(file, MAX_TEXT_BYTES, authorize)
    return { name: basename(path), text: contents.toString('utf8') }
  } finally {
    await file.close()
  }
}

async function saveText(
  window: BrowserWindow,
  params: Record<string, unknown>,
  authorize: () => Promise<void>
): Promise<boolean> {
  const name = workbenchText(params.name, 'File name', 255)
  if (basename(name) !== name || /[\\/\0]/.test(name) || ['.', '..'].includes(name)) {
    throw new Error('Use a file name without directory components')
  }
  const text = rawText(params.text, 'File text', MAX_TEXT_BYTES)
  const result = await dialog.showSaveDialog(window, { defaultPath: name })
  await authorize()
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, text, { mode: 0o600 })
  return true
}
