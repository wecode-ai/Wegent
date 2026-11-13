import { useCallback, useEffect, useRef, useState } from 'react'
import { localHtmlBrowserUrl } from './assistantMarkdownLinks'
import { forwardVisualizationWheel, withVisualizationWheel } from './inlineVisualizationScroll'
import { joinDevicePath } from '@/lib/device-workspace-path'
import { readInlineVisualizationHtml } from '@/desktop/inlineVisualization'
import { useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { TurnFileChangesSummary } from '@/types/api'
import {
  readVisualizationThemeVariables,
  VISUALIZATION_THEME_PROPERTIES,
} from '@/lib/visualization-theme'

const MIN_FRAME_HEIGHT = 120
const MAX_FRAME_HEIGHT = 1200
const DEFAULT_FRAME_HEIGHT = 480
const RESIZE_MESSAGE_TYPE = 'wework-inline-visualization-resize'
const THEME_MESSAGE_TYPE = 'wework-inline-visualization-theme'

type VisualizationDocument =
  | { source: string; attempt: number; status: 'loaded'; url: string }
  | { source: string; attempt: number; status: 'error' }

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
  mode,
  title,
}: {
  file: string
  fileChanges?: TurnFileChangesSummary
  mode?: 'wide'
  title?: string
}) {
  const { t } = useTranslation('chat')
  const theme = useOptionalAppearance()?.resolvedMode ?? 'light'
  const themeRef = useRef(theme)
  const sourcePath = resolveVisualizationPath(file, fileChanges)
  const sourceUrl = sourcePath ? localHtmlBrowserUrl(sourcePath) : null
  const [document, setDocument] = useState<VisualizationDocument>()
  const [attempt, setAttempt] = useState(0)
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [resizeToken] = useState(() => crypto.randomUUID())

  useFrameMessages(frameRef, resizeToken, setFrameHeight)

  const updateFrameTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      {
        type: THEME_MESSAGE_TYPE,
        token: resizeToken,
        theme,
        variables: readVisualizationThemeVariables(),
      },
      '*'
    )
  }, [resizeToken, theme])

  useEffect(() => {
    themeRef.current = theme
    updateFrameTheme()
  }, [theme, updateFrameTheme, document])

  useEffect(() => {
    const observer = new MutationObserver(updateFrameTheme)
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme', 'data-appearance-theme'],
    })
    return () => observer.disconnect()
  }, [updateFrameTheme])

  useEffect(() => {
    if (!sourcePath || !sourceUrl) return

    let active = true
    let objectUrl: string | undefined
    void readInlineVisualizationHtml(sourcePath)
      .then(fragment => {
        if (!active) return
        objectUrl = URL.createObjectURL(
          new Blob(
            [buildVisualizationDocument(fragment, sourceUrl, resizeToken, themeRef.current)],
            { type: 'text/html;charset=utf-8' }
          )
        )
        setDocument({ source: sourceUrl, attempt, status: 'loaded', url: objectUrl })
      })
      .catch(error => {
        if (!active) return
        console.error('[Wework] Failed to load inline visualization:', sourcePath, error)
        setDocument({ source: sourceUrl, attempt, status: 'error' })
      })

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attempt, resizeToken, sourcePath, sourceUrl])

  if (!sourceUrl) return null
  const currentDocument =
    document?.source === sourceUrl && document.attempt === attempt ? document : undefined
  const frameUrl = currentDocument?.status === 'loaded' ? currentDocument.url : 'about:blank'

  return (
    <div
      data-scroll-anchor
      data-testid="codex-inline-visualization"
      data-visualization-mode={mode ?? 'inline'}
      className="mb-3"
    >
      {currentDocument?.status !== 'loaded' && (
        <div
          className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm text-muted-foreground"
          role={currentDocument?.status === 'error' ? 'alert' : 'status'}
          data-testid="codex-inline-visualization-status"
        >
          <span>
            {t(
              currentDocument?.status === 'error'
                ? 'visualization.load_failed'
                : 'visualization.loading'
            )}
          </span>
          {currentDocument?.status === 'error' && (
            <Button
              variant="outline"
              size="sm"
              className="h-11 md:h-7"
              onClick={() => setAttempt(value => value + 1)}
              data-testid="codex-inline-visualization-retry"
            >
              {t('visualization.retry')}
            </Button>
          )}
        </div>
      )}
      <iframe
        ref={frameRef}
        title={title ?? file}
        src={frameUrl}
        sandbox="allow-scripts"
        style={{ height: frameHeight }}
        className={
          currentDocument?.status === 'loaded' ? 'block w-full border-0 bg-transparent' : 'hidden'
        }
        onLoad={updateFrameTheme}
        data-testid="codex-inline-visualization-frame"
      />
    </div>
  )
}

