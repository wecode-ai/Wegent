import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Notification,
  shell,
  type WebContents,
  type FileFilter,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOST_CAPABILITIES,
  HostCapabilityError,
  HostCapabilityRouter,
} from './capability-router.js'
import type { RendererHealthSnapshot } from './renderer-health.js'
import type { SmartAppManager } from './smart-app-manager.js'
import type { PreferencesStore } from './preferences-store.js'
import type { BrowserBounds, EmbeddedBrowserManager } from './embedded-browser-manager.js'
import { LocalAttachmentStore } from './local-attachment-store.js'
import { readLocalFileChunk } from './local-file-reader.js'
import { getElectronProcessSnapshot } from './process-diagnostics.js'
import {
  extractFilePathsFromNativePayloads,
  inspectWorkspacePaths,
} from './workspace-path-inspector.js'
import { FeedbackBundleManager, type FeedbackExportRequest } from './feedback-bundle-manager.js'
import { WorkbenchPluginManager } from './workbench-plugin-manager.js'
import { captureWebContentsDataUrl } from './web-contents-capture.js'
import type { TrayActivation, TrayAction, TrayMenuState, TraySnapshot } from './tray-manager.js'
import type { StartupSplashSnapshot } from './startup-splash.js'

export { captureWebContentsDataUrl } from './web-contents-capture.js'

export const WEWORK_APP_PRINCIPAL = '@wegent/dsh-app-wework'

export interface ElectronDesktopServices {
  feedback: FeedbackBundleManager
  plugins: WorkbenchPluginManager
}

export interface ElectronE2EHost {
  capturePopout: () => Promise<string>
  captureWorkbench: (tabId: string) => Promise<string>
  captureTarget: (windowLabel: string) => WebContents | null
  closeRequestState: (after: number) => {
    requested: boolean
    revision: number
  }
  cancelCloseToTray: () => Promise<void>
  closeToTray: () => Promise<void>
  completeSystemDragDrop: (payload: {
    action: 'new-chat' | 'follow-up' | 'stash'
    text: string | null
    paths: string[]
  }) => Promise<void>
  dismissPopout: () => void
  dismissSystemDragPanel: () => void
  evaluateWorkbench: (tabId: string, expression: string) => Promise<unknown>
  focusWindow: (windowLabel: string) => void
  hideMainWindow: () => Promise<void>
  dockVisible: () => boolean
  getSystemDragContext: () => { conversationTitle: string | null }
  runtimeDiagnostics: () => {
    coreDshPid: number | null
    executorPid: number | null
    workbenchRuntimes: unknown[]
  }
  startupSplashSnapshot: () => StartupSplashSnapshot | null
  trayActivate: (activation: TrayActivation) => boolean
  traySetState: (state: TrayMenuState) => void
  traySnapshot: () => TraySnapshot | null
  takePendingTrayActions: () => TrayAction[]
  scheduleCoreDshRestart: () => void
  openWorkspace: (input: { label: string; route: string; title: string }) => Promise<void>
  popoutWindowSnapshot: () => {
    exists: boolean
    focused: boolean
    visible: boolean
  }
  setSystemDragContext: (context: { conversationTitle: string | null }) => void
  setSystemSleepEnabled: (enabled: boolean) => void
  setSystemSleepTaskActive: (source: string, active: boolean) => void
  showPopout: () => Promise<void>
  showSystemDragPanel: () => Promise<void>
  systemDragPanelVisible: () => boolean
  takePendingSystemDrops: () => Array<{
    action: 'new-chat' | 'follow-up' | 'stash'
    text: string | null
    paths: string[]
  }>
  workspaceWindowSnapshots: () => Array<{
    label: string
    focused: boolean
    visible: boolean
  }>
}

