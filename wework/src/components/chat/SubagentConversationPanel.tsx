import { ArrowLeft, Bot, ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { SubagentBlock, WorkbenchMessage } from '@/types/workbench'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import { AssistantMarkdown } from './AssistantMarkdown'
import { SubagentAvatar } from './blocks/SubagentBlockItem'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import {
  getSubagentName,
  getSubagentPreview,
  getSubagentStatus,
} from './blocks/subagentPresentation'

interface SubagentConversationPanelProps {
  block: SubagentBlock
  onBack: () => void
  onOpenSubagent: (block: SubagentBlock) => void
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  transcriptMessages?: WorkbenchMessage[]
  transcriptLoading?: boolean
  transcriptError?: string | null
}

interface SubagentOverviewPanelProps {
  blocks: SubagentBlock[]
  onSelect: (block: SubagentBlock) => void
}

interface SubagentEnvironmentSummaryProps {
  blocks: SubagentBlock[]
  onOpen: () => void
}

export function SubagentEnvironmentSummary({ blocks, onOpen }: SubagentEnvironmentSummaryProps) {
  const { t } = useTranslation('chat')
  const activeCount = blocks.filter(isActiveSubagent).length
  const doneCount = blocks.length - activeCount
  const summary =
    activeCount > 0 && doneCount > 0
      ? t('subagent.summary_mixed', { active: activeCount, done: doneCount })
      : activeCount > 0
        ? t('subagent.summary_active', { count: activeCount })
        : t('subagent.summary_done', { count: doneCount })

  if (blocks.length === 0) return null

  return (
    <section data-testid="environment-subagents-section">
      <h3 className="mb-1 text-sm font-medium text-text-primary">{t('subagent.agent')}</h3>
      <button
        type="button"
        data-testid="open-subagents-panel-button"
        className="flex h-9 w-full items-center gap-2 rounded-md text-left text-sm text-text-secondary hover:bg-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={t('subagent.open_panel', { count: blocks.length })}
        onClick={onOpen}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-400">
          <Bot className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
      </button>
    </section>
  )
}

export function SubagentOverviewPanel({ blocks, onSelect }: SubagentOverviewPanelProps) {
  const { t } = useTranslation('chat')
  const activeBlocks = blocks.filter(isActiveSubagent)
  const doneBlocks = blocks.filter(block => !isActiveSubagent(block))

  return (
    <section
      className="h-full min-h-0 w-full overflow-y-auto bg-background px-3 py-5"
      data-testid="subagent-overview-panel"
    >
      <div className="mx-auto w-full max-w-3xl">
        <SubagentOverviewSection
          title={t('subagent.active_count', { count: activeBlocks.length })}
          blocks={activeBlocks}
          emptyState={t('subagent.no_active')}
          onSelect={onSelect}
        />
        <SubagentOverviewSection
          title={t('subagent.done_count', { count: doneBlocks.length })}
          blocks={doneBlocks}
          className="mt-6"
          onSelect={onSelect}
        />
      </div>
    </section>
  )
}

function isActiveSubagent(block: SubagentBlock): boolean {
  return block.status !== 'done' && block.status !== 'error'
}

export function SubagentConversationPanel({
  block,
  onBack,
  onOpenSubagent,
  onOpenWorkspaceFile,
  transcriptMessages = [],
  transcriptLoading = false,
  transcriptError = null,
}: SubagentConversationPanelProps) {
  const { t } = useTranslation('chat')
  const name = getSubagentName(block, t)
  const children = useMemo(() => block.children ?? [], [block.children])
  const childText = useMemo(
    () =>
      children
        .filter(child => child.type === 'text')
        .map(child => child.content.trim())
        .filter(Boolean)
        .join('\n\n'),
    [children]
  )
  const fallbackOutput =
    block.output?.trim() && !childText.includes(block.output.trim()) ? block.output : ''
  const isRunning = block.status !== 'done' && block.status !== 'error'
  const assistantTranscriptMessages = useMemo(
    () =>
      transcriptMessages.filter(
        message =>
          message.role === 'assistant' &&
          (message.content.trim() || (message.blocks?.length ?? 0) > 0)
      ),
    [transcriptMessages]
  )
  const hasLoadedTranscript = assistantTranscriptMessages.length > 0
  const shouldUseLoadedTranscript = hasLoadedTranscript && !isRunning

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="subagent-conversation-panel"
      data-subagent-block-id={block.id}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <button
          type="button"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-label={t('subagent.back_to_list')}
          onClick={onBack}
          data-testid="subagent-conversation-back"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <SubagentAvatar block={block} label={name} className="h-6 w-6" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
      </header>

      <div
        className="h-full min-h-0 overflow-y-auto px-3 py-5"
        data-testid="subagent-conversation-scroll"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {block.description?.trim() ? (
            <div className="flex justify-end" data-testid="subagent-conversation-delegation">
              <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-chat text-text-primary">
                <AssistantMarkdown content={block.description} />
              </div>
            </div>
          ) : null}

          {block.summary?.trim() ? (
            <div
              className="text-chat text-text-secondary"
              data-testid="subagent-conversation-summary"
            >
              <AssistantMarkdown content={block.summary} variant="process" />
            </div>
          ) : null}

          {shouldUseLoadedTranscript
            ? assistantTranscriptMessages.map(message => (
                <div
                  key={message.id}
                  className="flex flex-col gap-3"
                  data-testid="subagent-transcript-message"
                >
                  {(message.blocks?.length ?? 0) > 0 ? (
                    <ToolBlocksDisplay
                      blocks={message.blocks ?? []}
                      isStreaming={message.status === 'streaming'}
                      forceExpanded
                      processingPhase={message.status === 'streaming' ? 'live' : 'final'}
                      showSummary={false}
                      stateKey={`subagent-transcript:${block.id}:${message.id}`}
                      onOpenWorkspaceFile={onOpenWorkspaceFile}
                      onOpenSubagent={onOpenSubagent}
                    />
                  ) : null}
                  {message.content.trim() ? (
                    <div className="text-chat text-text-primary">
                      <AssistantMarkdown
                        content={message.content}
                        isStreaming={message.status === 'streaming'}
                      />
                    </div>
                  ) : null}
                </div>
              ))
            : null}

          {!shouldUseLoadedTranscript && children.length > 0 ? (
            <ToolBlocksDisplay
              blocks={children}
              isStreaming={isRunning}
              forceExpanded
              processingPhase={isRunning ? 'live' : 'final'}
              showSummary={false}
              stateKey={`subagent-panel:${block.id}`}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              onOpenSubagent={onOpenSubagent}
            />
          ) : null}

          {!shouldUseLoadedTranscript && fallbackOutput ? (
            <div className="text-chat text-text-primary" data-testid="subagent-conversation-output">
              <AssistantMarkdown content={fallbackOutput} isStreaming={isRunning} />
            </div>
          ) : null}

          {transcriptLoading && !shouldUseLoadedTranscript && children.length === 0 ? (
            <div
              className="py-8 text-center text-sm text-text-muted"
              data-testid="subagent-conversation-loading"
            >
              {t('subagent.loading_history')}
            </div>
          ) : null}

          {transcriptError && !shouldUseLoadedTranscript && children.length === 0 ? (
            <div
              className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-500"
              data-testid="subagent-conversation-error"
            >
              {transcriptError}
            </div>
          ) : null}

          {!transcriptLoading &&
          !transcriptError &&
          !shouldUseLoadedTranscript &&
          children.length === 0 &&
          !fallbackOutput &&
          !block.summary?.trim() ? (
            <div
              className="py-8 text-center text-sm text-text-muted"
              data-testid="subagent-conversation-empty"
            >
              {isRunning ? t('subagent.waiting_for_output') : t('subagent.no_output')}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function SubagentOverviewSection({
  title,
  blocks,
  emptyState,
  className,
  onSelect,
}: {
  title: string
  blocks: SubagentBlock[]
  emptyState?: string
  className?: string
  onSelect: (block: SubagentBlock) => void
}) {
  if (blocks.length === 0 && !emptyState) return null

  return (
    <section className={className}>
      <h2 className="mb-2 px-2 text-sm text-text-muted">{title}</h2>
      {blocks.length === 0 ? (
        <div className="px-2 py-1 text-sm text-text-muted">{emptyState}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {blocks.map(block => (
            <SubagentOverviewItem key={block.id} block={block} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  )
}

function SubagentOverviewItem({
  block,
  onSelect,
}: {
  block: SubagentBlock
  onSelect: (block: SubagentBlock) => void
}) {
  const { t } = useTranslation('chat')
  const name = getSubagentName(block, t)
  const preview = getSubagentPreview(block, t)
  const distinctPreview = preview === name ? null : preview

  return (
    <button
      type="button"
      className="flex min-h-10 w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2"
      onClick={() => onSelect(block)}
      aria-label={t('subagent.open_agent', { name })}
      data-testid="subagent-overview-item"
    >
      <SubagentAvatar block={block} label={name} className="mt-0.5 h-6 w-6" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-text-primary">{name}</span>
          <span className="shrink-0 whitespace-nowrap text-xs text-text-muted">
            {getSubagentStatus(block, t)}
          </span>
        </span>
        {distinctPreview ? (
          <span className="block truncate text-sm leading-5 text-text-secondary">
            {distinctPreview}
          </span>
        ) : null}
      </span>
    </button>
  )
}
