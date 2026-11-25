import { collectMarkdownLiteralRanges } from '@wegent/collaboration/markdown/composerReferenceMarkdown'
import { isGitlabCliTarget } from '@/api/local/gitlabCli'
import type { WorkbenchMessage } from '@/types/workbench'

const TEXT_LIMIT = 64 * 1024
const authCode = /^(?:connector_auth_required|need_login)$/i
const marker = /^[ \t]*(?:[-*+] +)?`?(?:connector_auth_required|need_login)`?(?=[ \t\r\n]|$)/gim
const field =
  /^[ \t]*(?:[-*+] +)?`?(pluginKey|connectorSlug|instance)`?[ \t]*[:=][ \t]*`?([^\s`,"<>]+)`?(?=[ \t\r\n]|$)/i

export interface ConnectorAuthHint {
  pluginKey: string | null
  connectorSlug: string
  displayName: string
  instance?: string
}

function resolveTarget(
  plugin: unknown,
  connector: unknown,
  instance: unknown
): ConnectorAuthHint | null {
  if (typeof connector !== 'string' || !/^[\w.:-]+$/.test(connector)) return null
  if (plugin != null && (typeof plugin !== 'string' || !/^[\w.:@-]+$/.test(plugin))) return null
  const pluginKey = typeof plugin === 'string' ? plugin : null
  const target = {
    pluginKey,
    connectorSlug: connector,
    displayName: pluginKey ?? connector,
    ...(typeof instance === 'string' ? { instance } : {}),
  }
  if (pluginKey === 'gitlab' && connector.startsWith('wework-gitlab-cli-')) {
    if (!isGitlabCliTarget({ ...target, pluginKey })) return null
  }
  return target
}

function structuredHint(value: unknown, depth = 0): ConnectorAuthHint | null {
  if (depth > 5 || value == null) return null
  if (typeof value === 'string') {
    const input = value.trim()
    if ((!input.startsWith('{') && !input.startsWith('[')) || input.length > TEXT_LIMIT) return null
    try {
      return structuredHint(JSON.parse(input), depth + 1)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hint = structuredHint(entry, depth + 1)
      if (hint) return hint
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if ([record.error, record.code].some(code => typeof code === 'string' && authCode.test(code))) {
    const target =
      record.authTarget && typeof record.authTarget === 'object'
        ? (record.authTarget as Record<string, unknown>)
        : record
    return resolveTarget(
      target.pluginKey ?? target.plugin_key,
      target.connectorSlug ?? target.connector_slug,
      target.instance
    )
  }
  for (const key of [
    'error',
    'data',
    'result',
    'cause',
    'response',
    'content',
    'text',
    'output',
    'stderr',
  ]) {
    const hint = structuredHint(record[key], depth + 1)
    if (hint) return hint
  }
  return null
}

function textHint(text: string): ConnectorAuthHint | null {
  if (text.length > TEXT_LIMIT) return null
  const matches = [...text.matchAll(marker)]
  if (!matches.length) return null
  const literals = collectMarkdownLiteralRanges(text)
  for (const match of matches) {
    const start = match.index
    const end = start + match[0].length
    // Individually backticked protocol atoms are allowed, but code blocks and
    // inline examples containing a whole record are not.
    if (literals.some(range => range.start <= start && range.end > end)) continue
    let cursor = end
    const fields = new Map<string, string>()
    while (cursor < text.length) {
      const next = cursor + (text.slice(cursor).match(/^\s*/)?.[0].length ?? 0)
      const entry = text.slice(next).match(field)
      if (!entry) break
      cursor = next + entry[0].length
      if (literals.some(range => range.start <= next && range.end > cursor)) break
      const key = entry[1].toLowerCase()
      if (fields.has(key)) return null
      fields.set(key, entry[2])
    }
    const hint = resolveTarget(
      fields.get('pluginkey'),
      fields.get('connectorslug'),
      fields.get('instance')
    )
    if (hint) return hint
  }
  return null
}

export function latestConnectorAuthMessage(
  messages: WorkbenchMessage[]
): { message: WorkbenchMessage; hint: ConnectorAuthHint } | null {
  const message = messages.at(-1)
  if (!message || (message.role !== 'assistant' && message.role !== 'system')) return null

  const error = message.error
  let hint = error ? (structuredHint(error) ?? textHint(error)) : null
  for (const block of [...(message.blocks ?? [])].reverse()) {
    if (hint) break
    if ('toolOutput' in block) hint = structuredHint(block.toolOutput)
    if (!hint && block.type === 'text')
      hint = structuredHint(block.content) ?? textHint(block.content)
  }
  hint ??= structuredHint(message.content) ?? textHint(message.content)
  return hint ? { message, hint } : null
}
