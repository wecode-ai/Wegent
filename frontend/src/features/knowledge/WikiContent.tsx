// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { WikiContent as WikiContentType } from '@/types/wiki'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import katex from 'katex'

import 'katex/dist/katex.min.css'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { ReactNode, useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { HTMLAttributes } from 'react'
import { CheckIcon, ClipboardIcon, ArrowsPointingOutIcon } from '@heroicons/react/24/outline'
import { DiagramModal } from './DiagramModal'
import { useTranslation } from '@/hooks/useTranslation'

interface MarkdownComponentProps extends HTMLAttributes<HTMLElement> {
  node?: unknown
  className?: string
  children?: ReactNode
}

interface WikiContentProps {
  content: WikiContentType | null
  loading: boolean
  error: string | null
}

/**
 * Copy button component for code blocks
 */
function CopyButton({
  code,
  copiedText,
  copyText,
}: {
  code: string
  copiedText: string
  copyText: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [code])

  return (
    <button
      onClick={handleCopy}
      className="absolute top-3 right-3 p-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-all duration-200 opacity-0 group-hover:opacity-100"
      title={copied ? copiedText : copyText}
    >
      {copied ? (
        <CheckIcon className="w-4 h-4 text-green-400" />
      ) : (
        <ClipboardIcon className="w-4 h-4" />
      )}
    </button>
  )
}

/**
 * Language badge component for code blocks
 */
function LanguageBadge({ language }: { language: string }) {
  const displayName: Record<string, string> = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    java: 'Java',
    go: 'Go',
    rust: 'Rust',
    cpp: 'C++',
    c: 'C',
    csharp: 'C#',
    ruby: 'Ruby',
    php: 'PHP',
    swift: 'Swift',
    kotlin: 'Kotlin',
    scala: 'Scala',
    bash: 'Bash',
    shell: 'Shell',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    json: 'JSON',
    yaml: 'YAML',
    xml: 'XML',
    markdown: 'Markdown',
    dockerfile: 'Dockerfile',
    graphql: 'GraphQL',
  }

  return (
    <span className="absolute top-0 left-4 px-2 py-0.5 text-xs font-medium bg-primary/80 text-white rounded-b-md shadow-sm">
      {displayName[language.toLowerCase()] || language.toUpperCase()}
    </span>
  )
}

/**
 * Mermaid diagram container component with click-to-zoom
 */
