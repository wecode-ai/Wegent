import { useEffect, useMemo, useRef } from 'react'
import { HTML_PREVIEW_SANDBOX, htmlDocumentWithReadingBridge } from './htmlDocument'

export function HtmlPreview({
  text,
  name,
  search,
  theme,
  initialPosition,
  onPosition,
  onModeChange,
}: {
  text: string
  name: string
  search: string
  theme: 'light' | 'dark'
  initialPosition: number
  onPosition: (value: number) => void
  onModeChange: (mode: 'preview' | 'source') => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const initialTheme = useRef(theme)
  const latest = useRef({ search, theme, initialPosition, onPosition, onModeChange })
  latest.current = { search, theme, initialPosition, onPosition, onModeChange }
  const srcDoc = useMemo(() => htmlDocumentWithReadingBridge(text, initialTheme.current), [text])
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
        send('theme', latest.current.theme)
        send('position', latest.current.initialPosition)
        if (latest.current.search) send('search', latest.current.search)
      } else if (event.data.type === 'position' && Number.isFinite(event.data.value)) {
        latest.current.onPosition(Math.max(0, event.data.value))
      } else if (
        event.data.type === 'mode' &&
        (event.data.value === 'preview' || event.data.value === 'source')
      ) {
        latest.current.onModeChange(event.data.value)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => send('search', search), [search])
  useEffect(() => send('theme', theme), [theme])
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
