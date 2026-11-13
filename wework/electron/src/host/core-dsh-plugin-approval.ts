import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { readFile } from 'node:fs/promises'
import type { CoreDshPluginInstallRequest } from '../runtime/core-dsh-plugin-manager.js'

export function coreDshPluginInstallDialog(
  request: CoreDshPluginInstallRequest,
  copy: Record<string, string>
): MessageBoxOptions {
  const text = (key: string) => {
    const value = copy[`core_dsh_plugins_${key}`]
    if (!value) throw new Error(`Native plugin approval translation missing: ${key}`)
    return value
  }
  const updating = request.action === 'update'
  // Escape bidi controls as well as newlines so source text cannot impersonate the warning.
  const source = JSON.stringify(request.spec).replace(
    /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  return {
    type: 'warning',
    title: text(updating ? 'native_update_title' : 'native_title'),
    message: text(updating ? 'update_confirm_title' : 'install_confirm_title'),
    detail: `${text('source')}: ${source}\n\n${text(updating ? 'update_confirm_description' : 'install_confirm_description')}`,
    buttons: [text('cancel'), text(updating ? 'allow_update' : 'allow_install')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

export async function confirmCoreDshPluginInstall(
  request: CoreDshPluginInstallRequest,
  parent: BrowserWindow | null,
  language = app.getLocale()
): Promise<boolean> {
  const locale = language.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
  const copy = JSON.parse(
    await readFile(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8')
  ) as Record<string, string>
  const options = coreDshPluginInstallDialog(request, copy)
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  // Record only the native decision, never plugin sources or authentication material.
  console.info('[Wework] Core plugin native decision', {
    action: request.action,
    response: result.response,
  })
  return result.response === 1
}
