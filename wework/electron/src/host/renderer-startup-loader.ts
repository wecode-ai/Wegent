interface ResourceFailure {
  webContentsId?: number
  url: string
  resourceType: string
  error: string
}

interface StartupLoad {
  webContentsId: number
  url: string
  load: () => Promise<void>
  onRecovery: () => void
}

/** Keep a failed entry module from being mistaken for a loaded workbench. */
export class RendererStartupLoader {
  private active: { webContentsId: number; origin: string; networkChanged: boolean } | null = null

  requestFailed(details: ResourceFailure): void {
    const active = this.active
    if (
      !active ||
      details.webContentsId !== active.webContentsId ||
      details.error !== 'net::ERR_NETWORK_CHANGED' ||
      !['mainFrame', 'script', 'stylesheet'].includes(details.resourceType) ||
      !URL.canParse(details.url) ||
      new URL(details.url).origin !== active.origin
    )
      return
    active.networkChanged = true
  }

  async load(options: StartupLoad): Promise<void> {
    const active = {
      webContentsId: options.webContentsId,
      origin: new URL(options.url).origin,
      networkChanged: false,
    }
    this.active = active
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        active.networkChanged = false
        try {
          await options.load()
        } catch (error) {
          if (!active.networkChanged) throw error
        }
        if (!active.networkChanged) return
        if (attempt === 1)
          throw new Error('Renderer startup was interrupted by repeated network changes')
        options.onRecovery()
      }
    } finally {
      this.active = null
    }
  }
}
