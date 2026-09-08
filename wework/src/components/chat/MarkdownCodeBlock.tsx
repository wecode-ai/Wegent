import { memo, useEffect, useRef, useState } from 'react'
import type { CSSProperties, HTMLProps, ReactNode } from 'react'
import { ArrowRightToLine, Copy, CopyCheck, TextWrap } from 'lucide-react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { track } from '@/telemetry/client'
import type { HighlightedCode } from './highlightCode'
import 'highlight.js/styles/atom-one-dark.css'

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  cmd: 'shell',
  docker: 'dockerfile',
  js: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'shell',
  'shell-session': 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'shell',
}

const DISPLAY_LANGUAGE_ALIASES: Record<string, string> = {
  markdown: 'md',
}

const CODE_ACTION_BUTTON_CLASS =
  'flex h-7 w-7 select-none items-center justify-center rounded-md text-[#b8c0cc] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'

const CODE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
const HIGHLIGHT_INTERVAL_MS = 120

const codeCustomStyle: CSSProperties = {
  margin: 0,
  padding: '0.75rem 1rem',
  background: 'transparent',
  color: '#abb2bf',
  fontSize: 'var(--text-code)',
  lineHeight: '1.8',
}

const markdownWrapStateByKey = new Map<string, boolean>()

interface MarkdownCodeBlockProps {
  lang?: string
  children: ReactNode
  compact?: boolean
  isStreaming?: boolean
}

