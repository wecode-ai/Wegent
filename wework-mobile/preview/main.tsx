import FileViewer, { type FileViewerHandle } from '@file-viewer/react'
import officeRenderers from '@file-viewer/preset-office'
import liteRenderers from '@file-viewer/preset-lite'
import engineeringRenderers from '@file-viewer/preset-engineering'
import { parsePatchFiles } from '@pierre/diffs'
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from '@pierre/diffs/react'
import DiffWorker from '@pierre/diffs/worker/worker.js?worker'
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import {
  AssistantMarkdown,
  MarkdownServicesProvider,
  browserMarkdownServices,
  markdownMessages,
} from '../../packages/collaboration/src/markdown'
import { XMindPreview } from '../../packages/collaboration/src/files/XMindPreview'
import {
  isHtmlFile,
  isMarkdownFile,
  workspaceFileViewerType,
} from '../../packages/chat-core/src/workspace-file-types'
import {
  canPreviewSource,
  isPreviewLinkAllowed,
  type PreviewEvent,
  type PreviewState,
} from './protocol'
import { createPreviewResourceBridge } from './resourceBridge'
import { createCodeItems, findCodeMatch, initialCodeTarget } from './codeNavigation'
import { codeItemMetrics, codeLayout, codeStyles, codeTheme } from './codePresentation'
import { HtmlPreview } from './HtmlPreview'
import { readSourcePreview } from './sourcePreview'
import './style.css'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void }
    __WEWORK_PREVIEW_TOKEN__?: string
  }
}

const bridgeToken = window.__WEWORK_PREVIEW_TOKEN__ ?? ''
delete window.__WEWORK_PREVIEW_TOKEN__
const post = (event: PreviewEvent) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify({ ...event, token: bridgeToken }))
const reportError = (reason: unknown) =>
  post({ type: 'error', message: reason instanceof Error ? reason.message : String(reason) })
const openLink = (href: string) => {
  if (isPreviewLinkAllowed(href)) post({ type: 'link', href })
}
const workerOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: 2,
  totalASTLRUCacheSize: 30,
}
const highlighterOptions = {
  preferredHighlighter: 'shiki-js' as const,
  theme: codeTheme,
  langs: ['typescript', 'javascript', 'css', 'html', 'python'],
}

class PreviewBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  componentDidCatch(error: Error) {
    reportError(error)
  }
  render() {
    return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children
  }
}

function findText(container: HTMLElement, query: string) {
  const selection = window.getSelection()
  selection?.removeAllRanges()
  if (!query) return
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || parent.closest('script, style, button, textarea')) continue
    const index = (node.textContent ?? '').toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
    if (index < 0) continue
    const range = document.createRange()
    range.setStart(node, index)
    range.setEnd(node, index + query.length)
    selection?.addRange(range)
    parent.scrollIntoView({ block: 'center' })
    return
  }
}

