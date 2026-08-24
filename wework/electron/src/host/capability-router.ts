export const HOST_PROTOCOL_VERSION = 1

export const HOST_CAPABILITIES = [
  'app.getVersion',
  'attachment.abort',
  'attachment.append',
  'attachment.begin',
  'attachment.finish',
  'browser.capture',
  'browser.clearData',
  'browser.close',
  'browser.closeMany',
  'browser.deleteDownload',
  'browser.events',
  'browser.evaluate',
  'browser.goBack',
  'browser.goForward',
  'browser.navigate',
  'browser.open',
  'browser.pageState',
  'browser.pauseDownload',
  'browser.relabel',
  'browser.reload',
  'browser.resolveAgentApproval',
  'browser.resumeDownload',
  'browser.setActiveTab',
  'browser.setAgentControlPaused',
  'browser.setBounds',
  'browser.setDeviceMetrics',
  'browser.setZoom',
  'clipboard.readWorkspacePaths',
  'clipboard.writeText',
  'dialog.message',
  'dialog.open',
  'dialog.save',
  'e2e.capturePopoutWindow',
  'e2e.capturePrimaryView',
  'e2e.captureWorkspaceWindow',
  'e2e.closeMainWindow',
  'e2e.focusMainWindow',
  'e2e.focusWindow',
  'e2e.getProcessSnapshot',
  'e2e.getRuntimeDiagnostics',
  'e2e.getWindowFocusSnapshot',
  'e2e.setMainWindowSize',
  'e2e.verifyEmbeddedBrowserDetachedInspector',
  'filesystem.inspectPaths',
  'filesystem.readFileChunk',
  'filesystem.stat',
  'notification.show',
  'preferences.get',
  'preferences.update',
  'rendererHealth.getState',
  'runtime.restartCoreDsh',
  'shell.openExternal',
  'shell.openPath',
  'shell.showItemInFolder',
  'smartApps.delete',
  'smartApps.download',
  'smartApps.export',
  'smartApps.exportToDownloads',
  'smartApps.install',
  'smartApps.list',
  'smartApps.preview',
  'smartApps.start',
  'smartApps.stop',
  'smartApps.storeContextToken',
  'smartApps.storeProxyToken',
  'smartApps.takeContextToken',
  'smartApps.takeProxyToken',
  'smartApps.update',
  'smartApps.upload',
  'systemDrag.complete',
  'systemDrag.dismissPanel',
  'systemDrag.getContext',
  'systemDrag.panelVisible',
  'systemDrag.setContext',
  'systemDrag.showPanel',
  'systemDrag.takePending',
  'systemSleep.setTaskActivity',
  'workbench.activate',
  'window.close',
  'window.closeRequestState',
  'window.closeToTray',
  'window.dismissPopout',
  'window.getState',
  'window.minimize',
  'window.openWorkspace',
  'window.showPopout',
  'window.toggleMaximize',
] as const

export type HostCapability = (typeof HOST_CAPABILITIES)[number]

export interface HostInvocationContext {
  principal: string
}

export type HostCapabilityHandler = (
  params: Record<string, unknown>,
  context: HostInvocationContext
) => unknown | Promise<unknown>

export class HostCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'HostCapabilityError'
  }
}

export class HostCapabilityRouter {
  private readonly handlers = new Map<HostCapability, HostCapabilityHandler>()
  private readonly grants = new Map<string, ReadonlySet<HostCapability>>()

  register(capability: HostCapability, handler: HostCapabilityHandler): void {
    if (this.handlers.has(capability)) {
      throw new Error(`Host capability already registered: ${capability}`)
    }
    this.handlers.set(capability, handler)
  }

  grant(principal: string, capabilities: readonly HostCapability[]): void {
    this.grants.set(principal, new Set(capabilities))
  }

  describe(principal: string): HostCapability[] {
    return [...(this.grants.get(principal) ?? [])]
  }

  async invoke(
    principal: string,
    capability: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (!isHostCapability(capability)) {
      throw new HostCapabilityError(
        'unknown_capability',
        `Unknown desktop capability: ${capability}`
      )
    }
    if (!this.grants.get(principal)?.has(capability)) {
      throw new HostCapabilityError(
        'capability_denied',
        `Principal ${principal} is not authorized for ${capability}`,
        { principal, capability }
      )
    }
    const handler = this.handlers.get(capability)
    if (!handler) {
      throw new HostCapabilityError(
        'capability_unavailable',
        `Desktop capability is unavailable: ${capability}`
      )
    }
    return handler(params, { principal })
  }
}

function isHostCapability(value: string): value is HostCapability {
  return (HOST_CAPABILITIES as readonly string[]).includes(value)
}