export function createElectronCapabilityRouter(
  window: () => BrowserWindow | null,
  rendererHealth: () => RendererHealthSnapshot,
  smartApps: () => SmartAppManager | null,
  preferences: PreferencesStore,
  browser: EmbeddedBrowserManager,
  desktopServices: ElectronDesktopServices,
  e2eHost: ElectronE2EHost = {
    capturePopout: () => Promise.reject(new Error('Popout Window is unavailable')),
    captureWorkbench: () => Promise.reject(new Error('Workbench tabs are unavailable')),
    captureTarget: () => null,
    closeRequestState: after => ({ requested: false, revision: after }),
    cancelCloseToTray: () => Promise.reject(new Error('Close to tray is unavailable')),
    closeToTray: () => Promise.reject(new Error('Close to tray is unavailable')),
    completeSystemDragDrop: () => Promise.reject(new Error('System drag is unavailable')),
    dismissPopout: () => undefined,
    dismissSystemDragPanel: () => undefined,
    evaluateWorkbench: () => Promise.reject(new Error('Workbench tabs are unavailable')),
    focusWindow: () => undefined,
    hideMainWindow: () => Promise.reject(new Error('Main window backgrounding is unavailable')),
    dockVisible: () => true,
    getSystemDragContext: () => ({ conversationTitle: null }),
    runtimeDiagnostics: () => ({
      coreDshPid: null,
      executorPid: null,
      workbenchRuntimes: [],
    }),
    startupSplashSnapshot: () => null,
    trayActivate: () => false,
    traySetState: () => undefined,
    traySnapshot: () => null,
    takePendingTrayActions: () => [],
    scheduleCoreDshRestart: () => undefined,
    openWorkspace: () => Promise.reject(new Error('Workspace windows are unavailable')),
    popoutWindowSnapshot: () => ({ exists: false, focused: false, visible: false }),
    setSystemDragContext: () => undefined,
    setSystemSleepEnabled: () => undefined,
    setSystemSleepTaskActive: () => undefined,
    showPopout: () => Promise.reject(new Error('Popout Window is unavailable')),
    showSystemDragPanel: () => Promise.reject(new Error('System drag is unavailable')),
    systemDragPanelVisible: () => false,
    takePendingSystemDrops: () => [],
    workspaceWindowSnapshots: () => [],
  }
): HostCapabilityRouter {
  const router = new HostCapabilityRouter()
  const attachments = new LocalAttachmentStore(localAttachmentRoot())
  router.grant(WEWORK_APP_PRINCIPAL, HOST_CAPABILITIES)

  router.register('app.getVersion', () => ({ version: app.getVersion() }))
  router.register('attachment.begin', params =>
    attachments.begin(stringParam(params, 'filename'), requiredIntegerParam(params, 'size'))
  )
  router.register('attachment.append', params =>
    attachments.append(
      stringParam(params, 'uploadId'),
      requiredIntegerParam(params, 'offset'),
      stringParam(params, 'chunkBase64')
    )
  )
  router.register('attachment.finish', params =>
    attachments.finish(stringParam(params, 'uploadId'))
  )
  router.register('attachment.abort', params => attachments.abort(stringParam(params, 'uploadId')))
  router.register('browser.open', params =>
    browser.open({
      label: stringParam(params, 'label'),
      url: stringParam(params, 'url'),
      bounds: browserBoundsParam(params),
      visible: booleanParam(params, 'visible') ?? true,
      navigateExisting: booleanParam(params, 'navigateExisting') ?? true,
    })
  )
  router.register('browser.setBounds', params =>
    browser.setBounds(
      stringParam(params, 'label'),
      browserBoundsParam(params),
      booleanParam(params, 'visible') ?? true
    )
  )
  router.register('browser.setDeviceMetrics', params => {
    const width = nullableIntegerParam(params, 'width')
    const height = nullableIntegerParam(params, 'height')
    const scale = nullableNumberParam(params, 'scale')
    const hasMetrics = width != null || height != null || scale != null
    if (hasMetrics && (width == null || height == null || scale == null)) {
      invalidParam('browser.setDeviceMetrics')
    }
    return browser.setDeviceMetrics(
      stringParam(params, 'label'),
      hasMetrics
        ? { width: width as number, height: height as number, scale: scale as number }
        : null
    )
  })
  router.register('browser.navigate', params =>
    browser.navigate(stringParam(params, 'label'), stringParam(params, 'url'))
  )
  router.register('browser.reload', params => browser.reload(stringParam(params, 'label')))
  router.register('browser.goBack', params => browser.goBack(stringParam(params, 'label')))
  router.register('browser.goForward', params => browser.goForward(stringParam(params, 'label')))
  registerBrowserHistoryCapabilities(router, browser)
  router.register('browser.setZoom', params =>
    browser.setZoom(stringParam(params, 'label'), numberParam(params, 'scaleFactor'))
  )
  router.register('browser.evaluate', params => {
    const label = stringParam(params, 'label')
    const expression = stringParam(params, 'expression')
    return isWorkbenchTabLabel(label)
      ? e2eHost.evaluateWorkbench(label, expression)
      : browser.evaluate(label, expression)
  })
  router.register('browser.pageState', params => browser.state(stringParam(params, 'label')))
  router.register('browser.relabel', params =>
    browser.relabel(stringParam(params, 'fromLabel'), stringParam(params, 'toLabel'))
  )
  router.register('browser.setActiveTab', params =>
    browser.setActiveTab(stringParam(params, 'baseLabel'), stringParam(params, 'activeTabLabel'))
  )
  router.register('browser.setAgentControlPaused', params =>
    browser.setAgentControlPaused(
      stringParam(params, 'label'),
      booleanParam(params, 'paused') ?? false
    )
  )
  router.register('browser.resolveAgentApproval', params =>
    browser.resolveAgentApproval(
      stringParam(params, 'label'),
      stringParam(params, 'approvalId'),
      booleanParam(params, 'approved') ?? false
    )
  )
  router.register('browser.close', params => browser.close(stringParam(params, 'label')))
  router.register('browser.closeMany', params =>
    browser.closeMany(stringArrayParam(params, 'labels') ?? [])
  )
  router.register('browser.clearData', params =>
    browser.clearData(nullableStringArrayParam(params, 'dataKinds') ?? null)
  )
  router.register('browser.capture', params => {
    const label = stringParam(params, 'label')
    return isWorkbenchTabLabel(label) ? e2eHost.captureWorkbench(label) : browser.capture(label)
  })
  router.register('browser.events', params =>
    browser.readEvents(integerParam(params, 'after') ?? 0)
  )
  router.register('browser.pauseDownload', params =>
    browser.pauseDownload(stringParam(params, 'id'))
  )
  router.register('browser.resumeDownload', params =>
    browser.resumeDownload(stringParam(params, 'id'))
  )
  router.register('browser.deleteDownload', params =>
    browser.deleteDownload(stringParam(params, 'id'))
  )
  router.register('clipboard.readWorkspacePaths', async params => {
    const fallbackPaths = stringArrayParam(params, 'fallbackPaths') ?? []
    const nativePayloads = clipboard
      .availableFormats()
      .filter(format => /(file|filename|uri)/i.test(format))
      .flatMap(format => {
        const values: string[] = []
        try {
          values.push(clipboard.read(format))
        } catch {
          // Some native formats can only be read as buffers.
        }
        try {
          const buffer = clipboard.readBuffer(format)
          if (buffer.length > 0) {
            values.push(buffer.toString('utf8'), buffer.toString('utf16le'))
          }
        } catch {
          // Ignore unsupported clipboard encodings.
        }
        return values
      })
    return inspectWorkspacePaths([
      ...extractFilePathsFromNativePayloads(nativePayloads),
      ...fallbackPaths,
    ])
  })
  router.register('clipboard.writeText', params => clipboard.writeText(stringParam(params, 'text')))
  registerDesktopServiceCapabilities(router, desktopServices, {
    openLogDirectory: async () => {
      const logDirectory = app.getPath('logs')
      await mkdirDirectory(logDirectory)
      const error = await shell.openPath(logDirectory)
      if (error) throw new HostCapabilityError('open_log_directory_failed', error)
    },
    openDevTools: () => {
      const contents = requiredWindow(window).webContents
      if (contents.isDestroyed()) {
        throw new HostCapabilityError('window_unavailable', 'Desktop web contents are unavailable')
      }
      contents.openDevTools({ mode: 'detach', activate: true })
    },
  })
  router.register('e2e.capturePopoutWindow', () => e2eHost.capturePopout())
  router.register('e2e.capturePrimaryView', async params => {
    const contents = e2eHost.captureTarget(optionalStringParam(params, 'windowLabel') ?? 'main')
    if (!contents || contents.isDestroyed()) {
      throw new HostCapabilityError('e2e_view_unavailable', 'Primary DSH view is unavailable')
    }
    return captureWebContentsDataUrl(contents)
  })
  router.register('e2e.captureWorkspaceWindow', async params => {
    const requestedLabel = optionalStringParam(params, 'windowLabel')
    const label = requestedLabel ?? e2eHost.workspaceWindowSnapshots()[0]?.label
    if (!label) {
      throw new HostCapabilityError(
        'e2e_workspace_window_unavailable',
        'Workspace Window is unavailable'
      )
    }
    const contents = e2eHost.captureTarget(label)
    if (!contents || contents.isDestroyed()) {
      throw new HostCapabilityError(
        'e2e_workspace_view_unavailable',
        `Workspace DSH view is unavailable: ${label}`
      )
    }
    return captureWebContentsDataUrl(contents)
  })
  router.register('e2e.closeMainWindow', () => requiredWindow(window).close())
  router.register('e2e.focusMainWindow', () => {
    const target = requiredWindow(window)
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    const primaryContents = e2eHost.captureTarget('main')
    if (primaryContents && !primaryContents.isDestroyed()) primaryContents.focus()
  })
  router.register('e2e.focusWindow', params => {
    e2eHost.focusWindow(optionalStringParam(params, 'windowLabel') ?? 'main')
  })
  router.register('e2e.getProcessSnapshot', () => getElectronProcessSnapshot())
  router.register('e2e.getRuntimeDiagnostics', () => e2eHost.runtimeDiagnostics())
  router.register('e2e.getWindowFocusSnapshot', () => {
    const target = requiredWindow(window)
    const popout = e2eHost.popoutWindowSnapshot()
    return {
      mainFocused: target.isFocused(),
      popoutExists: popout.exists,
      popoutFocused: popout.focused,
      popoutVisible: popout.visible,
      workspaceWindows: e2eHost.workspaceWindowSnapshots(),
    }
  })
  router.register('e2e.setMainWindowSize', params => {
    const target = requiredWindow(window)
    const [width, height] = target.getContentSize()
    target.setContentSize(
      requiredIntegerParam(params, 'width'),
      requiredIntegerParam(params, 'height')
    )
    return { width, height }
  })
  router.register('e2e.verifyEmbeddedBrowserDetachedInspector', params =>
    browser.verifyDetachedInspector(optionalStringParam(params, 'label') ?? 'workspace-browser')
  )
  router.register('window.getState', () => {
    const target = requiredWindow(window)
    return {
      platform: process.platform,
      visible: target.isVisible(),
      minimized: target.isMinimized(),
      maximized: target.isMaximized(),
      fullScreen: target.isFullScreen(),
      focused: target.isFocused(),
      bounds: target.getBounds(),
      normalBounds: target.getNormalBounds(),
      dockVisible: e2eHost.dockVisible(),
    }
  })
  router.register('window.closeRequestState', params =>
    e2eHost.closeRequestState(integerParam(params, 'after') ?? 0)
  )
  router.register('window.closeToTray', () => e2eHost.closeToTray())
  router.register('window.cancelCloseToTray', () => e2eHost.cancelCloseToTray())
  router.register('tray.setState', params => e2eHost.traySetState(trayMenuStateParam(params)))
  router.register('tray.takePendingActions', () => e2eHost.takePendingTrayActions())
  router.register('e2e.getStartupSplashSnapshot', () => e2eHost.startupSplashSnapshot())
  router.register('e2e.getTraySnapshot', () => e2eHost.traySnapshot())
  router.register('e2e.hideMainWindow', () => e2eHost.hideMainWindow())
  router.register('e2e.activateTray', params => e2eHost.trayActivate(trayActivationParam(params)))
  router.register('window.openWorkspace', params =>
    e2eHost.openWorkspace({
      label: stringParam(params, 'label'),
      route: stringParam(params, 'route'),
      title: stringParam(params, 'title'),
    })
  )
  router.register('window.dismissPopout', () => e2eHost.dismissPopout())
  router.register('window.showPopout', () => e2eHost.showPopout())
  router.register('window.minimize', () => requiredWindow(window).minimize())
  router.register('window.toggleMaximize', () => {
    const target = requiredWindow(window)
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
  })
  router.register('window.close', () => requiredWindow(window).close())
  router.register('dialog.open', params =>
    dialog.showOpenDialog(requiredWindow(window), openDialogOptions(params))
  )
  router.register('dialog.save', params =>
    dialog.showSaveDialog(requiredWindow(window), saveDialogOptions(params))
  )
  router.register('dialog.message', params =>
    dialog.showMessageBox(requiredWindow(window), messageBoxOptions(params))
  )
  router.register('filesystem.stat', async params => {
    const path = stringParam(params, 'path')
    const metadata = await stat(path)
    return {
      path,
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      size: metadata.size,
    }
  })
  router.register('filesystem.inspectPaths', params =>
    inspectWorkspacePaths(stringArrayParam(params, 'paths') ?? [])
  )
  router.register('filesystem.readFileChunk', params =>
    readLocalFileChunk(
      stringParam(params, 'path'),
      requiredIntegerParam(params, 'offset'),
      requiredIntegerParam(params, 'length')
    )
  )
  router.register('notification.show', params => {
    if (!Notification.isSupported()) {
      throw new HostCapabilityError(
        'notification_unavailable',
        'Desktop notifications are unavailable'
      )
    }
    const title = stringParam(params, 'title')
    const body = stringParam(params, 'body')
    new Notification({ title, body }).show()
  })
  router.register('preferences.get', () => preferences.read())
  router.register('preferences.update', async params => {
    const patch = params.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      invalidParam('patch')
    }
    const updated = await preferences.update(patch as Record<string, unknown>)
    if (typeof updated.preventSleepWhileTasksRunning === 'boolean') {
      e2eHost.setSystemSleepEnabled(updated.preventSleepWhileTasksRunning)
    }
    return updated
  })
  router.register('rendererHealth.getState', () => rendererHealth())
  router.register('runtime.restartCoreDsh', () => {
    e2eHost.scheduleCoreDshRestart()
    return { scheduled: true }
  })
  router.register('shell.openExternal', async params => {
    const url = new URL(stringParam(params, 'url'))
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) {
      throw new HostCapabilityError(
        'invalid_external_url',
        `External URL protocol is not allowed: ${url.protocol}`
      )
    }
    await shell.openExternal(url.toString())
  })
  router.register('shell.openPath', async params => {
    const error = await shell.openPath(stringParam(params, 'path'))
    if (error) throw new HostCapabilityError('open_path_failed', error)
  })
  router.register('shell.showItemInFolder', params =>
    shell.showItemInFolder(stringParam(params, 'path'))
  )
  router.register('smartApps.list', () => requiredSmartApps(smartApps).list())
  router.register('smartApps.createDirectory', params =>
    requiredSmartApps(smartApps).createDirectory({
      parentPath: stringParam(params, 'parentPath'),
      name: stringParam(params, 'name'),
      displayName: stringParam(params, 'displayName'),
      description: stringParam(params, 'description'),
    })
  )
  router.register('smartApps.linkDirectory', params =>
    requiredSmartApps(smartApps).linkDirectory(stringParam(params, 'directoryPath'))
  )
  router.register('smartApps.addPlugin', params =>
    requiredSmartApps(smartApps).addPlugin(
      stringParam(params, 'installationId'),
      stringParam(params, 'pluginSpec')
    )
  )
  router.register('smartApps.copyToDirectory', params =>
    requiredSmartApps(smartApps).copyToDirectory(stringParam(params, 'installationId'), {
      parentPath: stringParam(params, 'parentPath'),
      name: stringParam(params, 'name'),
      displayName: stringParam(params, 'displayName'),
    })
  )
  router.register('smartApps.preview', params =>
    requiredSmartApps(smartApps).preview(stringParam(params, 'archivePath'))
  )
  router.register('smartApps.download', params =>
    requiredSmartApps(smartApps).download({
      downloadUrl: stringParam(params, 'downloadUrl'),
      sha256: stringParam(params, 'sha256'),
      sizeBytes: requiredIntegerParam(params, 'sizeBytes'),
      smartAppId: requiredIntegerParam(params, 'smartAppId'),
      releaseId: requiredIntegerParam(params, 'releaseId'),
    })
  )
  router.register('smartApps.install', params =>
    requiredSmartApps(smartApps).install({
      archivePath: stringParam(params, 'archivePath'),
      expectedSha256: stringParam(params, 'expectedSha256'),
      modelKey: nullableStringParam(params, 'modelKey'),
      smartAppId: nullableIntegerParam(params, 'smartAppId'),
      releaseId: nullableIntegerParam(params, 'releaseId'),
    })
  )
  router.register('smartApps.start', params =>
    requiredSmartApps(smartApps).start({
      installationId: stringParam(params, 'installationId'),
      modelBaseUrl: nullableStringParam(params, 'modelBaseUrl'),
      contextBaseUrl: nullableStringParam(params, 'contextBaseUrl'),
      contextToken: nullableStringParam(params, 'contextToken'),
    })
  )
  router.register('smartApps.stop', params =>
    requiredSmartApps(smartApps).stop(stringParam(params, 'installationId'))
  )
  router.register('smartApps.update', params =>
    requiredSmartApps(smartApps).update(stringParam(params, 'installationId'), {
      modelKey: optionalStringParam(params, 'modelKey'),
      resident: booleanParam(params, 'resident'),
    })
  )
  router.register('smartApps.delete', params =>
    requiredSmartApps(smartApps).delete(
      stringParam(params, 'installationId'),
      booleanParam(params, 'deleteData') ?? false
    )
  )
  router.register('smartApps.export', params =>
    requiredSmartApps(smartApps).export(stringParam(params, 'installationId'))
  )
  router.register('smartApps.exportToDownloads', params =>
    requiredSmartApps(smartApps).exportToDownloads(stringParam(params, 'installationId'))
  )
  router.register('smartApps.upload', params =>
    requiredSmartApps(smartApps).upload(
      stringParam(params, 'archivePath'),
      stringParam(params, 'uploadUrl')
    )
  )
  router.register('systemDrag.complete', params =>
    e2eHost.completeSystemDragDrop(systemDragPayload(params))
  )
  router.register('systemDrag.dismissPanel', () => e2eHost.dismissSystemDragPanel())
  router.register('systemDrag.getContext', () => e2eHost.getSystemDragContext())
  router.register('systemDrag.panelVisible', () => e2eHost.systemDragPanelVisible())
  router.register('systemDrag.setContext', params =>
    e2eHost.setSystemDragContext({
      conversationTitle: nullableStringParam(params, 'conversationTitle') ?? null,
    })
  )
  router.register('systemDrag.showPanel', () => e2eHost.showSystemDragPanel())
  router.register('systemDrag.takePending', () => e2eHost.takePendingSystemDrops())
  router.register('systemSleep.setTaskActivity', async params => {
    const preferencesSnapshot = await preferences.read()
    e2eHost.setSystemSleepEnabled(preferencesSnapshot.preventSleepWhileTasksRunning !== false)
    e2eHost.setSystemSleepTaskActive(
      stringParam(params, 'source'),
      booleanParam(params, 'active') ?? false
    )
  })
  router.register('smartApps.storeProxyToken', params =>
    requiredSmartApps(smartApps).storeProxyToken(
      stringParam(params, 'installationId'),
      stringParam(params, 'token')
    )
  )
  router.register('smartApps.takeProxyToken', params =>
    requiredSmartApps(smartApps).takeProxyToken(stringParam(params, 'installationId'))
  )
  router.register('smartApps.storeContextToken', params =>
    requiredSmartApps(smartApps).storeContextToken(
      stringParam(params, 'installationId'),
      stringParam(params, 'token')
    )
  )
  router.register('smartApps.takeContextToken', params =>
    requiredSmartApps(smartApps).takeContextToken(stringParam(params, 'installationId'))
  )
  router.register('workbench.activate', params => {
    const installationId = nullableStringParam(params, 'installationId') ?? null
    requiredSmartApps(smartApps).activate(installationId)
  })
  return router
}

