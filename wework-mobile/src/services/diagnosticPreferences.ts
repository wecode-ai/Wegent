import { beginMobileDiagnostic, setDiagnosticRecording } from './mobileDiagnostics'

interface DiagnosticsStorage {
  read(): Promise<boolean>
  write(enabled: boolean): Promise<void>
}
interface NativeDiagnostics {
  getDiagnosticsEnabledAsync(): Promise<boolean>
  setDiagnosticsEnabledAsync(enabled: boolean): Promise<void>
}
interface DiagnosticsPreferenceState {
  enabled: boolean
  ready: boolean
  changing: boolean
  error: unknown
}

/** Like PC preference effects, serialize changes and publish only after persistence succeeds. */
export class DiagnosticsPreferences {
  private state: DiagnosticsPreferenceState = {
    enabled: false,
    ready: false,
    changing: false,
    error: null,
  }
  private listeners = new Set<() => void>()
  private storage?: DiagnosticsStorage
  private loading?: Promise<void>
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly open: () => Promise<DiagnosticsStorage>) {}

  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  load = (): Promise<void> => {
    if (this.loading) return this.loading
    this.loading = (async () => {
      const diagnostic = beginMobileDiagnostic('diagnostic-preference')
      try {
        diagnostic.step('open-preference-storage')
        this.storage = await this.open()
        diagnostic.step('read-diagnostic-preference')
        const enabled = await this.storage.read()
        setDiagnosticRecording(enabled)
        this.publish({ enabled, ready: true, error: null })
        diagnostic.complete()
      } catch (error) {
        diagnostic.fail(error)
        this.publish({ ready: true, error })
      }
    })()
    return this.loading
  }

  retry = async (): Promise<void> => {
    await this.operation
    this.loading = undefined
    await this.load()
  }

  change = (enabled: boolean): Promise<void> => {
    const result = this.operation.then(async () => {
      await this.load()
      if (this.state.error) throw this.state.error
      this.publish({ changing: true })
      try {
        await this.storage!.write(enabled)
        setDiagnosticRecording(enabled)
        this.publish({ enabled })
      } finally {
        this.publish({ changing: false })
      }
    })
    this.operation = result.catch(() => undefined)
    return result
  }

  private publish(patch: Partial<DiagnosticsPreferenceState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
}

async function openDiagnosticsStorage(): Promise<DiagnosticsStorage> {
  const { requireOptionalNativeModule } = await import('expo')
  const native = requireOptionalNativeModule<NativeDiagnostics>('WeworkLocalRuntime')
  if (native)
    return {
      read: () => native.getDiagnosticsEnabledAsync(),
      write: enabled => native.setDiagnosticsEnabledAsync(enabled),
    }
  const storage = await import('expo-secure-store')
  const key = 'wework.mobile.diagnostics-enabled.v1'
  return {
    read: async () => parseDiagnosticPreference(await storage.getItemAsync(key)),
    write: enabled => storage.setItemAsync(key, String(enabled)),
  }
}

export function parseDiagnosticPreference(value: string | null): boolean {
  if (value === null || value === 'false') return false
  if (value === 'true') return true
  throw new Error('Invalid diagnostic preference')
}

export const diagnosticPreferences = new DiagnosticsPreferences(openDiagnosticsStorage)
