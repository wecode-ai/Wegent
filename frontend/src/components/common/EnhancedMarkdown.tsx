// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { memo, useMemo, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import dynamic from 'next/dynamic'
import type { Components } from 'react-markdown'
import katex from 'katex'
import { Check, Copy, Code, ChevronDown, ChevronUp } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { SourceReference } from '@/types/socket'

import 'katex/dist/katex.min.css'

// Dynamically import MermaidDiagram to avoid SSR issues
const MermaidDiagram = dynamic(() => import('./MermaidDiagram'), {
  ssr: false,
  loading: () => (
    <div className="my-4 p-8 rounded-lg border border-border bg-surface flex items-center justify-center">
      <div className="flex items-center gap-3 text-text-secondary">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
        <span className="text-sm">Loading diagram...</span>
      </div>
    </div>
  ),
})

interface EnhancedMarkdownProps {
  source: string
  theme: 'light' | 'dark'
  /** Custom components to override default rendering */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: Record<string, React.ComponentType<any>>
  /** Source references for citation markers */
  sources?: SourceReference[]
  /** Callback when a citation marker is clicked */
  onCitationClick?: (index: number, sources: SourceReference[]) => void
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
            <Code className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{showSource ? 'Hide' : 'Source'}</span>
            {showSource ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {/* Copy Button */}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            title={copied ? 'Copied!' : 'Copy LaTeX code'}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-500" />
                <span className="hidden sm:inline text-green-500">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
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
 * Component to render code blocks with syntax highlighting and copy functionality
 * Includes toolbar with language label and copy button
 */
interface CodeBlockProps {
  language: string
  code: string
  theme: 'light' | 'dark'
}

function CodeBlock({ language, code, theme }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }, [code])

  // Map common language aliases to syntax highlighter language names
  const normalizeLanguage = (lang: string): string => {
    const languageMap: Record<string, string> = {
      js: 'javascript',
      ts: 'typescript',
      py: 'python',
      rb: 'ruby',
      sh: 'bash',
      shell: 'bash',
      zsh: 'bash',
      yml: 'yaml',
      md: 'markdown',
      dockerfile: 'docker',
      plaintext: 'text',
      txt: 'text',
    }
    return languageMap[lang.toLowerCase()] || lang.toLowerCase()
  }

  const normalizedLanguage = normalizeLanguage(language)
  const displayLanguage = language || 'text'

  return (
    <div className="group my-4 rounded-lg border border-border bg-surface overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-hover/50 border-b border-border">
        <div className="flex items-center gap-2">
          <Code className="w-3.5 h-3.5 text-text-secondary" />
          <span className="text-xs font-medium text-text-secondary">{displayLanguage}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* Copy Button */}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            title={copied ? 'Copied!' : 'Copy code'}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-500" />
                <span className="hidden sm:inline text-green-500">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code Content with Syntax Highlighting */}
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={normalizedLanguage}
          style={theme === 'dark' ? oneDark : oneLight}
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.875rem',
            lineHeight: '1.5',
          }}
          codeTagProps={{
            style: {
              fontFamily:
                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
            },
          }}
          showLineNumbers={code.split('\n').length > 3}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: theme === 'dark' ? '#6b7280' : '#9ca3af',
            userSelect: 'none',
          }}
          wrapLines={true}
          wrapLongLines={false}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}

/**
 * Check if the content contains LaTeX math formulas
 * Supports: $...$, $$...$$, \[...\], \(...\), \begin{...}...\end{...}, ```latex code blocks
 */
