import { RotatingLog } from '../runtime/rotating-log.js'

const PREFIX = '[Wework] Runtime task create diagnostic '

export class RuntimeDiagnosticsLog {
  private readonly log: RotatingLog

  constructor(path: string) {
    this.log = new RotatingLog({ path, maxEntryBytes: 8192 })
  }

  async record(contentsId: number, message: string, sourceId = ''): Promise<void> {
    if (message.startsWith(PREFIX)) {
      await this.log.write('stdout', `web_contents_id=${contentsId} ${message}`)
      return
    }
    const failure = message.match(
      /Failed to (?:load module script|fetch dynamically imported module)|Importing a module script failed|Expected a JavaScript(?:-or-Wasm)? module script/
    )?.[0]
    if (!failure) return
    const sources = [
      sourceId,
      ...[...message.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(([value]) => value),
    ]
    const paths = sources.flatMap(value => {
      try {
        return [new URL(value).pathname]
      } catch {
        return []
      }
    })
    await this.log.write(
      'stderr',
      `web_contents_id=${contentsId} ${JSON.stringify({ failure, paths: [...new Set(paths)] })}`
    )
  }
}