export function registerDesktopServiceCapabilities(
  router: HostCapabilityRouter,
  services: ElectronDesktopServices,
  developer: {
    openLogDirectory: () => void | Promise<void>
    openDevTools: () => void | Promise<void>
  }
): void {
  router.register('developer.openLogDirectory', () => developer.openLogDirectory())
  router.register('developer.openDevTools', () => developer.openDevTools())
  router.register('feedback.previewBundle', params =>
    services.feedback.preview(feedbackRequestParam(params))
  )
  router.register('feedback.confirmBundle', params =>
    services.feedback.confirm(feedbackDecisionParam(params))
  )
  router.register('feedback.discardBundle', params =>
    services.feedback.discard(feedbackDecisionParam(params))
  )
  router.register('plugins.list', () => services.plugins.list())
  router.register('plugins.authorizeCapability', params =>
    services.plugins.authorizeCapability(
      stringParam(params, 'pluginRoot'),
      stringParam(params, 'capability')
    )
  )
  router.register('plugins.start', params =>
    services.plugins.start(stringParam(params, 'pluginId'), stringParam(params, 'pluginRoot'))
  )
  router.register('plugins.stop', params => services.plugins.stop(stringParam(params, 'pluginId')))
  router.register('plugins.request', params =>
    services.plugins.request(
      stringParam(params, 'pluginId'),
      stringParam(params, 'capability'),
      stringParam(params, 'method'),
      params.params ?? {}
    )
  )
}