export function MarkdownCodeBlock({
  lang = '',
  children,
  compact = false,
  isStreaming = false,
}: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const text = String(children).replace(/\n$/, '')
  const language = normalizeLanguage(lang)
  const canToggleWrap = language === 'markdown'
  const wrapStateKey = canToggleWrap ? getMarkdownWrapStateKey(text, compact) : ''
  const [wrapState, setWrapState] = useState(() => ({
    key: wrapStateKey,
    value: wrapStateKey ? (markdownWrapStateByKey.get(wrapStateKey) ?? false) : false,
  }))
  const storedWrapLines = wrapStateKey ? (markdownWrapStateByKey.get(wrapStateKey) ?? false) : false
  const effectiveWrapLines =
    canToggleWrap && (wrapState.key === wrapStateKey ? wrapState.value : storedWrapLines)
  const displayLanguage = formatDisplayLanguage(language)
  const wrapButtonLabel = effectiveWrapLines ? '禁用自动换行' : '开启自动换行'
  const codeStyle = getCodeCustomStyle(effectiveWrapLines)
  const codeProps = getCodeTagProps(effectiveWrapLines)
  const highlightedCode = useThrottledHighlightedCode(text, language)
  const highlightedPrefix =
    highlightedCode && text.startsWith(highlightedCode.code) ? highlightedCode : null

  const handleCopy = async () => {
    await copyCodeText(text)
    track('ai_output_action_completed', { action: 'copy', source: 'chat' })
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const toggleWrapLines = () => {
    if (!wrapStateKey) return
    const nextValue = !effectiveWrapLines
    markdownWrapStateByKey.set(wrapStateKey, nextValue)
    setWrapState({ key: wrapStateKey, value: nextValue })
  }

  return (
    <div
      data-testid="markdown-code-block"
      data-scroll-anchor
      className={[
        'markdown-code-block max-w-full select-none overflow-hidden rounded-lg border border-[#3c424a] bg-[#2f2f2f] text-left shadow-sm',
        compact ? 'mb-1.5' : 'mb-3 mt-2',
      ].join(' ')}
    >
      <div className="flex h-10 select-none items-center justify-between border-b border-[#3c424a] px-3">
        <span
          data-testid="markdown-code-block-language"
          className="select-none text-xs font-medium text-[#b8c0cc]"
        >
          {displayLanguage}
        </span>
        <div className="flex items-center gap-1">
          {canToggleWrap ? (
            <button
              type="button"
              onClick={toggleWrapLines}
              className={CODE_ACTION_BUTTON_CLASS}
              aria-label={wrapButtonLabel}
              aria-pressed={effectiveWrapLines}
              title={wrapButtonLabel}
              data-testid="markdown-code-wrap-button"
            >
              {effectiveWrapLines ? (
                <TextWrap className="h-3.5 w-3.5" data-testid="markdown-code-wrap-enabled-icon" />
              ) : (
                <ArrowRightToLine
                  className="h-3.5 w-3.5"
                  data-testid="markdown-code-wrap-disabled-icon"
                />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={CODE_ACTION_BUTTON_CLASS}
            aria-label="复制代码"
            title="复制代码"
            data-testid="markdown-code-copy-button"
          >
            {copied ? (
              <CopyCheck className="h-3.5 w-3.5" data-testid="markdown-code-copy-success-icon" />
            ) : (
              <Copy className="h-3.5 w-3.5" data-testid="markdown-code-copy-icon" />
            )}
          </button>
        </div>
      </div>
      <MarkdownCodeScrollArea
        wrapLines={effectiveWrapLines}
        isStreaming={isStreaming}
        syntaxHighlighted={Boolean(highlightedPrefix)}
      >
        <pre style={codeStyle}>
          <code {...codeProps}>
            <HighlightedCodeContent text={text} highlightedCode={highlightedPrefix} />
          </code>
        </pre>
      </MarkdownCodeScrollArea>
    </div>
  )
}

function MarkdownCodeScrollArea({
  children,
  isStreaming,
  syntaxHighlighted,
  wrapLines,
}: {
  children: ReactNode
  isStreaming: boolean
  syntaxHighlighted: boolean
  wrapLines: boolean
}) {
  const hideHorizontalScrollbar = isStreaming || wrapLines

  return (
    <ScrollAreaPrimitive.Root type="always" className="relative max-w-full">
      <ScrollAreaPrimitive.Viewport
        data-testid="markdown-code-scroll-container"
        data-wrap={wrapLines ? 'true' : 'false'}
        data-syntax-highlighted={syntaxHighlighted ? 'true' : 'false'}
        className={[
          'max-w-full select-none',
          hideHorizontalScrollbar
            ? 'scrollbar-none overflow-x-hidden'
            : 'scrollbar-soft overflow-x-auto',
        ].join(' ')}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        data-testid="markdown-code-horizontal-scrollbar"
        hidden={hideHorizontalScrollbar}
        className="flex h-2.5 touch-none select-none bg-transparent p-0.5"
      >
        <ScrollAreaPrimitive.Thumb
          data-testid="markdown-code-horizontal-scrollbar-thumb"
          className="relative self-stretch rounded-full bg-[#aaaaaa] hover:bg-[#8c8c8c]"
        />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  )
}

function useThrottledHighlightedCode(text: string, language: string): HighlightedCode | null {
  const [highlightedCode, setHighlightedCode] = useState<HighlightedCode | null>(null)
  const stateRef = useRef({
    disposed: false,
    lastStartedAtMs: null as number | null,
    latestLanguage: language,
    latestText: text,
    timeoutHandle: null as ReturnType<typeof setTimeout> | null,
  })

  useEffect(() => {
    const state = stateRef.current
    state.disposed = false
    return () => {
      state.disposed = true
      if (state.timeoutHandle !== null) {
        clearTimeout(state.timeoutHandle)
        state.timeoutHandle = null
      }
    }
  }, [])

  useEffect(() => {
    const state = stateRef.current
    state.latestText = text
    state.latestLanguage = language
    if (state.timeoutHandle !== null) return

    const now = performance.now()
    const elapsed =
      state.lastStartedAtMs === null ? HIGHLIGHT_INTERVAL_MS : now - state.lastStartedAtMs
    const delay = Math.max(0, HIGHLIGHT_INTERVAL_MS - elapsed)
    const startHighlight = () => {
      state.timeoutHandle = null
      if (state.disposed) return

      const code = state.latestText
      const nextLanguage = state.latestLanguage
      state.lastStartedAtMs = performance.now()
      void import('./highlightCode').then(({ highlightCode }) => {
        if (state.disposed) return
        setHighlightedCode(highlightCode(code, nextLanguage))
      })
    }

    if (delay === 0) {
      startHighlight()
      return
    }
    state.timeoutHandle = setTimeout(startHighlight, delay)
  }, [language, text])

  return highlightedCode
}

function HighlightedCodeContent({
  text,
  highlightedCode,
}: {
  text: string
  highlightedCode: HighlightedCode | null
}) {
  if (!highlightedCode) return text

  const lines = highlightedCode.html.split('\n')
  const pendingTail = text.slice(highlightedCode.code.length)
  return (
    <>
      {lines.map((html, index) => (
        <HighlightedCodeLine key={index} html={html} appendLineBreak={index < lines.length - 1} />
      ))}
      {pendingTail}
    </>
  )
}

const HighlightedCodeLine = memo(function HighlightedCodeLine({
  html,
  appendLineBreak,
}: {
  html: string
  appendLineBreak: boolean
}) {
  return (
    <>
      <span dangerouslySetInnerHTML={{ __html: html }} />
      {appendLineBreak ? '\n' : null}
    </>
  )
})

function normalizeLanguage(lang: string): string {
  const value = lang.trim().toLowerCase()
  if (value === 'text' || value === 'plaintext') return 'plaintext'
  if (value === 'html') return 'xml'
  return LANGUAGE_ALIASES[value] ?? value
}

function formatDisplayLanguage(language: string): string {
  if (!language) return 'text'
  return DISPLAY_LANGUAGE_ALIASES[language] ?? language
}

function getMarkdownWrapStateKey(text: string, compact: boolean): string {
  return `${compact ? 'compact' : 'regular'}:${text.length}:${hashString(text)}`
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function getCodeCustomStyle(wrapLines: boolean): CSSProperties {
  return {
    ...codeCustomStyle,
    overflowX: 'visible',
    whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
    wordBreak: wrapLines ? 'break-word' : 'normal',
    overflowWrap: wrapLines ? 'anywhere' : 'normal',
  }
}

function getCodeTagProps(wrapLines: boolean): HTMLProps<HTMLElement> {
  return {
    className: 'select-text',
    style: {
      fontFamily: CODE_FONT_FAMILY,
      background: 'transparent',
      color: '#abb2bf',
      display: 'block',
      overflowX: 'visible',
      padding: 0,
      whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
      wordBreak: wrapLines ? 'break-word' : 'normal',
      overflowWrap: wrapLines ? 'anywhere' : 'normal',
    },
  }
}

async function copyCodeText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}
