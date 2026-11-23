import { math } from '@streamdown/math'
import type { Element } from 'hast'
import 'katex/dist/katex.min.css'
import { FileReferenceIcon } from '../composer/FileReferenceIcon'
import { MarkdownLinkScope } from './markdownLinkScope'
import { Fragment, createContext, memo, useContext, useMemo } from 'react'
import type { HTMLAttributes, OlHTMLAttributes, ReactNode } from 'react'
import { Folder, Link2 } from 'lucide-react'
import { Streamdown, defaultRemarkPlugins, type ExtraProps, type StreamdownProps } from 'streamdown'
import remarkBreaks from 'remark-breaks'
import 'streamdown/styles.css'
import { Tooltip } from "../controls/Tooltip"
import { AssistantFollowup } from './AssistantFollowup'
import { AssistantMarkdownImage } from './AssistantMarkdownImage'
import { Button as ControlButton } from './Button'
import { ComposerLinkChip } from './ComposerLinkChip'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'
import { MarkdownDiagramPreview } from './MarkdownDiagramPreview'
import { useMarkdownServices, type MarkdownFileOpenOptions } from './MarkdownServices'
import { MarkdownTable } from './MarkdownTable'
import { WindowedMarkdownChunk } from './WindowedMarkdownChunk'
import {
  rehypeAssistantAnnotations,
  remarkAssistantAnnotations,
} from './assistantAnnotationMarkdown'
import {
  stripUnsupportedContentReferenceCitations,
  type AssistantFileCitation,
} from './assistantAnnotations'
import {
  classifyMarkdownLink,
  transformMarkdownUrl,
  type MarkdownLinkTarget,
} from './assistantMarkdownLinks'
import {
  hasMarkdownReferenceDefinitions,
  splitStaticMarkdownChunks,
} from './assistantMarkdownWindowing'
import { splitCodexInlineVisualizations } from './codex-directives'
import { protectComposerReferenceLinks } from './composerReferenceMarkdown'
import { diagramKind } from './diagramLayout'
import { getRecognizedLink } from './link-preview'
import { createTableMarkdownRehypePlugins } from './markdownTableSource'
import { preprocessCjkEmphasis } from './preprocessCjkEmphasis'
import { normalizeMathDelimiters, remarkMathDelimiters } from './remarkMathDelimiters'

const ASSISTANT_MARKDOWN_LINK_CLASS = [
  'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-0.5 align-baseline',
  'text-sm font-medium leading-5 text-blue-600 no-underline',
  'transition-colors hover:text-blue-700',
  'dark:text-blue-300 dark:hover:text-blue-200',
  '[&_code]:!rounded-none [&_code]:!bg-transparent [&_code]:!px-0 [&_code]:!py-0 [&_code]:!font-[inherit] [&_code]:!text-inherit',
].join(' ')
const CODEX_PLAN_TAG_PATTERN = /<\/?\s*proposed_plan\s*>/gi
const tableMarkdownRehypePlugins = [
  ...createTableMarkdownRehypePlugins()!,
  rehypeAssistantAnnotations,
]
const STREAMING_DIAGRAM_LANGUAGES = new Map([
  ['weworkstreamingmermaid', 'mermaid'],
  ['weworkstreamingmmd', 'mmd'],
  ['weworkstreamingplantuml', 'plantuml'],
  ['weworkstreamingpuml', 'puml'],
])
const MarkdownStreamingContext = createContext(false)
const completeMarkdownSource = (content: string) => [content]
const markdownPlugins = { math }

type MarkdownPositionedNode = { position?: { start?: { line?: number } } }

function sourceLineData(
  node: MarkdownPositionedNode | undefined,
  enabled: boolean
): { 'data-source-line'?: number } {
  if (!enabled) return {}
  const line = node?.position?.start?.line
  return typeof line === 'number' ? { 'data-source-line': line } : {}
}

export interface AssistantMarkdownProps {
  content: string
  isStreaming?: boolean
  preserveLineBreaks?: boolean
  variant?: 'default' | 'document' | 'process' | 'user'
  sourceLineAnchors?: boolean
  renderLink?: (href: string, text: string, children?: ReactNode) => ReactNode
  onOpenFile?: (path: string, options?: MarkdownFileOpenOptions) => void
  renderVisualization?: (part: { file: string; mode?: 'wide'; title?: string }) => ReactNode
}