async function mkdirDirectory(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}

function feedbackRequestParam(params: Record<string, unknown>): FeedbackExportRequest {
  const request = recordParam(params, 'request')
  const attachments = request.attachments
  if (!Array.isArray(attachments)) invalidParam('request.attachments')
  return {
    includeRuntimeLogs: requiredBooleanValue(
      request.includeRuntimeLogs,
      'request.includeRuntimeLogs'
    ),
    includeTaskInfo: requiredBooleanValue(request.includeTaskInfo, 'request.includeTaskInfo'),
    includeScreenshot: requiredBooleanValue(request.includeScreenshot, 'request.includeScreenshot'),
    includeSystemInfo: requiredBooleanValue(request.includeSystemInfo, 'request.includeSystemInfo'),
    note: typeof request.note === 'string' ? request.note : invalidParam('request.note'),
    taskContext: request.taskContext ?? null,
    screenshotDataUrl: nullableStringValue(request.screenshotDataUrl, 'request.screenshotDataUrl'),
    composerDiagnostics: request.composerDiagnostics ?? null,
    attachments: attachments.map((attachment, index) => {
      const record = objectValue(attachment, `request.attachments[${index}]`)
      return {
        name: requiredStringValue(record.name, `request.attachments[${index}].name`),
        mimeType: requiredStringValue(record.mimeType, `request.attachments[${index}].mimeType`),
        dataBase64: requiredStringValue(
          record.dataBase64,
          `request.attachments[${index}].dataBase64`
        ),
      }
    }),
  }
}