function containsMathFormulas(text: string): boolean {
  // Check for inline math: $...$
  const inlineMathRegex = /\$[^$\n]+\$/
  // Check for block math: $$...$$
  const blockMathRegex = /\$\$[\s\S]+?\$\$/
  // Check for display math: \[...\]
  const displayMathRegex = /\\\[[\s\S]+?\\\]/
  // Check for inline math: \(...\)
  const inlineParenMathRegex = /\\\([\s\S]+?\\\)/
  // Check for LaTeX environments: \begin{...}...\end{...}
  const latexEnvRegex = /\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/
  // Check for latex code blocks: ```latex
  const latexCodeBlockRegex = /```latex\s*\n/

  return (
    inlineMathRegex.test(text) ||
    blockMathRegex.test(text) ||
    displayMathRegex.test(text) ||
    inlineParenMathRegex.test(text) ||
    latexEnvRegex.test(text) ||
    latexCodeBlockRegex.test(text)
  )
}
/**
 * Pre-process LaTeX syntax to convert \[...\] and \(...\) to $$...$$ and $...$
 * This is necessary because Markdown parsers escape backslashes, so \[ becomes [
 * By converting to dollar syntax first, we ensure proper math rendering
 */
function preprocessLatexSyntax(text: string): string {
  // Convert \[...\] to $$...$$ (display math)
  // Use a regex that matches \[ followed by content and \]
  let result = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, content) => {
    return `$$${content}$$`
  })

  // Convert \(...\) to $...$ (inline math)
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, content) => {
    return `$${content}$`
  })

  return result
}

/**
 * Parse text and replace citation markers [n] with clickable buttons
 * Only replaces markers that have a corresponding source reference
 */
function parseCitations(
  text: string,
  sources: SourceReference[] | undefined,
  onCitationClick?: (index: number, sources: SourceReference[]) => void
): React.ReactNode {
  if (!sources || sources.length === 0 || !onCitationClick) {
    return text
  }

  // Get all valid indices from sources
  const validIndices = new Set(sources.map(s => s.index))

  // Pattern to match citation markers like [1], [2], [12], etc.
  const citationPattern = /\[(\d+)\]/g

  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match
  let hasMatches = false

  while ((match = citationPattern.exec(text)) !== null) {
    const citationIndex = parseInt(match[1], 10)

    // Only create a clickable link if this index exists in sources
    if (validIndices.has(citationIndex)) {
      hasMatches = true

      // Add text before the citation
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index))
      }

      // Add the clickable citation button
      parts.push(
        <button
          key={`citation-${match.index}-${citationIndex}`}
          onClick={() => onCitationClick(citationIndex, sources)}
          className="inline-flex items-center justify-center font-mono text-xs text-primary hover:text-primary-dark hover:bg-primary/10 px-0.5 rounded cursor-pointer transition-colors"
          title={sources.find(s => s.index === citationIndex)?.title || `Reference ${citationIndex}`}
        >
          [{citationIndex}]
        </button>
      )

      lastIndex = match.index + match[0].length
    }
  }

  // If no citations were found, return plain text
  if (!hasMatches) {
    return text
  }

  // Add remaining text after the last citation
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <>{parts}</>
}

/**
 * Process React children to parse citation markers in text nodes
 */
function processChildrenForCitations(
  children: React.ReactNode,
  sources: SourceReference[] | undefined,
  onCitationClick?: (index: number, sources: SourceReference[]) => void
): React.ReactNode {
  if (!sources || sources.length === 0 || !onCitationClick) {
    return children
  }

  return React.Children.map(children, child => {
    if (typeof child === 'string') {
      return parseCitations(child, sources, onCitationClick)
    }
    return child
  })
}

/**
 * Enhanced Markdown renderer with Mermaid diagram and LaTeX math formula support
 *
 * Detects ```mermaid code blocks and renders them using MermaidDiagram component.
 * Supports LaTeX math formulas with $...$ for inline and $$...$$ for block math.
 * Also supports \[...\] and \(...\) syntax by converting them to dollar syntax.
 * All other markdown is rendered using react-markdown with remark/rehype plugins.
 */
export const EnhancedMarkdown = memo(function EnhancedMarkdown({
  source,
  theme,
  components,
  sources,
  onCitationClick,
}: EnhancedMarkdownProps) {
  // Pre-process source to convert \[...\] and \(...\) to dollar syntax
  const processedSource = useMemo(() => preprocessLatexSyntax(source), [source])

  // Check if source contains math formulas
  const hasMath = useMemo(() => containsMathFormulas(processedSource), [processedSource])

  // Parse the source to extract mermaid blocks, latex blocks, and regular content
  const contentParts = useMemo(() => {
    const parts: Array<{ type: 'markdown' | 'mermaid' | 'latex'; content: string }> = []
    // Combined regex to match both mermaid and latex code blocks
    const specialBlockRegex = /```(mermaid|latex)\s*\n([\s\S]*?)```/g

    let lastIndex = 0
    let match

    while ((match = specialBlockRegex.exec(processedSource)) !== null) {
      // Add markdown content before this special block
      if (match.index > lastIndex) {
        const markdownContent = processedSource.slice(lastIndex, match.index)
        if (markdownContent.trim()) {
          parts.push({ type: 'markdown', content: markdownContent })
        }
      }

      // Add the special block (mermaid or latex)
      const blockType = match[1] as 'mermaid' | 'latex'
      const blockCode = match[2].trim()
      if (blockCode) {
        parts.push({ type: blockType, content: blockCode })
      }

      lastIndex = match.index + match[0].length
    }

    // Add remaining markdown content after the last special block
    if (lastIndex < processedSource.length) {
      const remainingContent = processedSource.slice(lastIndex)
      if (remainingContent.trim()) {
        parts.push({ type: 'markdown', content: remainingContent })
      }
    }

    // If no special blocks found, return the entire source as markdown
    if (parts.length === 0 && processedSource.trim()) {
      parts.push({ type: 'markdown', content: processedSource })
    }

    return parts
  }, [processedSource])

  // Default components with link handling and code block rendering
  const defaultComponents = useMemo(
    (): Components => ({
      a: ({ href, children, ...props }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      ),
      // Custom code block rendering with syntax highlighting
      code: ({ className, children, ...props }) => {
        // Check if this is an inline code or a code block
        // Code blocks are wrapped in <pre> and have a className with language
        const match = /language-(\w+)/.exec(className || '')
        const isInline = !match && !className?.includes('language-')

        // For inline code, render as simple <code> element
        if (isInline) {
          return (
            <code
              className="px-1.5 py-0.5 rounded bg-surface-hover text-text-primary font-mono text-sm"
              {...props}
            >
              {children}
            </code>
          )
        }

        // For code blocks, extract language and code content
        const language = match ? match[1] : ''
        const codeString = String(children).replace(/\n$/, '')

        return <CodeBlock language={language} code={codeString} theme={theme} />
      },
      // Override pre to avoid double wrapping
      pre: ({ children }) => <>{children}</>,
      // Process paragraph children for citation markers
      p: ({ children, ...props }) => (
        <p {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</p>
      ),
      // Process list item children for citation markers
      li: ({ children, ...props }) => (
        <li {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</li>
      ),
      // Process heading children for citation markers
      h1: ({ children, ...props }) => (
        <h1 {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</h1>
      ),
      h2: ({ children, ...props }) => (
        <h2 {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</h2>
      ),
      h3: ({ children, ...props }) => (
        <h3 {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</h3>
      ),
      h4: ({ children, ...props }) => (
        <h4 {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</h4>
      ),
      h5: ({ children, ...props }) => (
        <h5 {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</h5>
      ),
      h6: ({ children, ...props }) => (
        <h6 {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</h6>
      ),
      // Process blockquote children for citation markers
      blockquote: ({ children, ...props }) => (
        <blockquote {...props}>
          {processChildrenForCitations(children, sources, onCitationClick)}
        </blockquote>
      ),
      // Process table cell children for citation markers
      td: ({ children, ...props }) => (
        <td {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</td>
      ),
      th: ({ children, ...props }) => (
        <th {...props}>{processChildrenForCitations(children, sources, onCitationClick)}</th>
      ),
      ...components,
    }),
    [components, theme, sources, onCitationClick]
  )

  // Configure remark/rehype plugins based on content
  const remarkPlugins = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugins: any[] = [remarkGfm]
    if (hasMath) {
      // Enable singleDollarTextMath to support $...$ inline math
      plugins.push([remarkMath, { singleDollarTextMath: true }])
    }
    return plugins
  }, [hasMath])

  const rehypePlugins = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugins: any[] = []
    // rehypeKatex must come before rehypeRaw to properly render math formulas
    if (hasMath) {
      // Configure rehypeKatex with strict: false to handle edge cases
      plugins.push([
        rehypeKatex,
        {
          strict: false,
          throwOnError: false,
        },
      ])
    }
    plugins.push(rehypeRaw)
    return plugins
  }, [hasMath])

  // Render markdown content
  const renderMarkdown = (content: string) => (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={defaultComponents}
    >
      {content}
    </ReactMarkdown>
  )

  // If no special blocks, render normally
  if (contentParts.length === 1 && contentParts[0].type === 'markdown') {
    return (
      <div className="wmde-markdown markdown-content" data-color-mode={theme}>
        {renderMarkdown(processedSource)}
      </div>
    )
  }

  // Render mixed content with mermaid diagrams and latex blocks
  return (
    <div className="wmde-markdown enhanced-markdown" data-color-mode={theme}>
      {contentParts.map((part, index) => {
        if (part.type === 'mermaid') {
          return <MermaidDiagram key={`mermaid-${index}`} code={part.content} />
        }

        if (part.type === 'latex') {
          return <LaTeXBlock key={`latex-${index}`} code={part.content} />
        }

        return (
          <div key={`markdown-${index}`} className="markdown-content">
            {renderMarkdown(part.content)}
          </div>
        )
      })}
    </div>
  )
})

export default EnhancedMarkdown
