export const HTML_PREVIEW_SANDBOX = 'allow-forms allow-popups allow-scripts'

/** This iframe channel only supports search and scroll; it has no native resource capabilities. */
function installHtmlReadingBridge() {
  const send = (type: string, value?: number) =>
    parent.postMessage({ channel: 'wework-html-reading', type, value }, '*')
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== 'wework-html-reading') return
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
  addEventListener('load', () => send('ready'), { once: true })
}

export function htmlDocumentWithReadingBridge(text: string): string {
  const document = new DOMParser().parseFromString(text, 'text/html')
  const script = document.createElement('script')
  script.textContent = `(${installHtmlReadingBridge.toString()})()`
  document.head.prepend(script)
  return `<!doctype html>${document.documentElement.outerHTML}`
}
