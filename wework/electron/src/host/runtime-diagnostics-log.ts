import { RotatingLog } from '../runtime/rotating-log.js'

const PREFIXES = [
  '[Wework] Runtime task create diagnostic ',
  '[Wework] Project create resources diagnostic ',
]

export class RuntimeDiagnosticsLog {
  private readonly log: RotatingLog

  constructor(
    path: string,
    private readonly prefix: string | readonly string[] = PREFIXES
  ) {
    this.log = new RotatingLog({ path, maxEntryBytes: 8192 })
  }

  async record(contentsId: number, message: string): Promise<void> {
    const prefixes = typeof this.prefix === 'string' ? [this.prefix] : this.prefix
    if (!prefixes.some(prefix => message.startsWith(prefix))) return
    await this.log.write('stdout', `web_contents_id=${contentsId} ${message}`)
  }

  flush(): Promise<void> {
    return this.log.flush()
  }
}
