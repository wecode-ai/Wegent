import { useMarkdownServices } from './MarkdownServices'
import { memo, useState } from 'react'
import { useCodeHighlight } from './useCodeHighlight'
import { codeThemeCSS } from './codeTheme'
import type { CSSProperties, HTMLProps, ReactNode } from 'react'
import { ArrowRightToLine, Copy, CopyCheck, TextWrap } from 'lucide-react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import type { HighlightedCode } from './highlightCode'

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  cmd: 'shell',
  docker: 'dockerfile',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'shell',
  'shell-session': 'shell',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'shell',
}

const DISPLAY_LANGUAGE_ALIASES: Record<string, string> = {
  markdown: 'md',
}

const CODE_ACTION_BUTTON_CLASS =
  'flex h-7 w-7 select-none items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25'

const CODE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

const codeCustomStyle: CSSProperties = {
  margin: 0,
  padding: '0.75rem 1rem',
  background: 'transparent',
  color: 'rgb(var(--color-text-primary))',
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
  const { copyText, onCopy, translate: t, theme } = useMarkdownServices()
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
  const wrapButtonLabel = effectiveWrapLines ? t('code.wrap_off') : t('code.wrap_on')
  const codeStyle = getCodeCustomStyle(effectiveWrapLines)
  const codeProps = getCodeTagProps(effectiveWrapLines)
  const highlightedCode = useCodeHighlight(text, language)
  const highlightedPrefix =
    highlightedCode && text.startsWith(highlightedCode.code) ? highlightedCode : null

  const handleCopy = async () => {
    await copyText(text)
    onCopy?.()
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
      data-theme={theme === 'system' ? undefined : theme}
      data-scroll-anchor
      className={[
        'markdown-code-block pierre-code-block max-w-full select-none overflow-hidden rounded-lg border border-border bg-background text-left shadow-sm',
        compact ? 'mb-1.5' : 'mb-3 mt-2',
      ].join(' ')}
    >
      <div className="flex h-10 select-none items-center justify-between border-b border-border px-3">
        <span
          data-testid="markdown-code-block-language"
          className="select-none text-xs font-medium text-text-secondary"
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
            aria-label={t('code.copy')}
            title={t('code.copy')}
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
        <style data-pierre-code-theme>{codeThemeCSS}</style>
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
          className="relative self-stretch rounded-full bg-text-muted hover:bg-text-secondary"
        />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  )
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
      color: 'rgb(var(--color-text-primary))',
      display: 'block',
      overflowX: 'visible',
      padding: 0,
      whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
      wordBreak: wrapLines ? 'break-word' : 'normal',
      overflowWrap: wrapLines ? 'anywhere' : 'normal',
    },
  }
}