function feedbackDecisionParam(params: Record<string, unknown>): string {
  return requiredStringValue(recordParam(params, 'decision').stagingId, 'decision.stagingId')
}

function recordParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  return objectValue(params[key], key)
}

function objectValue(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidParam(key)
  return value as Record<string, unknown>
}

function requiredStringValue(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) invalidParam(key)
  return value.trim()
}

function nullableStringValue(value: unknown, key: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string') invalidParam(key)
  return value
}

function requiredBooleanValue(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') invalidParam(key)
  return value
}

export function registerBrowserHistoryCapabilities(
  router: HostCapabilityRouter,
  browser: EmbeddedBrowserManager
): void {
  router.register('browser.historySearch', params =>
    browser.searchHistory({
      text: optionalStringParam(params, 'text') ?? '',
      endTimeMs: nullableIntegerParam(params, 'endTimeMs') ?? null,
      offset: integerParam(params, 'offset') ?? 0,
      maxResults: integerParam(params, 'maxResults') ?? 100,
    })
  )
  router.register('browser.historyRemove', params =>
    browser.removeHistory(stringArrayParam(params, 'ids') ?? [])
  )
}

function localAttachmentRoot(): string {
  const executorHome = process.env.WEGENT_EXECUTOR_HOME?.trim()
  return join(
    executorHome || join(app.getPath('home'), '.wework'),
    'workspace',
    'attachments',
    'draft'
  )
}