function TextPreview({ state }: { state: PreviewState }) {
  const code = useRef<CodeViewHandle<undefined, undefined>>(null)
  const container = useRef<HTMLDivElement>(null)
  const markdown = state.mode === 'preview' && isMarkdownFile(state.name) && state.kind !== 'diff'
  const html = state.mode === 'preview' && isHtmlFile(state.name) && state.kind !== 'diff'
  const text = state.text ?? ''
  const items = useMemo(
    () => createCodeItems(state, parsePatchFiles),
    [state.kind, state.mode, state.name, state.path, state.url, text]
  )
  const match = useMemo(() => findCodeMatch(items, state.search), [items, state.search])
  const initial = useRef(state.initialPosition)

  useEffect(() => {
    if (markdown) {
      if (container.current) container.current.scrollTop = initial.current
      const target = state.lineStart
        ? container.current?.querySelector(`[data-source-line="${state.lineStart}"]`)
        : null
      target?.scrollIntoView({ block: 'center' })
    } else if (!html) {
      code.current?.scrollTo(initialCodeTarget(items, state.lineStart, initial.current))
    }
  }, [html, markdown, state.path, state.lineStart, items])

  useEffect(() => {
    if (!state.search) return
    if (markdown && container.current) findText(container.current, state.search)
    else if (!html && match)
      code.current?.scrollTo({ type: 'line', ...match, align: 'center', behavior: 'instant' })
  }, [state.search, markdown, html, match])

  if (html)
    return (
      <HtmlPreview
        text={text}
        name={state.name}
        search={state.search}
        initialPosition={initial.current}
        onPosition={value => post({ type: 'position', value })}
      />
    )
  if (markdown)
    return (
      <div
        ref={container}
        className="document-scroll"
        onScroll={event => post({ type: 'position', value: event.currentTarget.scrollTop })}
      >
        <AssistantMarkdown
          content={text}
          variant="document"
          sourceLineAnchors
          onOpenFile={openLink}
        />
      </div>
    )
  if (state.kind === 'diff' && items.length === 0)
    return <p className="empty">没有可显示的文本变更</p>
  return (
    <CodeView
      ref={code}
      className="code-preview"
      items={items}
      onScroll={position => post({ type: 'position', value: position })}
      selectedLines={
        match
          ? {
              id: match.id,
              range: { start: match.lineNumber, end: match.lineNumber, side: match.side },
            }
          : state.lineStart && items[0]
            ? {
                id: items[0].id,
                range: { start: state.lineStart, end: state.lineEnd ?? state.lineStart },
              }
            : undefined
      }
      options={{
        diffStyle: 'unified',
        theme: codeTheme,
        themeType: state.theme,
        preferredHighlighter: 'shiki-js',
        overflow: state.wrap ? 'wrap' : 'scroll',
        disableFileHeader: state.kind !== 'diff',
        stickyHeaders: false,
        enableLineSelection: true,
        itemMetrics: codeItemMetrics,
        layout: codeLayout,
        unsafeCSS: codeStyles,
      }}
    />
  )
}

function BinaryPreview({ state }: { state: PreviewState }) {
  const viewer = useRef<FileViewerHandle>(null)
  const host = useRef<HTMLDivElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [ready, setReady] = useState(false)
  const [source, setSource] = useState<{ file: File; text: string; truncated: boolean } | null>(
    null
  )
  const initial = useRef(state.initialPosition)
  const reportReady = useCallback(() => setReady(true), [])
  const options = useMemo(
    () => ({
      preset: [officeRenderers, liteRenderers, engineeringRenderers],
      theme: state.theme,
      locale: 'zh-CN' as const,
      spreadsheet: { worker: false },
      drawing: { plantumlServerUrl: state.plantumlServerUrl },
    }),
    [state.theme, state.plantumlServerUrl]
  )
  const extension = state.name.split('.').at(-1)?.toLowerCase()
  const type = workspaceFileViewerType(state.name, state.mimeType)

  useEffect(() => {
    if (!file || state.mode !== 'source' || !canPreviewSource(state)) return
    let cancelled = false
    void readSourcePreview(file)
      .then(value => {
        if (!cancelled) setSource({ file, ...value })
      })
      .catch(error => {
        if (!cancelled) reportError(error)
      })
    return () => {
      cancelled = true
    }
  }, [file, state.mode, state.name, state.mimeType])

  useEffect(() => {
    const controller = new AbortController()
    void fetch(state.url, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`文件读取失败 (${response.status})`)
        const blob = await response.blob()
        if (!controller.signal.aborted)
          setFile(new File([blob], state.name, { type: state.mimeType }))
      })
      .catch(error => {
        if (!controller.signal.aborted) reportError(error)
      })
    return () => controller.abort()
  }, [state.url, state.name, state.mimeType])

  useEffect(() => {
    if (!ready) return
    const api = viewer.current?.getApi()
    if (api && initial.current)
      void api.applyViewState({ scroll: { top: initial.current } }).catch(reportError)
    else if (host.current && initial.current) {
      const scrollable = host.current.querySelector<HTMLElement>(
        '[data-testid="workspace-xmind-file-preview"]'
      )
      if (scrollable) scrollable.scrollTop = initial.current
    }
  }, [ready])

  useEffect(() => {
    if (!ready) return
    if (viewer.current) void viewer.current.searchDocument(state.search).catch(reportError)
    else if (host.current) findText(host.current, state.search)
  }, [ready, state.search])

  if (state.mode === 'source' && canPreviewSource(state))
    return source?.file === file ? (
      <>
        <TextPreview state={{ ...state, kind: 'text', text: source.text }} />
        {source.truncated ? <div className="truncated">文件较大，当前显示部分内容</div> : null}
      </>
    ) : (
      <p className="empty">正在加载源码…</p>
    )
  if (/^(puml|plantuml)$/.test(extension ?? '') && !state.plantumlServerUrl)
    throw new Error('PlantUML 预览需要配置 EXPO_PUBLIC_PLANTUML_SERVER_URL；可切换源码查看')
  if (!file) return <p className="empty">正在加载文件…</p>
  return (
    <div
      ref={host}
      className="binary-preview"
      onScrollCapture={event => {
        const target = event.target as HTMLElement
        if (target.scrollHeight > target.clientHeight)
          post({ type: 'position', value: target.scrollTop })
      }}
    >
      {extension === 'xmind' ? (
        <XMindPreview
          file={file}
          name={state.name}
          loadingLabel="正在加载文件…"
          errorLabel="无法读取此思维导图"
          onError={reportError}
          onReady={reportReady}
        />
      ) : /^(mp4|ogv|webm)$/.test(extension ?? '') ? (
        <video controls playsInline src={state.url} className="media-preview" />
      ) : (
        <FileViewer
          ref={viewer}
          file={file}
          filename={state.name}
          type={type}
          size={state.size}
          options={options}
          className="file-viewer wework-diagram-preview"
          onStateChange={value => {
            if (value.error) reportError(value.error)
            if (value.ready) reportReady()
          }}
        />
      )}
    </div>
  )
}

