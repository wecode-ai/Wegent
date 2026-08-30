export interface GlobalShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export class GlobalShortcutController {
  private registeredShortcut: string | null = null

  constructor(
    private readonly registry: GlobalShortcutRegistry,
    private readonly action: () => void | Promise<void>,
    private readonly reportError: (error: unknown) => void
  ) {}

  configure(shortcut: string | null): void {
    const nextShortcut = shortcut?.trim() || null
    if (nextShortcut === this.registeredShortcut) return

    if (nextShortcut) {
      const registered = this.registry.register(nextShortcut, () => {
        void Promise.resolve(this.action()).catch(this.reportError)
      })
      if (!registered) {
        throw new Error(`Global shortcut is unavailable: ${nextShortcut}`)
      }
    }

    if (this.registeredShortcut) {
      this.registry.unregister(this.registeredShortcut)
    }
    this.registeredShortcut = nextShortcut
  }

  dispose(): void {
    if (!this.registeredShortcut) return
    this.registry.unregister(this.registeredShortcut)
    this.registeredShortcut = null
  }
}