const MarkdownCustomLinkContext = createContext<AssistantMarkdownProps['renderLink']>(undefined)
const MarkdownFileOpenContext = createContext<AssistantMarkdownProps['onOpenFile']>(undefined)

const MARKDOWN_HEADING_CLASSES = {
  default: {
    h1: 'mb-4 mt-6 text-lg font-medium text-text-primary',
    h2: 'mb-3 mt-5 text-base font-medium text-text-primary',
    h3: 'mb-2 mt-4 text-sm font-medium text-text-primary',
    h4: 'mb-2 mt-4 text-sm font-medium text-text-primary',
    h5: 'mb-2 mt-3 text-sm font-medium text-text-primary',
    h6: 'mb-2 mt-3 text-sm font-medium text-text-secondary',
  },
  document: {
    h1: 'mb-5 mt-8 text-heading-lg font-semibold tracking-[-0.02em] text-text-primary',
    h2: 'mb-4 mt-7 text-heading-md font-semibold tracking-[-0.01em] text-text-primary',
    h3: 'mb-3 mt-6 text-heading-sm font-semibold text-text-primary',
    h4: 'mb-2 mt-5 text-lg font-semibold text-text-primary',
    h5: 'mb-2 mt-4 text-base font-semibold text-text-primary',
    h6: 'mb-2 mt-4 text-sm font-semibold text-text-secondary',
  },
  process: {
    h1: 'mb-2 mt-3 text-base font-medium text-text-primary',
    h2: 'mb-1.5 mt-3 text-sm font-medium text-text-primary',
    h3: 'mb-1 mt-2 text-sm font-medium text-text-primary',
    h4: 'mb-1 mt-2 text-sm font-medium text-text-primary',
    h5: 'mb-1 mt-2 text-sm font-medium text-text-primary',
    h6: 'mb-1 mt-2 text-sm font-medium text-text-secondary',
  },
} as const

type AssistantMarkdownPart =
  | {
      kind: 'markdown'
      content: string
      windowed: boolean
      wholeSource: boolean
    }
  | { kind: 'visualization'; file: string; mode?: 'wide'; title?: string }

