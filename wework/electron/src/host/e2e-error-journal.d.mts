export class E2EErrorLog {
  constructor(path?: string, reportFailure?: (message: string) => void)
  record(
    source: string,
    type: string,
    level: 'error' | 'warning' | 'info',
    details: Record<string, unknown>
  ): void
  checkpoint(): {
    enabled: boolean
    instanceId: string
    sequence: number
    failedWrites: number
    byteLength: number
  }
}
