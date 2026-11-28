import type { PreferencesStore } from './preferences-store.js'

interface DesktopPreferenceEffects {
  isShuttingDown: () => boolean
  configurePopoutShortcut: (shortcut: string | null) => void
  configureAppshotsShortcut: (shortcut: string | null) => void
  setPerformanceRecordingEnabled: (enabled: boolean) => Promise<void>
}

function resolveShortcut(
  preferences: Record<string, unknown>,
  key: string,
  fallback: string
): string | null {
  if (!Object.prototype.hasOwnProperty.call(preferences, key)) return fallback
  const value = preferences[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function resolvePopoutShortcut(preferences: Record<string, unknown>): string | null {
  return resolveShortcut(preferences, 'popoutWindowShortcut', 'Alt+Shift+Space')
}

export function resolveAppshotsShortcut(preferences: Record<string, unknown>): string | null {
  return resolveShortcut(preferences, 'appshotsShortcut', 'CommandOrControl+Shift+2')
}

/** Serializes preference persistence with the host resources those values control. */
export class DesktopPreferencesController {
  private operation = Promise.resolve()

  constructor(
    private readonly store: Pick<PreferencesStore, 'read' | 'readSnapshot' | 'update'>,
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

  update(
    patch: Record<string, unknown>,
    expectedTelemetryConsentRevision?: number
  ): Promise<Record<string, unknown>> {
    const result = this.operation.then(() => this.apply(patch, expectedTelemetryConsentRevision))
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async apply(
    patch: Record<string, unknown>,
    expectedTelemetryConsentRevision?: number
  ): Promise<Record<string, unknown>> {
    const changesPopoutShortcut = Object.hasOwn(patch, 'popoutWindowShortcut')
    const changesAppshotsShortcut = Object.hasOwn(patch, 'appshotsShortcut')
    const changesRecording = Object.hasOwn(patch, 'performanceRecordingEnabled')
    if (changesRecording && typeof patch.performanceRecordingEnabled !== 'boolean') {
      throw new Error('performanceRecordingEnabled must be a boolean')
    }
    if (
      Object.hasOwn(patch, 'browserFullControl') &&
      typeof patch.browserFullControl !== 'boolean'
    ) {
      throw new Error('browserFullControl must be a boolean')
    }
    if (!changesPopoutShortcut && !changesAppshotsShortcut && !changesRecording)
      return this.store.update(patch, expectedTelemetryConsentRevision)

    const snapshot = await this.store.readSnapshot()
    if (!snapshot.readable)
      throw new Error('Cannot change desktop effects while settings are unreadable')
    const previous = snapshot.preferences
    try {
      if (changesPopoutShortcut) {
        this.effects.configurePopoutShortcut(resolvePopoutShortcut(patch))
      }
      if (changesAppshotsShortcut) {
        this.effects.configureAppshotsShortcut(resolveAppshotsShortcut(patch))
      }
      if (changesRecording) {
        await this.effects.setPerformanceRecordingEnabled(
          patch.performanceRecordingEnabled === true
        )
      }
      return await this.store.update(patch, expectedTelemetryConsentRevision)
    } catch (error) {
      try {
        if (changesPopoutShortcut) {
          this.effects.configurePopoutShortcut(resolvePopoutShortcut(previous))
        }
        if (changesAppshotsShortcut) {
          this.effects.configureAppshotsShortcut(resolveAppshotsShortcut(previous))
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
