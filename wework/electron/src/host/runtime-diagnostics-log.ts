import { RotatingLog } from '../runtime/rotating-log.js'

const PREFIX = '[Wework] Runtime task create diagnostic '

export const CONVERSATION_ROW_DIAGNOSTICS_LOG_NAME = 'conversation-row-measurement.log'

export class RuntimeDiagnosticsLog {
  private readonly log: RotatingLog
  private closed = false

  constructor(
    path: string,
    private readonly prefix = PREFIX
  ) {
    this.log = new RotatingLog({ path, maxEntryBytes: 8192 })
  }

  async record(contentsId: number, message: string): Promise<void> {
    if (this.closed || !message.startsWith(this.prefix)) return
    await this.log.write('stdout', `web_contents_id=${contentsId} ${message}`)
  }

  flush(): Promise<void> {
    return this.log.flush()
  }

  close(): Promise<void> {
    this.closed = true
    return this.flush()
  }
}