function Preview({ state }: { state: PreviewState }) {
  const resources = useMemo(
    () => createPreviewResourceBridge(bridgeToken, post, window),
    [state.url]
  )
  useEffect(() => () => resources.dispose(), [resources])
  const services = useMemo(
    () => ({
      ...browserMarkdownServices,
      theme: state.theme,
      translate: (key: string, fallback?: string) =>
        markdownMessages['zh-CN'][key as keyof (typeof markdownMessages)['zh-CN']] ??
        fallback ??
        key,
      openExternalUrl: openLink,
      navigateTo: openLink,
      windowMarkdown: false,
      plantumlServerUrl: state.plantumlServerUrl,
      resolveImageUrl: resources.resolve,
    }),
    [state.theme, state.plantumlServerUrl, resources]
  )
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme
    document.documentElement.classList.toggle('dark', state.theme === 'dark')
  }, [state.theme])
  return (
    <MarkdownServicesProvider value={services}>
      <WorkerPoolContextProvider
        poolOptions={workerOptions}
        highlighterOptions={highlighterOptions}
      >
        {state.kind === 'binary' ? (
          <BinaryPreview key={state.url} state={state} />
        ) : (
          <TextPreview key={`${state.url}:${state.mode}`} state={state} />
        )}
        {state.truncated ? <div className="truncated">文件较大，当前显示部分内容</div> : null}
      </WorkerPoolContextProvider>
    </MarkdownServicesProvider>
  )
}

function App() {
  const [state, setState] = useState<PreviewState | null>(null)
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ token: string; state: PreviewState }>).detail
      if (bridgeToken && detail?.token === bridgeToken) setState(detail.state)
    }
    window.addEventListener('wework-preview', update)
    post({ type: 'ready' })
    return () => window.removeEventListener('wework-preview', update)
  }, [])
  return state ? (
    <PreviewBoundary key={`${state.url}:${state.mode}`}>
      <Preview state={state} />
    </PreviewBoundary>
  ) : null
}

document.addEventListener(
  'click',
  event => {
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement) as
      HTMLAnchorElement | undefined
    const href = anchor?.getAttribute('href')
    if (!href || href.startsWith('#')) return
    event.preventDefault()
    openLink(href)
  },
  true
)
window.addEventListener('error', event => reportError(event.error ?? event.message))
window.addEventListener('unhandledrejection', event => reportError(event.reason))
createRoot(document.getElementById('root')!).render(<App />)
