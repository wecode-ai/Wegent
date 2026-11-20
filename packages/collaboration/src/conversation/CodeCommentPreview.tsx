import { TooltipContext } from "../controls/tooltipContext"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../controls/HoverCard'
import { useMemo, useState, type ReactNode } from 'react'
import { controlPopup } from '../controls/recipes'
import { useConversationTranslation } from './ConversationTranslation'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'
import type { CodeCommentContext } from '@wegent/chat-core/code-comment'

export interface CodeCommentPreviewProps {
  getRightBoundary?: () => number
  comments: CodeCommentContext[]
  testId: string
  children: ReactNode
}

const COMMENT_TEXT_LIMIT = 240
const TARGET_TEXT_LIMIT = 120
const VALUE_LIMIT = 80

export function CodeCommentPreview({
  comments,
  testId,
  children,
  getRightBoundary,
}: CodeCommentPreviewProps) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null)
  const [rightBoundary, setRightBoundary] = useState<number>()
  const theme = useCollaborationPortalTheme()
  const anchor = useMemo(
    () =>
      getRightBoundary && trigger
        ? {
            getBoundingClientRect() {
              const rect = trigger.getBoundingClientRect()
              return {
                x: Math.min(rect.right, getRightBoundary()),
                y: rect.y,
                width: 0,
                height: rect.height,
              }
            },
          }
        : undefined,
    [getRightBoundary, trigger],
  )
  return (
    <HoverCard
      delay={0}
      closeDelay={120}
      onOpenChange={(next) => {
        if (next) setRightBoundary(getRightBoundary?.())
      }}
    >
      <HoverCardTrigger
        render={<div />}
        ref={setTrigger}
        className="inline-flex"
      >
        <TooltipContext.Provider value={true}>
          {children}
        </TooltipContext.Provider>
      </HoverCardTrigger>
      <HoverCardContent
        {...theme}
        anchor={anchor}
        side="top"
        align={getRightBoundary ? 'end' : 'start'}
        sideOffset={4}
        collisionPadding={8}
        data-testid={testId}
        style={{
          ...theme.style,
          maxWidth:
            rightBoundary === undefined
              ? undefined
              : `min(420px, calc(100vw - 16px), ${Math.max(0, rightBoundary - 8)}px)`,
          minWidth:
            rightBoundary === undefined
              ? undefined
              : `min(280px, ${Math.max(0, rightBoundary - 8)}px)`,
        }}
        className={
          theme.className +
          ' ' +
          controlPopup +
          ' w-fit min-w-[min(280px,calc(100vw-1rem))] max-w-[min(420px,calc(100vw-1rem))]'
        }
      >
        <div className="divide-y divide-border">
          {comments.map((comment) => (
            <CodeCommentPreviewItem key={comment.id} comment={comment} />
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function CodeCommentPreviewItem({ comment }: { comment: CodeCommentContext }) {
  const { t } = useConversationTranslation()
  const target = comment.browserAnnotation?.target
  const adjustments = comment.adjustments ?? []
  const codeLabel = `${comment.fileName}:${comment.startLine === comment.endLine ? comment.startLine : `${comment.startLine}-${comment.endLine}`}`
  const targetText =
    target?.isSimpleText && target.text
      ? truncate(target.text, TARGET_TEXT_LIMIT)
      : ''

  return (
    <div className="px-2 py-1.5 text-sm text-text-primary">
      <div className="flex min-w-0 items-center gap-1.5 font-medium">
        {target ? (
          <>
            <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted px-1.5 py-px font-mono text-xs font-medium leading-[14px] text-text-secondary">
              {target.tagName}
            </span>
            {targetText && (
              <span className="truncate text-text-primary" title={targetText}>
                {targetText}
              </span>
            )}
          </>
        ) : (
          <span className="truncate" title={codeLabel}>
            {codeLabel}
          </span>
        )}
      </div>
      {!target && (
        <PreviewLine
          label={t('workbench.code_comment_selected_text')}
          value={comment.selectedText}
        />
      )}
      {comment.comment && (
        <p
          className="mt-1 truncate text-xs leading-4 text-text-primary"
          title={comment.comment}
        >
          {truncate(comment.comment, COMMENT_TEXT_LIMIT)}
        </p>
      )}
      {adjustments.slice(0, 3).map((adjustment) => (
        <PreviewLine
          key={`${comment.id}:${adjustment.property}`}
          label={t(
            `workbench.browser_annotation_adjustment_${adjustment.property}`,
          )}
          value={`${truncate(adjustment.before, VALUE_LIMIT)} -> ${truncate(adjustment.after, VALUE_LIMIT)}`}
        />
      ))}
      {adjustments.length > 3 && (
        <p className="mt-1 text-xs leading-4 text-text-tertiary">
          {t('workbench.browser_annotation_more_adjustments', {
            count: adjustments.length - 3,
          })}
        </p>
      )}
    </div>
  )
}

function PreviewLine({ label, value }: { label: string; value: string }) {
  return (
    <p
      className="mt-1 truncate text-xs leading-4 text-text-secondary"
      title={value}
    >
      <span className="text-text-tertiary">{label}: </span>
      {truncate(value, COMMENT_TEXT_LIMIT)}
    </p>
  )
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}
