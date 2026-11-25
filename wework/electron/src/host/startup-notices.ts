import { app, clipboard, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import type { LocalJsonReadError } from '../runtime/local-json.js'
import type { StartupRollbackNotice } from '../runtime/release-store.js'

async function showNotice(
  options: Pick<MessageBoxOptions, 'message' | 'detail'>,
  diagnostics: object,
  parent?: BrowserWindow
): Promise<void> {
  const zh = app.getLocale().startsWith('zh')
  const message: MessageBoxOptions = {
    type: 'warning',
    title: 'Wework',
    ...options,
    buttons: zh ? ['关闭', '复制诊断信息'] : ['Close', 'Copy diagnostics'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const { response } = parent
    ? await dialog.showMessageBox(parent, message)
    : await dialog.showMessageBox(message)
  if (response === 1)
    clipboard.writeText(JSON.stringify({ version: app.getVersion(), ...diagnostics }, null, 2))
}

export function showUnreadablePreferences(error: LocalJsonReadError, parent?: BrowserWindow) {
  const zh = app.getLocale().startsWith('zh')
  return showNotice(
    {
      message: zh
        ? '无法读取本地设置，已使用默认设置'
        : 'Local settings were unreadable. Defaults are in use.',
      detail: zh
        ? `${error.path}\n原文件仍保留。请检查文件权限或从有效备份恢复设置，然后重新打开 Wework。`
        : `${error.path}\nThe original file is preserved. Check its permissions or restore a known-good backup, then reopen Wework.`,
    },
    { file: error.path, code: error.code },
    parent
  )
}

export function showStartupRollback(notice: StartupRollbackNotice, parent?: BrowserWindow) {
  const zh = app.getLocale().startsWith('zh')
  return showNotice(
    {
      message: zh
        ? '新版启动失败，已回到旧版'
        : 'The new version failed to start. The previous version is running.',
      detail: zh
        ? `启动失败的版本：${notice.failedVersion}\n当前版本：${notice.restoredVersion}`
        : `Failed version: ${notice.failedVersion}\nCurrent version: ${notice.restoredVersion}`,
    },
    notice,
    parent
  )
}

export async function confirmStartupDataRestore(): Promise<boolean> {
  const zh = app.getLocale().startsWith('zh')
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Wework',
    message: zh
      ? '新版未能启动，需要恢复更新前的数据才能继续。'
      : 'The new version could not start. Pre-update data must be restored to continue.',
    detail: zh
      ? '恢复前会另外保留更新后新增的本地数据。'
      : 'Wework will save a separate copy of newer local data before restoring.',
    buttons: zh
      ? ['退出', '恢复数据', '复制诊断信息']
      : ['Quit', 'Restore data', 'Copy diagnostics'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  for (;;) {
    const { response } = await dialog.showMessageBox(options)
    if (response !== 2) return response === 1
    clipboard.writeText(
      JSON.stringify({ version: app.getVersion(), code: 'RELEASE_DATA_RESTORE_REQUIRED' }, null, 2)
    )
  }
}
