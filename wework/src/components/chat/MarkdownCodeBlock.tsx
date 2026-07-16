import { useState } from 'react'
import type { CSSProperties, HTMLProps, ReactNode } from 'react'
import { ArrowRightToLine, Copy, CopyCheck, TextWrap } from 'lucide-react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import less from 'react-syntax-highlighter/dist/esm/languages/prism/less'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import shellSession from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('diff', diff)
SyntaxHighlighter.registerLanguage('docker', docker)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('ini', ini)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('less', less)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('scss', scss)
SyntaxHighlighter.registerLanguage('shell-session', shellSession)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('yaml', yaml)

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  cmd: 'bash',
  dockerfile: 'docker',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

const DISPLAY_LANGUAGE_ALIASES: Record<string, string> = {
  markdown: 'md',
}

const CODE_ACTION_BUTTON_CLASS =
  'flex h-7 w-7 select-none items-center justify-center rounded-md text-[#b8c0cc] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25'

const CODE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

const codeCustomStyle: CSSProperties = {
  margin: 0,
  padding: '0.75rem 1rem',
  background: 'transparent',
  fontSize: '0.8125rem',
  lineHeight: '1.6',
}

const markdownWrapStateByKey = new Map<string, boolean>()

interface MarkdownCodeBlockProps {
  lang?: string
  children: ReactNode
  compact?: boolean
}

export function MarkdownCodeBlock({
  lang = '',
  children,
  compact = false,
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
  const lineProps = getLineProps(effectiveWrapLines)

  const handleCopy = async () => {
    await copyCodeText(text)
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
        'max-w-full select-none overflow-hidden rounded-lg border border-[#3c424a] bg-[#2f2f2f] text-left shadow-sm',
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
      <div
        data-testid="markdown-code-scroll-container"
        data-wrap={effectiveWrapLines ? 'true' : 'false'}
        className={
          effectiveWrapLines
            ? 'max-w-full select-none overflow-x-hidden'
            : 'max-w-full select-none overflow-x-auto'
        }
      >
        <SyntaxHighlighter
          language={language || 'text'}
          style={oneDark}
          customStyle={codeStyle}
          codeTagProps={codeProps}
          lineProps={lineProps}
          PreTag="div"
          showLineNumbers={false}
          wrapLines={effectiveWrapLines}
          wrapLongLines={effectiveWrapLines}
        >
          {text}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}

function normalizeLanguage(lang: string): string {
  const value = lang.trim().toLowerCase()
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
    overflowX: wrapLines ? 'hidden' : 'auto',
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
      whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
      wordBreak: wrapLines ? 'break-word' : 'normal',
      overflowWrap: wrapLines ? 'anywhere' : 'normal',
    },
  }
}

function getLineProps(wrapLines: boolean): HTMLProps<HTMLElement> | undefined {
  if (!wrapLines) return undefined

  return {
    style: {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflowWrap: 'anywhere',
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