function MermaidDiagram({
  children,
  diagramText,
  clickToExpandText,
}: {
  children: ReactNode
  diagramText: string
  clickToExpandText: string
}) {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [diagramHtml, setDiagramHtml] = useState('')
  const diagramRef = useRef<HTMLDivElement>(null)

  // Capture rendered SVG for modal display
  const handleOpenModal = useCallback(() => {
    if (diagramRef.current) {
      const svgElement = diagramRef.current.querySelector('svg')
      if (svgElement) {
        setDiagramHtml(svgElement.outerHTML)
        setIsModalOpen(true)
      }
    }
  }, [])

  return (
    <>
      <div
        className="group my-8 rounded-xl overflow-hidden border border-border/50 shadow-lg bg-gradient-to-b from-white to-slate-50 dark:from-slate-900 dark:to-slate-800 cursor-pointer hover:shadow-xl transition-shadow duration-300"
        onClick={handleOpenModal}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-gradient-to-r from-primary/10 to-transparent border-b border-border/30">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-primary"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <span className="text-xs font-medium text-text-secondary">{diagramText}</span>
          </div>
          {/* Expand button hint */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-primary/10 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <ArrowsPointingOutIcon className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium text-primary">{clickToExpandText}</span>
          </div>
        </div>
        {/* Diagram content */}
        <div className="p-6 flex justify-center items-center min-h-[200px]">
          <div
            ref={diagramRef}
            className="mermaid w-full max-w-full overflow-auto"
            style={{
              backgroundColor: 'transparent',
            }}
          >
            {children}
          </div>
        </div>
      </div>

      {/* Fullscreen modal */}
      <DiagramModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        diagramContent={diagramHtml}
        title={diagramText}
      />
    </>
  )
}
/**
 * Parse LaTeX code and extract individual formulas
 * Handles multiple $$...$$, \[...\], and standalone formulas
 * Also removes LaTeX comments (lines starting with %)
 */
function parseLatexFormulas(code: string): string[] {
  const formulas: string[] = []
  // Remove LaTeX comments (lines starting with %)
  const codeWithoutComments = code
    .split('\n')
    .filter(line => !line.trim().startsWith('%'))
    .join('\n')
    .trim()

  // Match all $$...$$ blocks
  const dollarBlockRegex = /\$\$([\s\S]*?)\$\$/g
  // Match all \[...\] blocks
  const bracketBlockRegex = /\\\[([\s\S]*?)\\\]/g

  let match
  let hasMatches = false

  // Extract $$...$$ blocks
  while ((match = dollarBlockRegex.exec(codeWithoutComments)) !== null) {
    hasMatches = true
    const formula = match[1].trim()
    if (formula) {
      formulas.push(formula)
    }
  }

  // Extract \[...\] blocks
  while ((match = bracketBlockRegex.exec(codeWithoutComments)) !== null) {
    hasMatches = true
    const formula = match[1].trim()
    if (formula) {
      formulas.push(formula)
    }
  }

  // If no blocks found, treat the entire content as a single formula
  if (!hasMatches && codeWithoutComments) {
    formulas.push(codeWithoutComments)
  }

  return formulas
}

/**
 * Component to render LaTeX code blocks using KaTeX
 * Supports multiple formulas separated by $$...$$ blocks
 * Includes toolbar with copy and view source functionality
 */
function LaTeXBlock({ code }: { code: string }) {
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const formulas = useMemo(() => parseLatexFormulas(code), [code])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy LaTeX code:', err)
    }
  }, [code])

  const toggleSource = useCallback(() => {
    setShowSource(prev => !prev)
  }, [])

  const renderedFormulas = useMemo(() => {
    return formulas.map((formula, index) => {
      try {
        return {
          html: katex.renderToString(formula, {
            displayMode: true,
            throwOnError: false,
            strict: false,
          }),
          error: null,
          key: index,
        }
      } catch (error) {
        console.error('KaTeX rendering error:', error)
        return {
          html: `<span class="text-red-500">LaTeX Error: ${error instanceof Error ? error.message : 'Unknown error'}</span>`,
          error: error,
          key: index,
        }
      }
    })
  }, [formulas])

  return (
    <div className="group my-4 rounded-lg border border-border bg-surface overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-hover/50 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">LaTeX</span>
        </div>
        <div className="flex items-center gap-1">
          {/* View Source Button */}
          <button
            onClick={toggleSource}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            title={showSource ? 'Hide source' : 'View source'}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
            <span className="hidden sm:inline">{showSource ? 'Hide' : 'Source'}</span>
            {showSource ? (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 15l7-7 7 7"
                />
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            )}
          </button>
          {/* Copy Button */}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            title={copied ? 'Copied!' : 'Copy LaTeX code'}
          >
            {copied ? (
              <>
                <CheckIcon className="w-3.5 h-3.5 text-green-500" />
                <span className="hidden sm:inline text-green-500">Copied</span>
              </>
            ) : (
              <>
                <ClipboardIcon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Source Code (collapsible) */}
      {showSource && (
        <div className="px-4 py-3 bg-slate-50 dark:bg-slate-900/50 border-b border-border">
          <pre className="text-sm font-mono text-text-primary whitespace-pre-wrap break-words overflow-x-auto">
            {code}
          </pre>
        </div>
      )}

      {/* Rendered Formulas */}
      <div className="px-4 py-3">
        {renderedFormulas.map(item => (
          <div
            key={item.key}
            className="katex-display overflow-x-auto"
            dangerouslySetInnerHTML={{ __html: item.html }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Code block container component
 */
function CodeBlock({
  language,
  code,
  copiedText,
  copyText,
}: {
  language: string
  code: string
  copiedText: string
  copyText: string
}) {
  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    // Check if dark mode
    const checkDarkMode = () => {
      const isDarkMode = document.documentElement.classList.contains('dark')
      setIsDark(isDarkMode)
    }

    checkDarkMode()

    // Listen for theme changes
    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => observer.disconnect()
  }, [])

  return (
    <div className="group relative my-6 rounded-xl overflow-hidden shadow-lg border border-border/50">
      {/* Language badge */}
      <LanguageBadge language={language} />

      {/* Code container with gradient background */}
      <div
        className="relative"
        style={{
          background: isDark
            ? 'linear-gradient(180deg, #1a1b26 0%, #16161e 100%)'
            : 'linear-gradient(180deg, #fafafa 0%, #f5f5f5 100%)',
        }}
      >
        {/* Copy button */}
        <CopyButton code={code} copiedText={copiedText} copyText={copyText} />

        {/* Syntax highlighted code */}
        <div className="pt-8 pb-4 px-4 overflow-auto">
          <SyntaxHighlighter
            language={language}
            style={isDark ? oneDark : oneLight}
            customStyle={{
              margin: 0,
              padding: 0,
              background: 'transparent',
              fontSize: '0.875rem',
              lineHeight: '1.7',
            }}
            showLineNumbers={true}
            lineNumberStyle={{
              minWidth: '2.5em',
              paddingRight: '1em',
              color: isDark ? '#565f89' : '#9ca3af',
              userSelect: 'none',
            }}
            wrapLines={true}
            wrapLongLines={false}
          >
            {code}
          </SyntaxHighlighter>
        </div>

        {/* Bottom gradient fade */}
        <div
          className="absolute bottom-0 left-0 right-0 h-4 pointer-events-none"
          style={{
            background: isDark
              ? 'linear-gradient(to top, #16161e, transparent)'
              : 'linear-gradient(to top, #f5f5f5, transparent)',
          }}
        />
      </div>
    </div>
  )
}

/**
 * Wiki content rendering component
 * Encapsulates complex ReactMarkdown config and custom components
 */
export function WikiContent({ content, loading, error }: WikiContentProps) {
  const { t } = useTranslation()

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="relative">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary/20 border-t-primary"></div>
        </div>
        <p className="mt-4 text-sm text-text-secondary">{t('knowledge:loading_content')}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-4 rounded-lg border border-red-200 dark:border-red-800">
        <svg
          className="w-5 h-5 flex-shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>{error}</span>
      </div>
    )
  }

  if (!content) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-text-secondary">
        <svg
          className="w-16 h-16 mb-4 opacity-30"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p className="text-lg font-medium">{t('knowledge:select_content')}</p>
        <p className="text-sm mt-1">{t('knowledge:select_content_hint')}</p>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Content card */}
      <article className="bg-base rounded-2xl shadow-sm border border-border/30 overflow-hidden">
        {/* Header with gradient */}
        <div className="px-8 py-6 bg-gradient-to-r from-primary/5 to-transparent border-b border-border/30">
          <h1 className="text-2xl font-bold text-text-primary">{content.title}</h1>
        </div>

        {/* Content body */}
        <div className="px-8 py-6">
          <div className="prose prose-base max-w-none dark:prose-invert wiki-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
              rehypePlugins={[rehypeKatex, rehypeRaw]}
              components={{
                // Table components
                table: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <div className="overflow-x-auto my-6 rounded-lg border border-border shadow-sm">
                    <table className="min-w-full divide-y divide-border" {...props} />
                  </div>
                ),
                thead: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <thead className="bg-surface/70" {...props} />
                ),
                tr: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <tr
                    className="hover:bg-surface-hover/50 transition-colors duration-150"
                    {...props}
                  />
                ),
                td: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <td
                    className="px-4 py-3 border-b border-border/50 text-sm"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                th: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <th
                    className="px-4 py-3 border-b border-border font-semibold text-left text-sm"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                // Blockquote component - callout style
                blockquote: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <blockquote
                    className="relative my-6 pl-6 pr-4 py-4 bg-gradient-to-r from-primary/5 to-transparent border-l-4 border-primary rounded-r-lg"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                // List components
                ul: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <ul
                    className="list-none pl-0 my-5 space-y-2"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                ol: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <ol
                    className="list-decimal pl-6 my-5 space-y-2"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                li: ({ node: _node, children, ...props }: MarkdownComponentProps) => (
                  <li
                    className="relative pl-6 my-1.5"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  >
                    <span className="absolute left-0 top-2 w-1.5 h-1.5 rounded-full bg-primary/60" />
                    {children}
                  </li>
                ),
                // Horizontal rule component
                hr: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <hr
                    className="my-10 border-0 h-px bg-gradient-to-r from-transparent via-border to-transparent"
                    {...props}
                  />
                ),
                // Heading components with anchor links
                h1: ({ node: _node, children, ...props }: MarkdownComponentProps) => (
                  <h1
                    className="text-2xl font-bold mt-12 mb-4 pb-3 border-b border-border/50 flex items-center gap-2 group"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  >
                    {children}
                  </h1>
                ),
                h2: ({ node: _node, children, ...props }: MarkdownComponentProps) => (
                  <h2
                    className="text-xl font-bold mt-10 mb-4 pb-2 border-b border-border/30 flex items-center gap-2 group"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  >
                    <span className="w-1 h-6 bg-primary rounded-full mr-2" />
                    {children}
                  </h2>
                ),
                h3: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <h3
                    className="text-lg font-semibold mt-8 mb-3 flex items-center gap-2"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                h4: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <h4
                    className="text-base font-semibold mt-6 mb-2"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                h5: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <h5
                    className="text-base font-medium mt-4 mb-2"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                h6: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <h6 className="text-sm font-medium mt-4 mb-2 text-text-secondary" {...props} />
                ),
                // Paragraph component
                p: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <p
                    className="my-4 leading-7 text-base"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                // Link component
                a: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <a
                    className="text-primary hover:text-primary-hover font-medium underline decoration-primary/30 underline-offset-2 hover:decoration-primary transition-colors duration-200"
                    target="_blank"
                    rel="noopener noreferrer"
                    {...props}
                  />
                ),
                // Image component
                img: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="max-w-full my-6 rounded-xl border border-border shadow-md hover:shadow-lg transition-shadow duration-300"
                    alt=""
                    {...props}
                  />
                ),
                // Emphasis components
                em: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <em className="italic text-text-secondary" {...props} />
                ),
                strong: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <strong
                    className="font-semibold"
                    style={{ color: 'var(--text-primary)' }}
                    {...props}
                  />
                ),
                del: ({ node: _node, ...props }: MarkdownComponentProps) => (
                  <del className="line-through text-text-muted" {...props} />
                ),
                // Code component - handles inline code, mermaid, and code blocks
                code: ({ node: _node, className, children, ...props }: MarkdownComponentProps) => {
                  const isInline = !className

                  // Inline code
                  if (isInline) {
                    return (
                      <code
                        className="px-1.5 py-0.5 mx-0.5 rounded-md text-sm font-mono bg-primary/10 text-primary border border-primary/20"
                        {...props}
                      >
                        {children}
                      </code>
                    )
                  }

                  // Mermaid diagrams
                  if (className === 'language-mermaid') {
                    return (
                      <MermaidDiagram
                        diagramText={t('knowledge:diagram')}
                        clickToExpandText={t('knowledge:click_to_expand')}
                      >
                        {children}
                      </MermaidDiagram>
                    )
                  }

                  // LaTeX code blocks - render as math formulas
                  if (className === 'language-latex') {
                    const latexCode = String(children).replace(/\n$/, '')
                    return <LaTeXBlock code={latexCode} />
                  }

                  // Code blocks
                  const match = /language-(\w+)/.exec(className || '')
                  if (match) {
                    let language = match[1]
                    const codeContent = String(children).replace(/\n$/, '')

                    // Language mapping
                    const languageMap: Record<string, string> = {
                      js: 'javascript',
                      ts: 'typescript',
                      py: 'python',
                      rb: 'ruby',
                      sh: 'bash',
                      shell: 'bash',
                      yml: 'yaml',
                    }

                    if (languageMap[language.toLowerCase()]) {
                      language = languageMap[language.toLowerCase()]
                    }

                    return (
                      <CodeBlock
                        language={language}
                        code={codeContent}
                        copiedText={t('knowledge:copied')}
                        copyText={t('knowledge:copy_code')}
                      />
                    )
                  }

                  return (
                    <code
                      className="px-1.5 py-0.5 rounded-md text-sm font-mono bg-surface border border-border"
                      style={{ color: 'var(--text-primary)' }}
                      {...props}
                    >
                      {children}
                    </code>
                  )
                },
              }}
            >
              {content?.content?.replace(/^# .*?\n/, '').trim()}
            </ReactMarkdown>
          </div>
        </div>
      </article>
    </div>
  )
}
