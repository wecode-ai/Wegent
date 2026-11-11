import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'

const pending = new Set<BrowserWindow>()

export function pendingWorkbenchInstallationWindow(): BrowserWindow | null {
  return [...pending].reverse().find(window => !window.isDestroyed()) ?? null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character]
  })
}

function confirmationHtml(manifest: WorkbenchAppManifest, previous?: WorkbenchAppManifest): string {
  const chinese = app.getLocale().startsWith('zh')
  const labels: Record<string, string> = chinese
    ? {
        notifications: '系统通知与定时提醒',
        'clipboard.read': '读取剪贴板',
        'clipboard.write': '写入剪贴板',
        'files.read': '读取您选择的文件',
        'files.write': '保存到您选择的文件',
        'external.open': '打开外部链接',
      }
    : {
        notifications: 'Notifications and reminders',
        'clipboard.read': 'Read clipboard',
        'clipboard.write': 'Write clipboard',
        'files.read': 'Read files you select',
        'files.write': 'Save files you select',
        'external.open': 'Open external links',
      }
  const replacement = previous
    ? chinese
      ? `将替换已有工作台 ${previous.displayName}（${previous.name}），并保留、访问其本机数据和提醒。`
      : `Replaces ${previous.displayName} (${previous.name}) and retains access to its local data and reminders.`
    : ''
  const native = manifest.capabilities?.native ?? []
  const capabilities = native.length
    ? native.map(capability => labels[capability])
    : [chinese ? '仅应用自己的本机存储' : 'Only its own local storage']
  return `<!doctype html><html lang="${chinese ? 'zh' : 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${chinese ? '安装工作台' : 'Install Workbench'}</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:light-dark(#fff,#181818);color:light-dark(#202020,#fafafa)}*{box-sizing:border-box}body{margin:0;padding:24px;overflow-wrap:anywhere}h1{font:inherit;font-weight:600}p{white-space:pre-wrap;line-height:1.5}ul{padding-inline-start:24px}li{margin-block:8px}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}button{font:inherit;padding:10px 16px;min-height:44px;border:1px solid light-dark(#ddd,#444);border-radius:8px;background:transparent;color:inherit}#install{background:light-dark(#222,#eee);color:light-dark(#fff,#181818)}button:focus-visible{outline:2px solid #339cff;outline-offset:2px}</style></head><body>
<h1 data-testid="workbench-install-name">${escapeHtml(manifest.displayName)}</h1>
<p>${escapeHtml(manifest.description)}</p>${replacement ? `<p data-testid="workbench-install-replacement">${escapeHtml(replacement)}</p>` : ''}
<p>${manifest.flavor === 'lightweight' ? (chinese ? '轻量型：页面在隔离沙箱内运行。' : 'Lightweight: its page runs in an isolated sandbox.') : chinese ? '扩展型：DSH Host 插件在本机运行，具有插件自身的系统访问能力。' : 'Extended: DSH Host plugins run locally with their own system access.'}</p>
<p>${chinese ? '申请的 Wework 原生能力：' : 'Requested Wework native capabilities:'}</p><ul data-testid="workbench-install-capabilities">${capabilities.map(label => `<li>${escapeHtml(label)}</li>`).join('')}</ul>
<p>${chinese ? '关闭窗口后的运行方式遵循工作台设置。已安排的提醒由 Wework 管理。' : 'Background execution follows this workbench’s settings. Scheduled reminders are managed by Wework.'}</p>
<div class="actions"><button id="cancel" data-testid="workbench-install-cancel" autofocus>${chinese ? '取消' : 'Cancel'}</button><button id="install" data-testid="workbench-install-accept">${chinese ? '安装' : 'Install'}</button></div>
<script>for(const id of ['install','cancel'])document.getElementById(id).onclick=()=>window.weworkWorkbenchInstallation.respond(id==='install')</script></body></html>`
}

export async function confirmWorkbenchInstallation(
  manifest: WorkbenchAppManifest,
  parent: BrowserWindow | null,
  previous?: WorkbenchAppManifest,
  preloadPath?: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false
  if (!preloadPath) throw new Error('Workbench installation preload is required')
  const channel = `workbench-install:${randomUUID()}`
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(confirmationHtml(manifest, previous))}`
  const owner = parent && !parent.isDestroyed() ? parent : undefined
  const window = new BrowserWindow({
    width: 500,
    height: 520,
    minWidth: 360,
    minHeight: 360,
    title: app.getLocale().startsWith('zh') ? '安装工作台' : 'Install Workbench',
    parent: owner,
    modal: Boolean(owner),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      partition: 'wework-workbench-installation',
      additionalArguments: [`--wework-workbench-install-channel=${channel}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  pending.add(window)
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-redirect', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  return new Promise(resolve => {
    let settled = false
    const finish = (accepted: boolean) => {
      if (settled) return
      settled = true
      ipcMain.removeListener(channel, respond)
      signal?.removeEventListener('abort', onAbort)
      pending.delete(window)
      if (!window.isDestroyed()) window.destroy()
      resolve(accepted)
    }
    const respond = (event: IpcMainEvent, accepted: unknown) => {
      if (
        typeof accepted !== 'boolean' ||
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame?.url !== page
      )
        return
      finish(accepted)
    }
    const onAbort = () => finish(false)
    ipcMain.on(channel, respond)
    window.on('closed', () => finish(false))
    window.webContents.on('render-process-gone', () => finish(false))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      finish(false)
      return
    }
    void window.loadURL(page).then(
      () => {
        if (!settled) {
          window.show()
          window.focus()
        }
      },
      () => finish(false)
    )
  })
}