function useFrameMessages(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  token: string,
  setHeight: (height: number) => void
) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (isResizeMessage(event.data, token)) {
        setHeight(
          Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(event.data.height)))
        )
      } else {
        forwardVisualizationWheel(frame, event.data, token)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
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

function buildVisualizationDocument(
  fragment: string,
  sourceUrl: string,
  token: string,
  theme: 'light' | 'dark'
): string {
  const directoryUrl = new URL('.', sourceUrl).href
  const base = `<base href="${escapeHtmlAttribute(directoryUrl)}">`
  const variables = Object.entries(readVisualizationThemeVariables())
    .map(([property, value]) => `${property}:${value.replace(/</g, '\\3c ')};`)
    .join('')
  const themeStyleId = `wework-visualization-theme-${token}`
  const styles = `<style>${CODEX_VISUALIZATION_HOST_STYLES}\n:root { color-scheme: ${theme}; }</style><style id="${escapeHtmlAttribute(themeStyleId)}">:root { ${variables} }</style>`
  const resizeScript = `<script>(()=>{
    const token=${JSON.stringify(token)};
    const properties=${JSON.stringify(VISUALIZATION_THEME_PROPERTIES)};
    const originalProperties=new Map();
    const themeStyle=document.getElementById(${JSON.stringify(themeStyleId)});
    const height=()=>{
      const body=document.body,top=body.getBoundingClientRect().top;
      return Math.max(body.getBoundingClientRect().height,...Array.from(body.children,child=>child.getBoundingClientRect().bottom-top));
    };
    const send=()=>parent.postMessage({type:${JSON.stringify(RESIZE_MESSAGE_TYPE)},token:token,height:height()},'*');
    addEventListener('message',event=>{
      const data=event.data;
      if(event.source!==parent||!data||data.type!==${JSON.stringify(THEME_MESSAGE_TYPE)}||data.token!==token) return;
      if(data.theme!=='light'&&data.theme!=='dark') return;
      document.documentElement.style.colorScheme=data.theme;
      themeStyle.textContent='';
      if(data.variables&&typeof data.variables==='object') {
        const style=document.documentElement.style;
        for(const property of properties) {
          const value=data.variables[property];
          if(typeof value==='string') {
            if(!originalProperties.has(property)) originalProperties.set(property,[style.getPropertyValue(property),style.getPropertyPriority(property)]);
            style.setProperty(property,value);
          } else if(originalProperties.has(property)) {
            const [original,priority]=originalProperties.get(property);
            if(original) style.setProperty(property,original,priority);
            else style.removeProperty(property);
            originalProperties.delete(property);
          }
        }
      }
      send();
    });
    new ResizeObserver(send).observe(document.body);
    addEventListener('load',send);
    send();
  })()</script>`
  return withVisualizationWheel(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${base}${styles}</head><body>${fragment}${resizeScript}</body></html>`,
    token
  )
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function resolveVisualizationPath(
  file: string,
  fileChanges?: TurnFileChangesSummary
): string | null {
  if (isAbsoluteVisualizationPath(file)) return file
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

function isAbsoluteVisualizationPath(file: string): boolean {
  const normalized = file.trim().replace(/\\/g, '/')
  return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)
}