/** Renders assistant and user Markdown with shared link and diagram handling. */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  isStreaming = false,
  preserveLineBreaks = false,
  variant = 'default',
  sourceLineAnchors = false,
  onOpenFile,
  renderVisualization: renderVisualizationOverride,
  renderLink,
}: AssistantMarkdownProps) {
  const services = useMarkdownServices()
  const renderVisualization = renderVisualizationOverride ?? services.renderVisualization
  const streamdownMode =
    variant === 'default' || variant === 'process' || isStreaming
      ? ('streaming' as const)
      : ('static' as const)
  // Resolve opaque content markers before Streamdown splits paragraphs into
  // independent blocks; a marker may span more than one Markdown paragraph.
  const displayContent = useMemo(
    () =>
      preprocessCjkEmphasis(
        normalizeMathDelimiters(
          protectComposerReferenceLinks(
            variant === 'user'
              ? content
              : stripUnsupportedContentReferenceCitations(content)
          )
        )
      ),
    [content, variant]
  )
  // Only unfinished annotation syntax depends on the stream lifecycle. Plain text keeps
  // the same plugin identities so completed blocks retain their parsed trees.
  const annotationsStreaming =
    isStreaming && /:(?:codex-file-citation|codex-followup)[[{][^\n}]*$/.test(displayContent)
  const remarkPlugins = useMemo<StreamdownProps['remarkPlugins']>(() => {
    const plugins: NonNullable<StreamdownProps['remarkPlugins']> = [
      ...Object.values(defaultRemarkPlugins),
      remarkMathDelimiters,
    ]
    if (variant !== 'user')
      plugins.push([remarkAssistantAnnotations, { isStreaming: annotationsStreaming }])
    if (preserveLineBreaks) plugins.push(remarkBreaks)
    return plugins
  }, [variant, annotationsStreaming, preserveLineBreaks])
  const windowMarkdown = Boolean(services.windowMarkdown) && variant === 'default'
  const contentParts = useMemo(() => {
    const parts =
      variant === 'user' || !renderVisualization
        ? [{ kind: 'markdown' as const, content: displayContent }]
        : splitCodexInlineVisualizations(displayContent)
    return parts.flatMap<AssistantMarkdownPart>(part => {
      if (part.kind === 'visualization') return [part]
      const wholeSource = hasMarkdownReferenceDefinitions(part.content)
      const chunks =
        windowMarkdown && !wholeSource ? splitStaticMarkdownChunks(part.content) : [part.content]
      const windowed = windowMarkdown
      return chunks.map(content => ({
        kind: 'markdown',
        content,
        windowed,
        wholeSource,
      }))
    })
  }, [displayContent, windowMarkdown, variant, renderVisualization])
  const headingClasses = MARKDOWN_HEADING_CLASSES[variant === 'user' ? 'default' : variant]
  const components = useMemo(
    () => ({
      h1: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <h1
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={headingClasses.h1}
        >
          {children}
        </h1>
      ),
      h2: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <h2
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={headingClasses.h2}
        >
          {children}
        </h2>
      ),
      h3: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <h3
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={headingClasses.h3}
        >
          {children}
        </h3>
      ),
      h4: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <h4
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={headingClasses.h4}
        >
          {children}
        </h4>
      ),
      h5: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <h5
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={headingClasses.h5}
        >
          {children}
        </h5>
      ),
      h6: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <h6
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={headingClasses.h6}
        >
          {children}
        </h6>
      ),
      p: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <p
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={`${variant === 'process' ? 'mb-1.5' : variant === 'user' ? 'mb-2 whitespace-pre-wrap' : 'mb-3'} min-w-0 break-words ${variant === 'user' ? 'leading-5' : 'leading-6'}`}
        >
          {children}
        </p>
      ),
      ul: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <ul
          {...sourceLineData(node, sourceLineAnchors)}
          className={`${variant === 'process' ? 'mb-1.5 space-y-0.5' : 'mb-3 space-y-1.5'} list-disc pl-5`}
        >
          {children}
        </ul>
      ),
      ol: ({ children, start, node }: OlHTMLAttributes<HTMLOListElement> & ExtraProps) => (
        <ol
          start={start}
          {...sourceLineData(node, sourceLineAnchors)}
          className={`${variant === 'process' ? 'mb-1.5 space-y-0.5 pl-5' : 'mb-3 space-y-1.5 pl-8'} list-decimal`}
        >
          {children}
        </ol>
      ),
      li: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <li
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={`min-w-0 break-words ${variant === 'user' ? 'leading-5' : 'leading-6'} ${variant === 'process' ? '' : 'pl-1'}`}
        >
          {children}
        </li>
      ),
      strong: ({ children }: { children?: ReactNode }) => (
        <strong className={variant === 'document' ? 'font-semibold' : 'font-medium'}>
          {children}
        </strong>
      ),
      code: (props: MarkdownCodeProps) => (
        <MarkdownCode
          {...props}
          compact={variant === 'process'}
          sourceLineAnchors={sourceLineAnchors}
        />
      ),
      inlineCode: ({ children }: { children?: ReactNode }) => (
        <MarkdownInlineCode compact={variant === 'process'}>{children}</MarkdownInlineCode>
      ),
      blockquote: ({ children, node }: { children?: ReactNode } & ExtraProps) => (
        <blockquote
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className={`${variant === 'process' ? 'mb-1.5 pl-3 opacity-80' : 'mb-3 pl-4'} border-l-3 border-border text-text-secondary`}
        >
          {children}
        </blockquote>
      ),
      hr: ({ node }: ExtraProps) => (
        <hr
          data-scroll-anchor
          {...sourceLineData(node, sourceLineAnchors)}
          className="my-6 border-border"
        />
      ),
      table: (props: Parameters<typeof MarkdownTable>[0]) => (
        <MarkdownTable {...props} sourceLineAnchors={sourceLineAnchors} />
      ),
      th: ({ children, style }: HTMLAttributes<HTMLTableCellElement>) => (
        <th
          style={style}
          className={`border-b border-border px-3 py-2 text-left ${variant === 'document' ? 'font-semibold' : 'font-medium'}`}
        >
          {children}
        </th>
      ),
      td: ({ children, style }: HTMLAttributes<HTMLTableCellElement>) => (
        <td style={style} className="border-b border-border px-3 py-2">
          {children}
        </td>
      ),
      a: function MarkdownAnchor({
        href,
        children,
        node,
      }: {
        href?: string
        children?: ReactNode
        node?: Pick<Element, 'data'>
      }) {
        const renderLink = useContext(MarkdownCustomLinkContext)
        const annotation = node?.data?.assistantAnnotation
        if (annotation?.kind === 'followup') {
          return (
            <AssistantFollowup key={annotation.prompt} prompt={annotation.prompt}>
              {children}
            </AssistantFollowup>
          )
        }
        if (annotation?.kind === 'file') {
          return <AssistantMarkdownLink citation={annotation}>{children}</AssistantMarkdownLink>
        }
        const text = reactNodeToText(children)
        const customLink = href ? renderLink?.(href, text, children) : undefined
        if (customLink !== undefined) return customLink
        const isComposerLink =
          href &&
          /^[a-z][a-z0-9+.-]*:\/\//i.test(href) &&
          text &&
          text !== href &&
          getRecognizedLink(href)
        if (isComposerLink) {
          return <ComposerLinkChip payload={{ url: href, label: text }} />
        }
        return <AssistantMarkdownLink href={href}>{children}</AssistantMarkdownLink>
      },
      img: ({ src, alt, node }: { src?: string | Blob; alt?: string } & ExtraProps) => (
        <AssistantMarkdownImage
          src={typeof src === 'string' ? src.trim() : undefined}
          alt={alt}
          sourceLine={sourceLineAnchors ? node?.position?.start?.line : undefined}
        />
      ),
    }),
    [headingClasses, variant, sourceLineAnchors]
  )

  return (
    <MarkdownCustomLinkContext.Provider value={renderLink}>
      <MarkdownFileOpenContext.Provider value={onOpenFile}>
        <div
          className={`${variant === 'user' ? 'user-markdown' : variant === 'process' ? 'thinking-markdown' : 'assistant-markdown'} min-w-0 max-w-full break-words`}
        >
          {contentParts.map((part, index) =>
            part.kind === 'visualization' ? (
              <Fragment key={`${part.file}-${index}`}>{renderVisualization?.(part)}</Fragment>
            ) : part.windowed ? (
              <WindowedMarkdownChunk
                key={`markdown-${index}`}
                chunkIndex={index}
                content={part.content}
                eager={isStreaming && (index === 0 || index === contentParts.length - 1)}
              >
                <MarkdownStreamingContext.Provider
                  value={isStreaming && index === contentParts.length - 1}
                >
                  <Streamdown
                    mode={streamdownMode}
                    parseIncompleteMarkdown={variant === 'default' || isStreaming}
                    plugins={markdownPlugins}
                    parseMarkdownIntoBlocksFn={
                      part.wholeSource ? completeMarkdownSource : undefined
                    }
                    isAnimating={false}
                    controls={false}
                    linkSafety={{ enabled: false }}
                    lineNumbers={false}
                    urlTransform={transformMarkdownUrl}
                    components={components}
                    rehypePlugins={tableMarkdownRehypePlugins}
                    remarkPlugins={remarkPlugins}
                  >
                    {prepareAssistantMarkdownContent(
                      part.content,
                      isStreaming && index === contentParts.length - 1
                    )}
                  </Streamdown>
                </MarkdownStreamingContext.Provider>
              </WindowedMarkdownChunk>
            ) : (
              <MarkdownStreamingContext.Provider key={`markdown-${index}`} value={isStreaming}>
                <Streamdown
                  mode={streamdownMode}
                  parseIncompleteMarkdown={variant === 'default' || isStreaming}
                  plugins={markdownPlugins}
                  parseMarkdownIntoBlocksFn={part.wholeSource ? completeMarkdownSource : undefined}
                  isAnimating={false}
                  controls={false}
                  linkSafety={{ enabled: false }}
                  lineNumbers={false}
                  urlTransform={transformMarkdownUrl}
                  components={components}
                  rehypePlugins={tableMarkdownRehypePlugins}
                  remarkPlugins={remarkPlugins}
                >
                  {variant === 'user'
                    ? part.content
                    : prepareAssistantMarkdownContent(part.content, isStreaming)}
                </Streamdown>
              </MarkdownStreamingContext.Provider>
            )
          )}
        </div>
      </MarkdownFileOpenContext.Provider>
    </MarkdownCustomLinkContext.Provider>
  )
}, areAssistantMarkdownPropsEqual)

