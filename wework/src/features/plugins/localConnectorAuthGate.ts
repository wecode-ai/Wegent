import type { WorkbenchMessage } from '@/types/workbench'

const CONNECTOR_AUTH_TEXT_LIMIT = 64 * 1024
const CONNECTOR_AUTH_FIELD_TEXT_LIMIT = 16 * 1024
const CONNECTOR_AUTH_OBJECT_KEYS = [
  'error',
  'message',
  'detail',
  'content',
  'text',
  'output',
  'stderr',
  'pluginKey',
  'plugin_key',
  'connectorSlug',
  'connector_slug',
  'data',
  'result',
  'cause',
  'response',
] as const

function appendBoundedText(parts: string[], value: string, remaining: number): number {
  if (remaining <= 0 || !value) return remaining
  const separatorLength = parts.length > 0 ? 1 : 0
  const available = Math.min(remaining - separatorLength, CONNECTOR_AUTH_FIELD_TEXT_LIMIT)
  if (available <= 0) return remaining
  if (value.length <= available) {
    parts.push(value)
    return remaining - separatorLength - value.length
  }

  const headLength = Math.floor(available / 2)
  const tailLength = available - headLength
  parts.push(value.slice(0, headLength) + value.slice(-tailLength))
  return remaining - separatorLength - available
}

function appendConnectorAuthObjectText(
  parts: string[],
  value: unknown,
  remaining: number,
  depth = 0
): number {
  if (remaining <= 0 || value == null || depth > 3) return remaining
  if (typeof value === 'string') return appendBoundedText(parts, value, remaining)
  if (typeof value !== 'object') return remaining

  const record = value as Record<string, unknown>
  for (const key of CONNECTOR_AUTH_OBJECT_KEYS) {
    const field = record[key]
    if (field == null) continue
    if (typeof field === 'string') {
      remaining = appendBoundedText(parts, `${key}=${field}`, remaining)
    } else {
      remaining = appendConnectorAuthObjectText(parts, field, remaining, depth + 1)
    }
    if (remaining <= 0) break
  }
  return remaining
}

export function connectorAuthMessageText(message: WorkbenchMessage): string {
  const parts: string[] = []
  let remaining = CONNECTOR_AUTH_TEXT_LIMIT
  remaining = appendBoundedText(parts, message.error ?? '', remaining)

  for (const block of [...(message.blocks ?? [])].reverse()) {
    if (remaining <= 0) break
    if ('content' in block && typeof block.content === 'string') {
      remaining = appendBoundedText(parts, block.content, remaining)
    }
    if ('toolOutput' in block) {
      remaining = appendConnectorAuthObjectText(parts, block.toolOutput, remaining)
    }
  }
  appendBoundedText(parts, message.content, remaining)
  return parts.join('\n')
}

export function latestConnectorAuthMessage(
  messages: WorkbenchMessage[]
): { message: WorkbenchMessage; text: string } | null {
  const message = messages.at(-1)
  if (!message || (message.role !== 'assistant' && message.role !== 'system')) return null

  const text = connectorAuthMessageText(message)
  return messageRequiresConnectorAuth(text) ? { message, text } : null
}

export function messageRequiresConnectorAuth(text: string | null | undefined): boolean {
  return Boolean(text && /\b(?:connector_auth_required|need_login)\b/i.test(text))
}

export function extractConnectorAuthPluginKey(text: string | null | undefined): string | null {
  if (!text) return null
  const match =
    text.match(/"plugin(?:Key|_key)"\s*:\s*"([^"]+)"/i) ||
    text.match(/pluginKey[`*_]*\s*[=:]\s*[`*_]*([a-z0-9._-]+)/i)
  return match?.[1] ?? null
}

export function extractConnectorAuthConnectorSlug(text: string | null | undefined): string | null {
  if (!text) return null
  const match =
    text.match(/"connector(?:Slug|_slug)"\s*:\s*"([^"]+)"/i) ||
    text.match(/connectorSlug[`*_]*\s*[=:]\s*[`*_]*([a-z0-9._-]+)/i)
  return match?.[1] ?? null
}

/** Resolve an explicit plugin and connector identity without enumerating installations. */
export function resolveLocalConnectorAuthHint(
  text: string | null | undefined
): { pluginKey: string; connectorSlug: string; displayName: string } | null {
  if (!text || !messageRequiresConnectorAuth(text)) return null
  const pluginKey = extractConnectorAuthPluginKey(text)
  const connectorSlug = extractConnectorAuthConnectorSlug(text)
  if (pluginKey && connectorSlug) {
    return { pluginKey, connectorSlug, displayName: pluginKey }
  }
  return null
}
