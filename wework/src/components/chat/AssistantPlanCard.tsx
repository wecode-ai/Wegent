import { useEffect, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Copy, Download, ListChecks, Maximize2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import { AssistantMarkdown } from './AssistantMarkdown'

interface AssistantPlanCardProps {
  content: string
  onOpenPlan?: () => void
  isStreaming?: boolean
}

export interface AssistantPlanOpenRequest {
  blockId: string
  subtaskId: string
  content: string
}

export function AssistantPlanCard({
  content,
  onOpenPlan,
  isStreaming = false,
}: AssistantPlanCardProps) {
  const { t } = useTranslation('chat')

  const handleDownload = async () => {
    if (isTauriRuntime()) {
      await invoke<string>('save_text_file_to_downloads', {
        filename: 'plan.md',
        content,
      })
      return
    }

    downloadTextFile(content, 'plan.md')
  }

  const openPlan = () => {
    onOpenPlan?.()
  }

  const handleCardClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (isNestedInteractiveElement(event.target, event.currentTarget)) return
    openPlan()
  }

  const handleCardKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (isNestedInteractiveElement(event.target, event.currentTarget)) return
    event.preventDefault()
    openPlan()
  }

  return (
    <section
      data-testid="assistant-plan-card"
      role={onOpenPlan ? 'button' : undefined}
      tabIndex={onOpenPlan ? 0 : undefined}
      aria-label={onOpenPlan ? t('plan_card.expand') : undefined}
      onClick={onOpenPlan ? handleCardClick : undefined}
      onKeyDown={onOpenPlan ? handleCardKeyDown : undefined}
      className={cn(
        'my-2 min-w-0 overflow-hidden rounded-lg border border-border bg-background shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
        onOpenPlan &&
          'cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/70'
      )}
    >
      <div className="flex min-h-9 items-center justify-between gap-3 px-4 py-1.5 text-text-muted">
        <div className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
          <ListChecks className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <span>{t('plan_card.title')}</span>
          {isStreaming ? (
            <span
              data-testid="assistant-plan-streaming-indicator"
              className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-text-secondary"
            >
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
                aria-hidden="true"
              />
              <span>{t('plan_card.generating')}</span>
            </span>
          ) : null}
        </div>
        <PlanCardActions content={content} onDownload={handleDownload} onExpand={openPlan} />
      </div>
      <div
        data-testid="assistant-plan-card-preview"
        className="relative max-h-[168px] overflow-hidden px-4 pb-3 pt-2"
      >
        <div
          data-testid="assistant-plan-card-content"
          className="assistant-plan-card-content text-sm leading-6 text-text-primary [&_.assistant-markdown_h1]:mb-3 [&_.assistant-markdown_h1]:mt-2 [&_.assistant-markdown_h2]:mb-2 [&_.assistant-markdown_h2]:mt-3 [&_.assistant-markdown_p]:mb-2 [&_.assistant-markdown_p]:leading-5 [&_.assistant-markdown_ul]:mb-2 [&_.assistant-markdown_ul]:space-y-1 [&_.assistant-markdown_li]:leading-5"
        >
          <AssistantMarkdown content={content} isStreaming={isStreaming} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
      </div>
    </section>
  )
}

function PlanCardActions({
  content,
  onDownload,
  onExpand,
}: {
  content: string
  onDownload: () => void | Promise<void>
  onExpand: () => void
}) {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopy = () => {
    void copyText(content).then(() => setCopied(true))
  }

  const actions = [
    {
      key: 'download',
      label: t('plan_card.download'),
      icon: <Download className="h-4 w-4" aria-hidden="true" />,
      onClick: onDownload,
      testId: 'assistant-plan-download-button',
    },
    {
      key: 'copy',
      label: t('plan_card.copy'),
      icon: <Copy className="h-4 w-4" aria-hidden="true" />,
      onClick: handleCopy,
      testId: 'assistant-plan-copy-button',
    },
    {
      key: 'expand',
      label: t('plan_card.expand'),
      icon: <Maximize2 className="h-4 w-4" aria-hidden="true" />,
      onClick: onExpand,
      testId: 'assistant-plan-expand-button',
    },
  ]

  return (
    <div className="flex shrink-0 items-center gap-2">
      {copied ? (
        <span
          data-testid="assistant-plan-copy-success"
          className="text-xs font-medium text-text-secondary"
        >
          {t('plan_card.copy_success')}
        </span>
      ) : null}
      {actions.map(action => (
        <button
          key={action.key}
          type="button"
          data-testid={action.testId}
          aria-label={action.label}
          title={action.label}
          onClick={event => {
            event.stopPropagation()
            void action.onClick()
          }}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
        >
          {action.icon}
        </button>
      ))}
    </div>
  )
}

function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function isNestedInteractiveElement(target: EventTarget | null, currentTarget: HTMLElement) {
  if (!(target instanceof HTMLElement)) return false
  const interactiveTarget = target.closest('button,a,input,textarea,select')
  return Boolean(interactiveTarget && interactiveTarget !== currentTarget)
}

async function copyText(text: string) {
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