type MarkdownCodeProps = {
  node?: {
    properties?: unknown
    position?: { start?: { line?: number } }
  }
  compact?: boolean
  sourceLineAnchors?: boolean
} & HTMLAttributes<HTMLElement>

function MarkdownCode({
  className,
  children,
  node,
  compact = false,
  sourceLineAnchors = false,
  ...props
}: MarkdownCodeProps) {
  const isStreaming = useContext(MarkdownStreamingContext)
  const match = /language-(\w*)/.exec(className || '')
  const text = reactNodeToText(children)
  const nodeDataBlock =
    typeof node?.properties === 'object' &&
    node.properties !== null &&
    'dataBlock' in node.properties &&
    node.properties.dataBlock === 'true'
  const isBlock =
    ('data-block' in props && Boolean(props['data-block'])) ||
    nodeDataBlock ||
    Boolean(match) ||
    text.includes('\n')
  if (isBlock) {
    const lang = match ? match[1] || '' : ''
    const streamingDiagramLanguage = STREAMING_DIAGRAM_LANGUAGES.get(lang.toLowerCase())
    if (streamingDiagramLanguage) {
      return (
        <MarkdownCodeBlock
          lang={streamingDiagramLanguage}
          compact={compact}
          isStreaming
          sourceLine={sourceLineAnchors ? node?.position?.start?.line : undefined}
        >
          {text || children}
        </MarkdownCodeBlock>
      )
    }
    if (diagramKind(lang) !== null) {
      return (
        <MarkdownDiagramPreview
          code={text.trimEnd()}
          language={lang}
          sourceLine={sourceLineAnchors ? node?.position?.start?.line : undefined}
        />
      )
    }
    return (
      <MarkdownCodeBlock
        lang={lang}
        compact={compact}
        isStreaming={isStreaming}
        sourceLine={sourceLineAnchors ? node?.position?.start?.line : undefined}
      >
        {text || children}
      </MarkdownCodeBlock>
    )
  }
  return <MarkdownInlineCode compact={compact}>{children}</MarkdownInlineCode>
}

