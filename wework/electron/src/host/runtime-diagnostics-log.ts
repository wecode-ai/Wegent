import { RotatingLog } from '../runtime/rotating-log.js'

const PREFIX = '[Wework] Runtime task create diagnostic '
const STARTUP_PREFIX = '[startup][renderer-phase] '
const STARTUP_FIELDS = new Set([
  'phase',
  'status',
  'navigationTimeMs',
  'durationMs',
  'modulePath',
  'authLoading',
  'preferencesLoaded',
])
const STREAM_PREFIXES = [
  '[Wework] Runtime chat stream terminal event received ',
  '[Wework] Runtime chat stream native event ',
  '[Wework] Runtime chat stream native subscription ',
  '[Wework] Runtime chat stream event ',
  '[Wework] Runtime chat stream subscription ',
]
const STREAM_FIELDS = new Set([
  'action',
  'sequence',
  'event',
  'taskId',
  'subtaskId',
  'deviceId',
  'blockId',
  'scopeTaskId',
  'scopeDeviceId',
  'subscriptionId',
  'subscriptionCount',
  'matchedSubscriptionCount',
  'matchingSubscriptionIds',
  'activeSubscriptions',
  'eventCount',
  'textDeltaCount',
  'mapped',
  'deltaLength',
  'offset',
  'contentDeltaLength',
  'contentDeltaFingerprint',
])

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
    const streamMessage = safeStreamDiagnostic(message)
    if (streamMessage) {
      await this.log.write('stdout', `web_contents_id=${contentsId} ${streamMessage}`)
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

function safeStreamDiagnostic(message: string): string | null {
  const startup = message.startsWith(STARTUP_PREFIX)
  const prefix = startup ? STARTUP_PREFIX : STREAM_PREFIXES.find(value => message.startsWith(value))
  if (!prefix) return null
  const allowedFields = startup ? STARTUP_FIELDS : STREAM_FIELDS
  try {
    const details: unknown = JSON.parse(message.slice(prefix.length))
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null
    const fields = Object.entries(details).filter(
      ([key, value]) =>
        allowedFields.has(key) &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null ||
          (!startup &&
            key === 'matchingSubscriptionIds' &&
            Array.isArray(value) &&
            value.every(id => typeof id === 'number')))
    )
    return `${prefix}${JSON.stringify(Object.fromEntries(fields))}`
  } catch {
    return null
  }
}
