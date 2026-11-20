import { parseChatError, type ChatErrorType } from '../../../packages/chat-core/src/chat-error'

export interface MobileErrorPresentation {
  title: string
  message: string
  details?: string
}

// Match PC error classifications; only copy and layout adapt to the small screen.
const copy: Record<ChatErrorType, readonly [string, string]> = {
  context_length_exceeded: ['对话内容过长', '请切换到支持更长上下文的模型，或开始新对话。'],
  quota_exceeded: ['模型额度已用尽', '请切换可用模型，或在额度恢复后继续。'],
  rate_limit: ['请求过于频繁', '请稍后重试，或切换其他可用模型。'],
  server_overloaded: ['服务暂时繁忙', '请稍后重试。'],
  payload_too_large: ['内容超出限制', '请减少附件或对话内容后重试。'],
  model_service_connection_error: ['无法连接模型服务', '请检查网络或 VPN 连接后重试。'],
  network_error: ['连接未完成', '请检查网络连接，稍后重试。'],
  timeout_error: ['请求超时', '服务未及时响应，请稍后重试。'],
  llm_error: ['模型暂时不可用', '请稍后重试，或切换其他模型。'],
  llm_unsupported: ['模型不支持此请求', '请切换支持当前内容或附件类型的模型。'],
  invalid_parameter: ['请求内容有误', '请检查输入内容后重试。'],
  forbidden: ['无法访问此资源', '请确认账号、设备或模型的访问权限。'],
  container_oom: ['执行环境内存不足', '请开始新对话重试，或检查执行环境的可用内存。'],
  container_error: ['执行环境不可用', '请检查执行设备的状态，稍后重试。'],
  content_filter: ['当前内容无法处理', '请调整可能触发安全策略的内容后重试。'],
  provider_error: ['模型服务异常', '请稍后重试，或切换其他模型。'],
  image_too_large: ['图片超出大小限制', '请压缩图片或减少图片数量后重试。'],
  model_protocol_error: ['模型与运行协议不匹配', '请切换兼容的模型后重试。'],
  invalid_role: ['消息格式不兼容', '请切换其他模型后重试。'],
  permission_denied: ['访问权限不足', '请确认访问权限，或选择有权限的模型。'],
  generic_error: ['操作未完成', '请稍后重试。如需排查，可复制错误详情。'],
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  if (cause == null) return ''
  try {
    return JSON.stringify(cause) ?? String(cause)
  } catch {
    return String(cause)
  }
}

/** Diagnostics are explicit, but must still never disclose credentials. */
export function redactErrorDetails(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"')]+/gi, value => {
      try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        if (url.search) url.search = '?[已隐藏]'
        if (url.hash) url.hash = '#[已隐藏]'
        return url.toString()
      } catch {
        return '[地址已隐藏]'
      }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [已隐藏]')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, '$1[已隐藏]')
    .replace(
      /(["']?(?:[\w-]*(?:token|secret|password|api[_-]?key)|authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      '$1[已隐藏]'
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[已隐藏]'
    )
}

function isUserMessage(value: string): boolean {
  return (
    value.length <= 120 &&
    /[\u3400-\u9fff]/.test(value) &&
    !/[\r\n{}<>]|https?:\/\/|\b(?:error|exception|fetch|stack|promise|status|url)\b|\.swift:\d|\.tsx?:\d/i.test(
      value
    )
  )
}

export function describeMobileError(
  cause: unknown,
  contextTitle?: string
): MobileErrorPresentation {
  const raw = errorText(cause).trim()
  const parsed = parseChatError(raw)
  const [title, guidance] = parsed.gitFailure
    ? ['无法访问 Git 仓库', '请检查仓库地址和 Git 账号权限。']
    : copy[parsed.type]
  const message = isUserMessage(raw) ? redactErrorDetails(raw) : guidance
  return {
    title: contextTitle ?? title,
    message,
    ...(raw && raw !== message ? { details: redactErrorDetails(raw) } : {}),
  }
}