function MarkdownInlineCode({
  children,
  compact = false,
}: {
  children?: ReactNode
  compact?: boolean
}) {
  return (
    <code
      className={`break-words rounded bg-muted px-1.5 py-0.5 font-medium text-text-primary ${compact ? 'text-xs' : 'text-code'}`}
    >
      {children}
    </code>
  )
}

function areAssistantMarkdownPropsEqual(
  previous: AssistantMarkdownProps,
  next: AssistantMarkdownProps
): boolean {
  return (
    previous.content === next.content &&
    previous.isStreaming === next.isStreaming &&
    previous.preserveLineBreaks === next.preserveLineBreaks &&
    previous.sourceLineAnchors === next.sourceLineAnchors &&
    previous.renderVisualization === next.renderVisualization &&
    previous.variant === next.variant &&
    previous.onOpenFile === next.onOpenFile &&
    previous.renderLink === next.renderLink
  )
}

function prepareAssistantMarkdownContent(content: string, isStreaming = false): string {
  const normalizedContent = content.replace(CODEX_PLAN_TAG_PATTERN, '')
  return isStreaming ? markUnclosedDiagramFence(normalizedContent) : normalizedContent
}

function markUnclosedDiagramFence(content: string): string {
  const lines = content.split('\n')
  let openingFence: {
    character: '`' | '~'
    length: number
    language: string
    lineIndex: number
    match: RegExpExecArray
  } | null = null

  for (const [lineIndex, line] of lines.entries()) {
    if (!openingFence) {
      const match = /^( {0,3})(`{3,}|~{3,})([ \t]*)([\w+-]*)([^\n]*)$/.exec(line)
      if (!match) continue

      const fence = match[2]
      const language = match[4].toLowerCase()
      openingFence = {
        character: fence[0] as '`' | '~',
        length: fence.length,
        language,
        lineIndex,
        match,
      }
      continue
    }

    const closingFence = new RegExp(
      `^ {0,3}${openingFence.character}{${openingFence.length},}[ \\t]*$`
    )
    if (closingFence.test(line)) {
      openingFence = null
    }
  }

  if (!openingFence || diagramKind(openingFence.language) === null) return content

  const [, indent, fence, spacing, , remainder] = openingFence.match
  lines[openingFence.lineIndex] =
    `${indent}${fence}${spacing}` + `weworkstreaming${openingFence.language}${remainder}`
  return lines.join('\n')
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeToText).join('')
  return ''
}

function formatMarkdownLineLabel(target: Extract<MarkdownLinkTarget, { kind: 'file' }>): string {
  if (typeof target.lineStart !== 'number') return ''
  if (typeof target.lineEnd === 'number' && target.lineEnd !== target.lineStart) {
    return `lines ${target.lineStart}-${target.lineEnd}`
  }
  return `line ${target.lineStart}`
}

