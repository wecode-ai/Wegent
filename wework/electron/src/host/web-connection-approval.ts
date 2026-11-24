import { app, dialog, type BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import type { WebConnectionScope } from './web-connection-grants.js'

export async function confirmWebConnectionTrial(
  scope: WebConnectionScope,
  parent: BrowserWindow | null,
  language = app.getLocale()
): Promise<boolean> {
  const locale = language.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
  const copy = JSON.parse(
    await readFile(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8')
  ) as Record<string, string>
  const quoted = (value: string) =>
    JSON.stringify(value).replace(
      /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
  const detail = [
    copy.web_connection_native_explanation,
    scope.origin,
    `${quoted(scope.name)} · ${quoted(scope.account)}`,
    ...scope.operations.map(operation => `${operation.method} ${operation.path}`),
  ].join('\n')
  const options = {
    type: 'question' as const,
    title: copy.web_connection_native_title,
    message: copy.web_connection_native_title,
    detail,
    buttons: [copy.core_dsh_plugins_cancel, copy.web_connection_native_allow],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const window = parent && !parent.isDestroyed() ? parent : null
  console.info('[web-connection-trial] native approval requested', {
    parentVisible: window?.isVisible() ?? false,
    parentFocused: window?.isFocused() ?? false,
  })
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  console.info('[web-connection-trial] native approval resolved', {
    approved: result.response === 1,
  })
  return result.response === 1
}
