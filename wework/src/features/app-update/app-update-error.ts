export type AppUpdateErrorStage = 'check' | 'download' | 'install'
export type AppUpdateErrorKind = 'network' | 'unsupported' | 'generic'

export interface AppUpdateError {
  stage: AppUpdateErrorStage
  kind: AppUpdateErrorKind
  code: string
  occurredAt: number
  detail: string | null
}

const NETWORK_ERROR_PATTERN =
  /\b(?:network error|failed to fetch|fetch failed|econnreset|econnrefused|enotfound|etimedout|err_(?:address_unreachable|connection_(?:closed|refused|reset)|internet_disconnected|name_not_resolved|network(?:_changed)?|proxy_connection_failed|timed_out|tunnel_connection_failed)|nsurlerrordomain|sgerrordomain|connection (?:closed|reset|refused)|socket hang up|eof)\b/i
const UNSUPPORTED_ERROR_PATTERN =
  /updater (?:does not have any endpoints set|is only available)|automatic update checks are not available/i
const HTML_RESPONSE_PATTERN =
  /<!doctype html|<html(?:\s|>)|<style(?:\s|>)|<body(?:\s|>)|content-type["']?\s*:\s*["']?text\/html/i
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s<>"']+/gi
const SECRET_PATTERN = /\b(authorization|cookie|token|password|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/gi
const MAX_DETAIL_LENGTH = 500

export function createAppUpdateError(
  error: unknown,
  stage: AppUpdateErrorStage,
  occurredAt = Date.now()
): AppUpdateError {
  const messages = collectErrorMessages(error)
  const combinedMessage = messages.join('\n')
  const kind = classifyAppUpdateError(combinedMessage)

  return {
    stage,
    kind,
    code: appUpdateErrorCode(kind, stage),
    occurredAt,
    detail: sanitizeAppUpdateErrorDetail(messages[0] ?? '', kind),
  }
}

function classifyAppUpdateError(message: string): AppUpdateErrorKind {
  if (UNSUPPORTED_ERROR_PATTERN.test(message)) return 'unsupported'
  if (NETWORK_ERROR_PATTERN.test(message)) return 'network'
  return 'generic'
}

function appUpdateErrorCode(kind: AppUpdateErrorKind, stage: AppUpdateErrorStage): string {
  if (kind === 'network') return 'APP_UPDATE_NETWORK_UNAVAILABLE'
  if (kind === 'unsupported') return 'APP_UPDATE_UNAVAILABLE'
  return `APP_UPDATE_${stage.toUpperCase()}_FAILED`
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = []
  const visited = new Set<unknown>()
  let current: unknown = error

  while (current != null && !visited.has(current) && messages.length < 4) {
    visited.add(current)
    if (current instanceof Error) {
      if (current.message.trim()) messages.push(current.message.trim())
      current = current.cause
      continue
    }
    if (typeof current === 'string' && current.trim()) {
      messages.push(current.trim())
    }
    break
  }

  return [...new Set(messages)]
}

function sanitizeAppUpdateErrorDetail(message: string, kind: AppUpdateErrorKind): string | null {
  if (!message || kind === 'network' || kind === 'unsupported') return null
  if (HTML_RESPONSE_PATTERN.test(message)) return null

  const sanitized = message
    .replace(SECRET_PATTERN, '$1=[redacted]')
    .replace(URL_PATTERN, '[URL removed]')
    .split('')
    .map(character => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

  if (!sanitized) return null
  return sanitized.slice(0, MAX_DETAIL_LENGTH)
}
