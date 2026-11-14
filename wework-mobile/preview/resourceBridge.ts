import {
  isPreviewResourceAllowed,
  type PreviewEvent,
  type PreviewResourceResponse,
} from './protocol'
import { getAuthenticatedAttachmentId } from '../../packages/collaboration/src/markdown/assistantMarkdownLinks'

/** Only the trusted renderer owns this channel; sandboxed HTML never receives its token. */
export function createPreviewResourceBridge(
  token: string,
  post: (event: PreviewEvent) => void,
  target: EventTarget
) {
  let sequence = 0
  let disposed = false
  let listening = false
  const pending = new Map<
    string,
    { resolve: (url: string) => void; reject: (error: Error) => void }
  >()
  const receive = (event: Event) => {
    const response = (event as CustomEvent<PreviewResourceResponse>).detail
    if (response?.token !== token || typeof response.id !== 'string') return
    const request = pending.get(response.id)
    if (!request) return
    if (typeof response.error === 'string') request.reject(new Error(response.error))
    else if (typeof response.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(response.url))
      request.resolve(response.url)
    else request.reject(new Error('文件资源地址无效'))
    pending.delete(response.id)
  }
  return {
    resolve: (href: string): Promise<string> => {
      if (disposed) return Promise.reject(new Error('文件预览已关闭'))
      if (
        getAuthenticatedAttachmentId(href) === null &&
        /^(https?:|blob:|data:image\/)/i.test(href)
      )
        return Promise.resolve(href)
      if (!isPreviewResourceAllowed(href)) return Promise.reject(new Error('不支持此图片地址'))
      if (!listening) {
        target.addEventListener('wework-preview-resource', receive)
        listening = true
      }
      return new Promise((resolve, reject) => {
        const id = String(++sequence)
        pending.set(id, { resolve, reject })
        post({ type: 'resource', id, href })
      })
    },
    dispose: () => {
      disposed = true
      target.removeEventListener('wework-preview-resource', receive)
      for (const request of pending.values()) request.reject(new Error('文件预览已关闭'))
      pending.clear()
    },
  }
}