function isWorkbenchTabLabel(label: string): boolean {
  return label.startsWith('smart-app:')
}

function requiredSmartApps(resolveSmartApps: () => SmartAppManager | null): SmartAppManager {
  const smartApps = resolveSmartApps()
  if (!smartApps) {
    throw new HostCapabilityError('smart_apps_unavailable', 'Smart app manager is unavailable')
  }
  return smartApps
}

function requiredWindow(resolveWindow: () => BrowserWindow | null): BrowserWindow {
  const target = resolveWindow()
  if (!target || target.isDestroyed()) {
    throw new HostCapabilityError('window_unavailable', 'Desktop window is unavailable')
  }
  return target
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new HostCapabilityError('invalid_params', `${key} is required`)
  }
  return value.trim()
}

function messageBoxOptions(params: Record<string, unknown>): MessageBoxOptions {
  return compact({
    message: stringParam(params, 'message'),
    type: enumParam(params, 'type', ['none', 'info', 'error', 'question', 'warning']),
    buttons: stringArrayParam(params, 'buttons'),
    defaultId: integerParam(params, 'defaultId'),
    title: optionalStringParam(params, 'title'),
    detail: optionalStringParam(params, 'detail'),
    checkboxLabel: optionalStringParam(params, 'checkboxLabel'),
    checkboxChecked: booleanParam(params, 'checkboxChecked'),
    textWidth: integerParam(params, 'textWidth'),
    cancelId: integerParam(params, 'cancelId'),
    noLink: booleanParam(params, 'noLink'),
    normalizeAccessKeys: booleanParam(params, 'normalizeAccessKeys'),
  })
}

