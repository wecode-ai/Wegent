import type { PreferencesStore } from './preferences-store.js'

interface DesktopPreferenceEffects {
  isShuttingDown: () => boolean
  configurePopoutShortcut: (shortcut: string | null) => void
  setPerformanceRecordingEnabled: (enabled: boolean) => Promise<void>
}

export function resolvePopoutShortcut(preferences: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(preferences, 'popoutWindowShortcut')) {
    return 'Alt+Shift+Space'
  }
  const value = preferences.popoutWindowShortcut
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Serializes preference persistence with the host resources those values control. */
export class DesktopPreferencesController {
  private operation = Promise.resolve()

  constructor(
    private readonly store: Pick<PreferencesStore, 'read' | 'update'>,
    private readonly effects: DesktopPreferenceEffects
  ) {}

  async restorePerformanceRecording(): Promise<void> {
    if (this.effects.isShuttingDown()) return
    const preferences = await this.store.read()
    if (this.effects.isShuttingDown() || preferences.performanceRecordingEnabled !== true) return
    try {
      await this.effects.setPerformanceRecordingEnabled(true)
    } catch (error) {
      if (this.effects.isShuttingDown()) return
      await this.store.update({ performanceRecordingEnabled: false })
      throw error
    }
  }

  update(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = this.operation.then(() => this.apply(patch))
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async apply(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const changesShortcut = Object.hasOwn(patch, 'popoutWindowShortcut')
    const changesRecording = Object.hasOwn(patch, 'performanceRecordingEnabled')
    if (changesRecording && typeof patch.performanceRecordingEnabled !== 'boolean') {
      throw new Error('performanceRecordingEnabled must be a boolean')
    }
    if (!changesShortcut && !changesRecording) return this.store.update(patch)

    const previous = await this.store.read()
    try {
      if (changesShortcut) {
        this.effects.configurePopoutShortcut(resolvePopoutShortcut(patch))
      }
      if (changesRecording) {
        await this.effects.setPerformanceRecordingEnabled(
          patch.performanceRecordingEnabled === true
        )
      }
      return await this.store.update(patch)
    } catch (error) {
      try {
        if (changesShortcut) {
          this.effects.configurePopoutShortcut(resolvePopoutShortcut(previous))
        }
        if (changesRecording) {
          await this.effects.setPerformanceRecordingEnabled(
            previous.performanceRecordingEnabled === true
          )
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Failed to restore desktop preferences', {
          cause: rollbackError,
        })
      }
      throw error
    }
  }
}
