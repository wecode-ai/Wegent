import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canDiscussQuestion,
  questionDiscussionKey,
} from '@/features/notifications/questionDiscussion'

/** Keep unanswered business questions recoverable beside the ordinary composer. */
export function RequestUserInputComposer({
  payload,
  source,
  renderQuestion,
  children,
}: {
  payload: RequestUserInputPayload | null
  source?: RuntimeTaskAddress | null
  renderQuestion: (onCollapse?: () => void) => ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation('common')
  const key = payload
    ? source
      ? questionDiscussionKey(source, payload)
      : JSON.stringify([
          payload.requestId ?? payload.request_id,
          payload.itemId ?? payload.item_id,
          payload.interactionScope,
        ])
    : null
  const questionIds = JSON.stringify(payload?.questions?.map(question => question.id))
  const [state, setState] = useState({ key, questionIds, collapsed: false })
  if (state.key !== key || state.questionIds !== questionIds) {
    setState({ key, questionIds, collapsed: false })
  }
  const panelId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const expand = useRef<HTMLButtonElement>(null)
  const canCollapse = payload && canDiscussQuestion(payload)
  const hidden = state.key === key && state.collapsed
  useEffect(() => {
    if (hidden) expand.current?.focus({ preventScroll: true })
    else panel.current?.querySelector<HTMLElement>('form')?.focus({ preventScroll: true })
  }, [hidden])
  return (
    <>
      {payload && (
        <div key={key} ref={panel} id={panelId} hidden={hidden} inert={hidden}>
          {renderQuestion(
            canCollapse ? () => setState({ key, questionIds, collapsed: true }) : undefined
          )}
        </div>
      )}
      {payload && hidden && canCollapse && (
        <button
          ref={expand}
          type="button"
          data-testid="request-user-input-expand"
          aria-expanded={false}
          aria-controls={panelId}
          onClick={() => setState({ key, questionIds, collapsed: false })}
          className="mb-2 flex min-h-11 w-full items-center gap-2 rounded-lg bg-muted/60 px-3 text-left text-sm keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:min-h-8"
        >
          <span className="min-w-0 flex-1 truncate text-text-secondary">
            {payload.questions?.[0]?.question}
          </span>
          <span className="shrink-0">{t('question_discussion.expand_reply')}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </button>
      )}
      {(!payload || hidden) && children}
    </>
  )
}