function openDialogOptions(params: Record<string, unknown>): OpenDialogOptions {
  return compact({
    title: optionalStringParam(params, 'title'),
    defaultPath: optionalStringParam(params, 'defaultPath'),
    buttonLabel: optionalStringParam(params, 'buttonLabel'),
    filters: fileFiltersParam(params),
    properties: enumArrayParam(params, 'properties', [
      'openFile',
      'openDirectory',
      'multiSelections',
      'showHiddenFiles',
      'createDirectory',
      'promptToCreate',
      'noResolveAliases',
      'treatPackageAsDirectory',
      'dontAddToRecent',
    ]),
    message: optionalStringParam(params, 'message'),
    securityScopedBookmarks: booleanParam(params, 'securityScopedBookmarks'),
  })
}

function saveDialogOptions(params: Record<string, unknown>): SaveDialogOptions {
  return compact({
    title: optionalStringParam(params, 'title'),
    defaultPath: optionalStringParam(params, 'defaultPath'),
    buttonLabel: optionalStringParam(params, 'buttonLabel'),
    filters: fileFiltersParam(params),
    message: optionalStringParam(params, 'message'),
    nameFieldLabel: optionalStringParam(params, 'nameFieldLabel'),
    showsTagField: booleanParam(params, 'showsTagField'),
    properties: enumArrayParam(params, 'properties', [
      'showHiddenFiles',
      'createDirectory',
      'treatPackageAsDirectory',
      'showOverwriteConfirmation',
      'dontAddToRecent',
    ]),
    securityScopedBookmarks: booleanParam(params, 'securityScopedBookmarks'),
  })
}

function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalidParam(key)
  return value
}

function nullableStringParam(
  params: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (params[key] === null) return null
  return optionalStringParam(params, key)
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    invalidParam(key)
  }
  return [...value] as string[]
}

function nullableStringArrayParam(
  params: Record<string, unknown>,
  key: string
): string[] | null | undefined {
  if (params[key] === null) return null
  return stringArrayParam(params, key)
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalidParam(key)
  return value
}

function integerParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidParam(key)
  return value as number
}

function numberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidParam(key)
  return value
}

function nullableNumberParam(
  params: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (params[key] === null) return null
  if (params[key] === undefined) return undefined
  return numberParam(params, key)
}

