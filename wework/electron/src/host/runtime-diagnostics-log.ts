import { RotatingLog } from '../runtime/rotating-log.js'

const PREFIX = '[Wework] Runtime task create diagnostic '

export class RuntimeDiagnosticsLog {
  private readonly log: RotatingLog

  constructor(
    path: string,
    private readonly prefix = PREFIX
  ) {
    this.log = new RotatingLog({ path, maxEntryBytes: 8192 })
  }

  async record(contentsId: number, message: string): Promise<void> {
    if (!message.startsWith(this.prefix)) return
    await this.log.write('stdout', `web_contents_id=${contentsId} ${message}`)
  }

  flush(): Promise<void> {
    return this.log.flush()
  }
}
