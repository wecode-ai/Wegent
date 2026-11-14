import { useEffect, useMemo, useRef } from 'react'
import { HTML_PREVIEW_SANDBOX, htmlDocumentWithReadingBridge } from './htmlDocument'

export function HtmlPreview({
  text,
  name,
  search,
  initialPosition,
  onPosition,
}: {
  text: string
  name: string
  search: string
  initialPosition: number
  onPosition: (value: number) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ search, initialPosition, onPosition })
  latest.current = { search, initialPosition, onPosition }
  const srcDoc = useMemo(() => htmlDocumentWithReadingBridge(text), [text])
  const send = (type: string, value: string | number) =>
    frame.current?.contentWindow?.postMessage({ channel: 'wework-html-reading', type, value }, '*')

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.channel !== 'wework-html-reading'
      )
        return
      if (event.data.type === 'ready') {
        send('position', latest.current.initialPosition)
        if (latest.current.search) send('search', latest.current.search)
      } else if (event.data.type === 'position' && Number.isFinite(event.data.value)) {
        latest.current.onPosition(Math.max(0, event.data.value))
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => send('search', search), [search])
  return (
    <iframe
      ref={frame}
      className="html-preview"
      title={name}
      srcDoc={srcDoc}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
    />
  )
}
