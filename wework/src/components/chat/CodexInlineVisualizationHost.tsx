import { useEffect, useRef, useState } from 'react'
import { localHtmlBrowserUrl } from './assistantMarkdownLinks'
import { joinDevicePath } from '@/lib/device-workspace-path'
import type { TurnFileChangesSummary } from '@/types/api'

const MIN_FRAME_HEIGHT = 120
const MAX_FRAME_HEIGHT = 1200
const DEFAULT_FRAME_HEIGHT = 480
const RESIZE_MESSAGE_TYPE = 'wework-inline-visualization-resize'

// Codex visualization files are fragments that consume this host contract.
const CODEX_VISUALIZATION_HOST_STYLES = `
:root {
  color-scheme: light dark;
  --background: light-dark(rgb(255 255 255), rgb(24 24 24));
  --foreground: light-dark(rgb(26 28 31), rgb(255 255 255));
  --card: color-mix(in oklab, var(--foreground) 5%, transparent);
  --card-foreground: var(--foreground);
  --primary: light-dark(rgb(51 156 255), rgb(131 195 255));
  --primary-foreground: light-dark(rgb(255 255 255), rgb(13 13 13));
  --secondary: light-dark(rgb(255 255 255 / 96%), rgb(54 54 54 / 96%));
  --secondary-foreground: var(--foreground);
  --muted: color-mix(in srgb, var(--foreground) 10%, transparent);
  --muted-foreground: light-dark(rgb(26 28 31 / 49.4%), rgb(255 255 255 / 49.8%));
  --accent: light-dark(rgb(229 242 255), rgb(13 39 63));
  --accent-foreground: var(--primary);
  --destructive: light-dark(rgb(226 85 7), rgb(255 133 73));
  --border: light-dark(rgb(26 28 31 / 8%), rgb(255 255 255 / 8.2%));
  --input: light-dark(rgb(26 28 31 / 11.8%), rgb(0 0 0 / 10%));
  --ring: light-dark(rgb(51 156 255), rgb(131 195 255 / 76%));
  --viz-series-1: var(--primary);
  --viz-series-2: light-dark(rgb(243 136 59), rgb(245 154 86));
  --viz-series-3: light-dark(rgb(93 201 119), rgb(116 213 139));
  --viz-series-4: light-dark(rgb(235 119 177), rgb(240 143 192));
  --viz-series-5: light-dark(rgb(155 121 236), rgb(170 145 239));
  --viz-series-6: light-dark(rgb(58 185 177), rgb(90 203 194));
  --font-size-base: 14px;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
* { box-sizing: border-box; }
html > body {
  margin: 0;
  padding: 5px;
  color: var(--foreground);
  background: transparent;
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: 1.5;
}
h1, h2, h3, h4, h5, h6, p { margin-block: 0; }
h1 { font-size: calc(var(--font-size-base) * 1.7142857143); font-weight: 500; line-height: 1.25; }
h2 { font-size: calc(var(--font-size-base) * 1.4285714286); font-weight: 500; line-height: 1.25; }
h3, h4, h5, h6 { font-size: calc(var(--font-size-base) * 1.2857142857); font-weight: 500; line-height: 1.3; }
.text-small { font-size: calc(var(--font-size-base) * 0.8571428571); line-height: 1.3333333333; }
.text-muted { color: var(--muted-foreground); }
`

export function CodexInlineVisualizationHost({
  file,
  fileChanges,
}: {
  file: string
  fileChanges?: TurnFileChangesSummary
}) {
  const sourcePath = resolveVisualizationPath(file, fileChanges)
  const sourceUrl = sourcePath ? localHtmlBrowserUrl(sourcePath) : null
  const [documentUrl, setDocumentUrl] = useState<{ source: string; url: string }>()
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [resizeToken] = useState(() => crypto.randomUUID())

  useFrameResizeMessages(frameRef, resizeToken, setFrameHeight)

  useEffect(() => {
    if (!sourceUrl || typeof URL.createObjectURL !== 'function') return

    let active = true
    let objectUrl: string | undefined
    void fetch(sourceUrl)
      .then(response => {
        if (!response.ok) throw new Error(`Failed to load visualization: ${response.status}`)
        return response.text()
      })
      .then(fragment => {
        if (!active) return
        objectUrl = URL.createObjectURL(
          new Blob([buildVisualizationDocument(fragment, sourceUrl, resizeToken)], {
            type: 'text/html;charset=utf-8',
          })
        )
        setDocumentUrl({ source: sourceUrl, url: objectUrl })
      })
      .catch(() => undefined)

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [resizeToken, sourceUrl])

  if (!sourceUrl) return null
  const frameUrl = documentUrl?.source === sourceUrl ? documentUrl.url : sourceUrl

  return (
    <div
      data-scroll-anchor
      data-testid="codex-inline-visualization"
      className="mb-3 overflow-hidden rounded-xl border border-border bg-background"
    >
      <iframe
        ref={frameRef}
        title={file}
        src={frameUrl}
        sandbox="allow-scripts"
        style={{ height: frameHeight }}
        className="w-full border-0 bg-background"
        data-testid="codex-inline-visualization-frame"
      />
    </div>
  )
}

function useFrameResizeMessages(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  token: string,
  setHeight: (height: number) => void
) {
  useEffect(() => {
    const handleResize = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (!isResizeMessage(event.data, token)) return
      setHeight(
        Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(event.data.height)))
      )
    }
    window.addEventListener('message', handleResize)
    return () => window.removeEventListener('message', handleResize)
  }, [frameRef, setHeight, token])
}

function isResizeMessage(
  value: unknown,
  token: string
): value is { type: string; token: string; height: number } {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    message.type === RESIZE_MESSAGE_TYPE &&
    message.token === token &&
    typeof message.height === 'number' &&
    Number.isFinite(message.height)
  )
}

function buildVisualizationDocument(fragment: string, sourceUrl: string, token: string): string {
  const directoryUrl = new URL('.', sourceUrl).href
  const base = `<base href="${escapeHtmlAttribute(directoryUrl)}">`
  const styles = `<style>${CODEX_VISUALIZATION_HOST_STYLES}</style>`
  const resizeScript = `<script>(()=>{const height=()=>{const body=document.body,top=body.getBoundingClientRect().top;return Math.max(body.getBoundingClientRect().height,...Array.from(body.children,child=>child.getBoundingClientRect().bottom-top))};const send=()=>parent.postMessage({type:${JSON.stringify(RESIZE_MESSAGE_TYPE)},token:${JSON.stringify(token)},height:height()},'*');new ResizeObserver(send).observe(document.body);addEventListener('load',send);send()})()</script>`
  return `${base}${styles}${fragment}${resizeScript}`
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function resolveVisualizationPath(
  file: string,
  fileChanges?: TurnFileChangesSummary
): string | null {
  if (!fileChanges || fileChanges.status !== 'active') return null
  const normalizedFile = file.replace(/\\/g, '/')
  const exactMatch = fileChanges.files.find(
    change => change.path.replace(/\\/g, '/') === normalizedFile
  )
  const basenameMatches = normalizedFile.includes('/')
    ? []
    : fileChanges.files.filter(
        change => change.path.replace(/\\/g, '/').split('/').at(-1) === normalizedFile
      )
  const matchingFile = exactMatch ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined)
  if (!matchingFile || matchingFile.change_type === 'deleted') return null

  try {
    return joinDevicePath(fileChanges.workspace_path, matchingFile.path)
  } catch {
    return null
  }
}
