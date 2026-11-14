import { redactLog } from '../runtime/rotating-log.js'

export function rendererConsoleDiagnostic(input: {
  e2e: boolean
  level: number
  message: string
  sourceId: string
}) {
  if (!input.e2e || (input.level !== 2 && input.level !== 3)) return null
  return {
    type: input.level === 3 ? 'renderer-error' : 'renderer-warning',
    data: {
      message: redactLog(input.message).slice(0, 4096),
      sourcePath: URL.canParse(input.sourceId)
        ? redactLog(new URL(input.sourceId).pathname)
        : undefined,
    },
  } as const
}