function browserBoundsParam(params: Record<string, unknown>): BrowserBounds {
  const bounds = params.bounds
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
    invalidParam('bounds')
  }
  const record = bounds as Record<string, unknown>
  return {
    x: numberParam(record, 'x'),
    y: numberParam(record, 'y'),
    width: numberParam(record, 'width'),
    height: numberParam(record, 'height'),
  }
}

function systemDragPayload(params: Record<string, unknown>): {
  action: 'new-chat' | 'follow-up' | 'stash'
  text: string | null
  paths: string[]
} {
  const payload = params.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalidParam('payload')
  const record = payload as Record<string, unknown>
  const action = enumParam(record, 'action', ['new-chat', 'follow-up', 'stash'])
  if (!action) invalidParam('payload.action')
  const text = nullableStringParam(record, 'text') ?? null
  const paths = stringArrayParam(record, 'paths') ?? []
  if (!text?.trim() && paths.length === 0) invalidParam('payload')
  return { action, text, paths }
}

function trayMenuStateParam(params: Record<string, unknown>): TrayMenuState {
  const state = objectParam(params, 'state')
  return {
    language: stringParam(state, 'language'),
    usageTitle: nullableStringParam(state, 'usageTitle') ?? null,
    usageTooltip: nullableStringParam(state, 'usageTooltip') ?? null,
    running: trayTaskItemsParam(state, 'running'),
    runningMore: trayTaskItemsParam(state, 'runningMore'),
    unread: trayTaskItemsParam(state, 'unread'),
    unreadMore: trayTaskItemsParam(state, 'unreadMore'),
    pinned: trayTaskItemsParam(state, 'pinned'),
    pinnedMore: trayTaskItemsParam(state, 'pinnedMore'),
    recent: trayTaskItemsParam(state, 'recent'),
    recentMore: trayTaskItemsParam(state, 'recentMore'),
    hasRunningTasks: requiredBooleanParam(state, 'hasRunningTasks'),
    showRunningStatus: requiredBooleanParam(state, 'showRunningStatus'),
    runningCount: requiredIntegerParam(state, 'runningCount'),
    activeTaskIds: nullableStringArrayParam(state, 'activeTaskIds') ?? null,
    unreadCount: requiredIntegerParam(state, 'unreadCount'),
  }
}

function trayTaskItemsParam(
  params: Record<string, unknown>,
  key: string
): TrayMenuState['running'] {
  const value = params[key]
  if (!Array.isArray(value)) invalidParam(key)
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      invalidParam(`${key}[${index}]`)
    }
    const record = item as Record<string, unknown>
    return {
      id: stringParam(record, 'id'),
      title: optionalStringParam(record, 'title') ?? '',
      projectName: optionalStringParam(record, 'projectName') ?? '',
    }
  })
}

function trayActivationParam(params: Record<string, unknown>): TrayActivation {
  const activation = objectParam(params, 'activation')
  const type = enumParam(activation, 'type', ['click', 'double-click', 'menu-item'])
  if (type === 'click' || type === 'double-click') return { type }
  if (type === 'menu-item') {
    return { type, menuItemId: stringParam(activation, 'menuItemId') }
  }
  invalidParam('activation.type')
}

function objectParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidParam(key)
  return value as Record<string, unknown>
}

function requiredIntegerParam(params: Record<string, unknown>, key: string): number {
  const value = integerParam(params, key)
  if (value === undefined) invalidParam(key)
  return value
}

function requiredBooleanParam(params: Record<string, unknown>, key: string): boolean {
  const value = booleanParam(params, key)
  if (value === undefined) invalidParam(key)
  return value
}

function nullableIntegerParam(
  params: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (params[key] === null) return null
  return integerParam(params, key)
}

function enumParam<const Value extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly Value[]
): Value | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    invalidParam(key)
  }
  return value as Value
}

function enumArrayParam<const Value extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly Value[]
): Value[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.some(item => typeof item !== 'string' || !allowed.includes(item as Value))
  ) {
    invalidParam(key)
  }
  return [...value] as Value[]
}

function fileFiltersParam(params: Record<string, unknown>): FileFilter[] | undefined {
  const value = params.filters
  if (value === undefined) return undefined
  if (!Array.isArray(value)) invalidParam('filters')
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      invalidParam(`filters[${index}]`)
    }
    const filter = item as Record<string, unknown>
    const name = optionalStringParam(filter, 'name')
    const extensions = stringArrayParam(filter, 'extensions')
    if (name === undefined || extensions === undefined) {
      invalidParam(`filters[${index}]`)
    }
    return { name, extensions }
  })
}

function compact<Value extends object>(value: Value): Value {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Value
}

function invalidParam(key: string): never {
  throw new HostCapabilityError('invalid_params', `${key} is invalid`)
}
