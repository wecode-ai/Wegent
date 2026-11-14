import { mountPreviewModes, previewModeStyles } from './modeControls'

export const HTML_PREVIEW_SANDBOX = 'allow-forms allow-popups allow-scripts'

/** This channel has only reading controls; it never receives native resource capabilities. */
export function installHtmlReadingBridge(
  mountModes: typeof mountPreviewModes,
  styles: string,
  theme: 'light' | 'dark'
) {
  let modeHost: HTMLElement | undefined
  const send = (type: string, value?: number | 'preview' | 'source') =>
    parent.postMessage({ channel: 'wework-html-reading', type, value }, '*')
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== 'wework-html-reading') return
    if (event.data.type === 'theme') {
      if (modeHost && (event.data.value === 'light' || event.data.value === 'dark'))
        modeHost.dataset.theme = event.data.value
      return
    }
    if (event.data.type === 'position' && Number.isFinite(event.data.value))
      scrollTo(0, Math.max(0, event.data.value))
    if (event.data.type !== 'search' || typeof event.data.value !== 'string') return
    const query = event.data.value.toLocaleLowerCase()
    const selection = getSelection()
    selection?.removeAllRanges()
    if (!query || !document.body) return
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const element = node.parentElement
      if (!element || element.closest('script,style,textarea')) continue
      const index = (node.textContent ?? '').toLocaleLowerCase().indexOf(query)
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + event.data.value.length)
      selection?.addRange(range)
      element.scrollIntoView({ block: 'center' })
      break
    }
  })
  let frame = 0
  addEventListener(
    'scroll',
    () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          send('position', scrollY)
        })
    },
    { passive: true }
  )
  addEventListener(
    'DOMContentLoaded',
    () => {
      const host = document.createElement('wework-preview-modes')
      // Scope all control styles to a shadow root, outside the document's CSS selectors.
      for (const [property, value] of Object.entries({
        display: 'block',
        position: 'relative',
        width: '100%',
        height: '52px',
        margin: '0',
        padding: '0',
        border: '0',
        flex: '0 0 52px',
      }))
        host.style.setProperty(property, value, 'important')
      mountModes(host, 'preview', theme, mode => send('mode', mode), styles)
      modeHost = host
      document.body.prepend(host)
    },
    { once: true }
  )
  addEventListener('load', () => send('ready'), { once: true })
}

export function htmlDocumentWithReadingBridge(
  text: string,
  theme: 'light' | 'dark' = 'light'
): string {
  const document = new DOMParser().parseFromString(text, 'text/html')
  const script = document.createElement('script')
  script.textContent = `(${installHtmlReadingBridge.toString()})(${mountPreviewModes.toString()}, ${JSON.stringify(previewModeStyles)}, ${JSON.stringify(theme)})`
  document.head.prepend(script)
  return `<!doctype html>${document.documentElement.outerHTML}`
}
