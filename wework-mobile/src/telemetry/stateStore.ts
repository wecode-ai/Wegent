import {
  parseMobileTelemetryState,
  serializeMobileTelemetryState,
  type MobileTelemetryState,
  type MobileTelemetryStateStorage,
} from './state'

export class MobileTelemetryStateStore {
  private state: MobileTelemetryState | null = null
  private loading: Promise<MobileTelemetryState> | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly storage: MobileTelemetryStateStorage) {}

  load(): Promise<MobileTelemetryState> {
    const loading = (this.loading ??= (async () => {
      const raw = await this.storage.read()
      try {
        this.state = parseMobileTelemetryState(raw)
      } catch (error) {
        if (!this.storage.quarantine) throw error
        await this.storage.quarantine()
        this.state = parseMobileTelemetryState(null)
      }
      return this.state
    })())
    return loading.catch(error => {
      if (this.loading === loading) this.loading = null
      throw error
    })
  }

  update<Result>(
    transition: (state: MobileTelemetryState) => {
      state: MobileTelemetryState
      result: Result
    }
  ): Promise<Result> {
    const operation = this.queue.then(async () => {
      const current = this.state ?? (await this.load())
      const next = transition(current)
      await this.storage.write(serializeMobileTelemetryState(next.state))
      this.state = next.state
      return next.result
    })
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
