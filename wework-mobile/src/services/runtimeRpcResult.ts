import { base64 } from '@scure/base'
import { decodeMobileTranscriptGzip } from './mobileTranscriptTransfer'

export async function unwrapLocalRuntimeResponse<T>(frame: unknown): Promise<T> {
  if (
    !frame ||
    typeof frame !== 'object' ||
    !('type' in frame) ||
    frame.type !== 'response' ||
    !('ok' in frame) ||
    typeof frame.ok !== 'boolean'
  )
    throw new Error('本机执行器返回了无效的 IPC 响应')
  if (!frame.ok) {
    const error =
      'error' in frame && frame.error && typeof frame.error === 'object'
        ? (frame.error as Record<string, unknown>)
        : {}
    throw Object.assign(
      new Error(typeof error.message === 'string' ? error.message : '本机执行请求失败'),
      error
    )
  }
  if (!('result' in frame)) throw new Error('本机执行器响应缺少 result')
  return decodeRuntimeResult(frame.result as T)
}

/** App IPC and Backend relay use the same canonical compressed-result envelope. */
export async function decodeRuntimeResult<T>(result: T | undefined): Promise<T> {
  if (
    !result ||
    typeof result !== 'object' ||
    !('__runtimeRpcEncoding' in result) ||
    result.__runtimeRpcEncoding !== 'gzip+base64+json' ||
    !('payload' in result) ||
    typeof result.payload !== 'string'
  )
    return result as T
  const json = await decodeMobileTranscriptGzip([base64.decode(result.payload)])
  return JSON.parse(json) as T
}
