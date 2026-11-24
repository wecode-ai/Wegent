import { useDeadlineExpired } from '../clock'
import { useMarkdownServices } from './MarkdownServices'
import { useRef, useState, type ReactNode } from 'react'
import type { ExtraProps } from 'streamdown'
import { Copy, CopyCheck, CircleAlert, Maximize2 } from 'lucide-react'
import { Button } from './Button'
import { Tooltip } from '../controls/Tooltip'
import { MarkdownTableDialog } from './MarkdownTableDialog'

export function MarkdownTable({
  children,
  node,
  sourceLineAnchors,
}: {
  children?: ReactNode
  sourceLineAnchors?: boolean
} & ExtraProps) {
  const { translate: t, copyText: copyTextToClipboard, onCopy } = useMarkdownServices()
  const expandRef = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [feedback, setFeedback] = useState<{
    status: 'idle' | 'copied' | 'failed'
    until?: number
  }>({ status: 'idle' })
  const expired = useDeadlineExpired(feedback.until)
  const status = expired ? 'idle' : feedback.status
  const label = t(`table.${status === 'idle' ? 'copy' : status}`)

  const handleCopy = async () => {
    setFeedback({ status })
    try {
      const data = node?.data
      const text = data && 'tableMarkdown' in data ? data.tableMarkdown : undefined
      if (typeof text !== 'string') throw new Error('Table Markdown source is unavailable')
      await copyTextToClipboard(text)
      setFeedback({ status: 'copied', until: Date.now() + 1500 })
      onCopy?.()
    } catch {
      setFeedback({ status: 'failed' })
    }
  }

  return (
    <div
      data-scroll-anchor
      data-source-line={sourceLineAnchors ? node?.position?.start?.line : undefined}
      className="group/markdown-table relative mb-3 max-w-full pr-12 md:pr-9"
      data-testid="markdown-table"
    >
      <div
        data-testid="markdown-table-actions"
        className="absolute right-0 top-0 flex flex-col gap-1 opacity-0 transition-opacity group-hover/markdown-table:opacity-100 group-focus-within/markdown-table:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Tooltip label={t('table.expand')}>
          <Button
            ref={expandRef}
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 text-text-secondary md:h-7 md:w-7 [&_svg]:size-3.5"
            aria-label={t('table.expand')}
            aria-haspopup="dialog"
            data-testid="markdown-table-expand-button"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 aria-hidden="true" />
          </Button>
        </Tooltip>
        <Tooltip label={label}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 text-text-secondary md:h-7 md:w-7 [&_svg]:size-3.5"
            aria-label={label}
            data-testid="markdown-table-copy-button"
            onClick={() => void handleCopy()}
          >
            {status === 'copied' ? (
              <CopyCheck aria-hidden="true" />
            ) : status === 'failed' ? (
              <CircleAlert aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </Button>
        </Tooltip>
        <span className="sr-only" role="status">
          {status === 'idle' ? '' : label}
        </span>
      </div>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-chat">{children}</table>
      </div>
      {expanded && (
        <MarkdownTableDialog onClose={() => setExpanded(false)} triggerRef={expandRef}>
          {children}
        </MarkdownTableDialog>
      )}
    </div>
  )
}