function getMarkdownFileOpenOptions(
  target: Extract<MarkdownLinkTarget, { kind: 'file' }>
): MarkdownFileOpenOptions | undefined {
  if (typeof target.lineStart !== 'number' && !target.isDirectory) return undefined
  return {
    lineStart: target.lineStart,
    lineEnd: target.lineEnd,
    isDirectory: target.isDirectory,
  }
}

function getMarkdownFileIcon(path: string): ReactNode {
  return (
    <FileReferenceIcon
      path={path}
      className="h-3.5 w-3.5 shrink-0"
      data-testid="assistant-markdown-link-icon"
    />
  )
}

function AssistantMarkdownLink({
  href,
  citation,
  children,
}: {
  href?: string
  citation?: AssistantFileCitation
  children?: ReactNode
}) {
  const onOpenFile = useContext(MarkdownFileOpenContext)
  const { openExternalUrl, navigateTo, translate } = useMarkdownServices()
  const linkContent = (
    <MarkdownLinkScope.Provider value={true}>{children}</MarkdownLinkScope.Provider>
  )
  const target: MarkdownLinkTarget = citation ?? classifyMarkdownLink(href)
  const icon =
    target.kind === 'file' ? (
      target.isDirectory ? (
        <Folder
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0"
          data-testid="assistant-markdown-link-icon"
        />
      ) : (
        getMarkdownFileIcon(target.path)
      )
    ) : (
      <Link2
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0"
        data-testid="assistant-markdown-link-icon"
      />
    )

  if (target.kind === 'file') {
    const filePath = target.path
    const artifact = citation?.artifact
    const lineLabel =
      artifact?.kind === 'document'
        ? `${translate('citation.page')} ${artifact.page}`
        : artifact?.kind === 'presentation'
          ? [
              artifact.slide
                ? `${translate('citation.slide')} ${artifact.slide}`
                : artifact.slideId,
              artifact.objectId ? citation?.label || artifact.objectId : undefined,
            ]
              .filter(Boolean)
              .join(', ')
          : artifact?.kind === 'workbook'
            ? `${artifact.sheet}${artifact.range ? `!${artifact.range}` : `, ${citation?.label || artifact.objectId}`}`
            : formatMarkdownLineLabel(target)
    const tooltip = lineLabel ? `${target.path} (${lineLabel})` : target.path
    const openOptions = getMarkdownFileOpenOptions(target)
    return (
      <Tooltip
        label={tooltip}
        align="start"
        testId="assistant-markdown-link-tooltip"
        className="min-w-0 max-w-full !shrink align-baseline"
      >
        <ControlButton
          variant="unstyled"
          type="button"
          className={ASSISTANT_MARKDOWN_LINK_CLASS}
          data-testid="assistant-markdown-link"
          data-citation-purpose={citation?.purpose}
          data-search-excluded={citation ? true : undefined}
          disabled={!onOpenFile}
          onClick={() => {
            if (openOptions) {
              onOpenFile?.(filePath, openOptions)
              return
            }
            onOpenFile?.(filePath)
          }}
          aria-label={tooltip}
        >
          {icon}
          <span
            className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"
            data-testid="assistant-markdown-link-label"
          >
            {linkContent}
          </span>
          {lineLabel ? (
            <span className="shrink-0" data-testid="assistant-markdown-link-line">
              ({lineLabel})
            </span>
          ) : null}
        </ControlButton>
      </Tooltip>
    )
  }

  if (target.kind === 'internal') {
    return (
      <ControlButton
        variant="unstyled"
        type="button"
        className={ASSISTANT_MARKDOWN_LINK_CLASS}
        data-testid="assistant-markdown-link"
        disabled={!navigateTo}
        onClick={() => navigateTo?.(target.path)}
      >
        {icon}
        <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{linkContent}</span>
      </ControlButton>
    )
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={ASSISTANT_MARKDOWN_LINK_CLASS}
      data-testid="assistant-markdown-link"
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        if (!href) return
        void Promise.resolve(openExternalUrl(href)).catch(error => {
          console.error('[Wework] Failed to open assistant link', {
            error: error instanceof Error ? error.name : typeof error,
          })
        })
      }}
    >
      {icon}
      <span
        className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"
        data-testid="assistant-markdown-link-label"
      >
        {linkContent}
      </span>
    </a>
  )
}
