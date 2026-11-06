import { useCallback, useContext, useId, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import {
  ToolInteractionServicesProvider,
  useToolInteractionServices,
  type RequestUserInputCardProps,
} from '@wegent/collaboration/conversation'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConversationMessages } from '@/features/workbench/runtimeConversationCache'
import type { WorkbenchMessage, RuntimeTaskComposerCreateOptions } from '@/types/workbench'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import { requestUserInputQuestionTarget } from '@/components/layout/requestUserInputOverlay'
import {
  canDiscussQuestion,
  QuestionDiscussionContext,
  QuestionDiscussionStoreContext,
  questionDiscussionKey,
  questionDiscussionPrompt,
  pendingDiscussionQuestion,
  type QuestionDiscussionSession,
} from './questionDiscussion'

const renderUserInput = (props: RequestUserInputCardProps) => <RequestUserInputCard {...props} />

/** Each workbench owns its discussion surface; drafts remain shared across tabs. */
export function QuestionDiscussionScope({ children }: { children: ReactNode }) {
  const store = useContext(QuestionDiscussionStoreContext)
  const inheritedServices = useToolInteractionServices()
  const toolServices = useMemo(
    () => ({ ...inheritedServices, renderRequestUserInput: renderUserInput }),
    [inheritedServices]
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<string[]>([])
  const open = useCallback(
    (source: RuntimeTaskAddress, payload: RequestUserInputPayload) => {
      if (!store || !canDiscussQuestion(payload)) return
      const key = questionDiscussionKey(source, payload)
      store.update(key, current => ({
        ...current,
        source,
        payload,
        address: current?.address ?? null,
        answers: current?.answers ?? {},
        conclusions: current?.conclusions ?? {},
      }))
      setSelected(key)
      setOpened(current => (current.includes(key) ? current : [...current, key]))
    },
    [store]
  )
  const value = useMemo(() => (store ? { open } : null), [store, open])
  return (
    <QuestionDiscussionContext.Provider value={value}>
      <ToolInteractionServicesProvider value={toolServices}>
        {children}
      </ToolInteractionServicesProvider>
      {opened.map(
        key =>
          store?.sessions[key] && (
            <QuestionDiscussionDialog
              key={key}
              sessionKey={key}
              session={store.sessions[key]}
              open={selected === key}
              onClose={() => setSelected(null)}
            />
          )
      )}
    </QuestionDiscussionContext.Provider>
  )
}

function QuestionDiscussionDialog({
  sessionKey,
  session,
  open,
  onClose,
}: {
  sessionKey: string
  session: QuestionDiscussionSession
  open: boolean
  onClose(): void
}) {
  const store = useContext(QuestionDiscussionStoreContext)!
  const { create, update } = store
  const { t } = useTranslation('common')
  const { loadRuntimeTranscriptForPane, createTemporaryRuntimeTask } = useWorkbenchPaneContext()
  const id = useId()
  const createTask = useCallback(
    async (message: string, options: RuntimeTaskComposerCreateOptions) => {
      try {
        const address = await create(sessionKey, () =>
          createTemporaryRuntimeTask(message, { ...options, source: session.source, project: null })
        )
        if (!address) options.onError(t('question_discussion.start_failed'))
        return address
      } catch {
        options.onError(t('question_discussion.start_failed'))
        return false as const
      }
    },
    [create, sessionKey, createTemporaryRuntimeTask, session.source, t]
  )
  const [questionId, setQuestionId] = useState(session.payload.questions![0].id!)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(onClose, open)
  const [initialAddress] = useState(session.address)
  const conclusion = session.conclusions[questionId] ?? ''
  const onAddressChange = useCallback(
    (address: RuntimeTaskAddress | null) => {
      update(sessionKey, current => ({ ...current!, address }))
    },
    [sessionKey, update]
  )
  const apply = async () => {
    setChecking(true)
    setError(null)
    try {
      // Re-read the exact request. Returning a draft must never revive a settled question.
      let beforeCursor: string | null | undefined
      const cursors = new Set<string>()
      const pages: WorkbenchMessage[][] = []
      do {
        const page = await loadRuntimeTranscriptForPane(session.source, {
          refresh: true,
          isolated: true,
          includeFullContent: true,
          limit: 100,
          beforeCursor,
        })
        pages.unshift(page.messages)
        if (page.historyUnavailable) throw new Error('History is unavailable')
        if (!page.hasMoreBefore) break
        if (!page.beforeCursor || cursors.has(page.beforeCursor))
          throw new Error('Incomplete question history')
        beforeCursor = page.beforeCursor
        cursors.add(beforeCursor)
      } while (beforeCursor)
      const target = requestUserInputQuestionTarget(session.payload, questionId)
      const live = pendingDiscussionQuestion(pages.flat(), target.payload)
      if (
        !live ||
        !canDiscussQuestion(live) ||
        !live.questions?.some(question => question.id === target.questionId)
      ) {
        setError(t('question_discussion.unavailable'))
        return
      }
      store.update(questionDiscussionKey(session.source, target.payload), current => ({
        source: session.source,
        payload: target.payload,
        address: current?.address ?? null,
        conclusions: current?.conclusions ?? {},
        answers: { ...current?.answers, [target.questionId]: conclusion.trim() },
      }))
      onClose()
    } catch {
      setError(t('question_discussion.failed'))
    } finally {
      setChecking(false)
    }
  }
  return createPortal(
    <div
      hidden={!open}
      aria-hidden={!open}
      inert={!open}
      className={
        open
          ? 'fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-2 md:p-6'
          : 'hidden'
      }
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        data-testid="question-discussion-dialog"
        className="flex h-full max-h-[52rem] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-background text-text-primary shadow-lg"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-base font-medium">
              {t('question_discussion.title')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">{t('question_discussion.hint')}</p>
          </div>
          <button
            type="button"
            data-testid="question-discussion-close"
            aria-label={t('question_discussion.close')}
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus md:h-8 md:w-8"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div
          data-testid="question-discussion-content"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <TemporaryChatPanel
            currentProject={null}
            source={session.source}
            instanceId={`question-discussion:${sessionKey}`}
            testId="question-discussion-conversation"
            initialAddress={initialAddress}
            active={open}
            initialInput={
              initialAddress
                ? ''
                : questionDiscussionPrompt(session.payload, t('question_discussion.prompt'))
            }
            autoSubmitInitialInput={!initialAddress}
            onAddressChange={onAddressChange}
            createTask={createTask}
            showExecutionTools={false}
            expanded
            emptyStateText={t('question_discussion.starting')}
            placeholder={t('question_discussion.placeholder')}
          />
        </div>
        <footer
          data-testid="question-discussion-answer"
          className="flex shrink-0 flex-col gap-2 border-t border-border p-3"
        >
          <label htmlFor={`${id}-question`} className="text-sm font-medium">
            {t('question_discussion.answer_for')}
          </label>
          <select
            id={`${id}-question`}
            data-testid="question-discussion-question"
            value={questionId}
            onChange={event => setQuestionId(event.target.value)}
            disabled={checking}
            className="min-h-11 rounded-lg border border-border bg-background px-2 text-sm md:min-h-8"
          >
            {session.payload.questions!.map(question => (
              <option key={question.id} value={question.id}>
                {question.question ?? question.header}
              </option>
            ))}
          </select>
          <textarea
            data-testid="question-discussion-conclusion"
            aria-label={t('question_discussion.conclusion')}
            rows={2}
            value={conclusion}
            disabled={checking}
            placeholder={t('question_discussion.conclusion')}
            onChange={event => {
              const text = event.target.value
              store.update(sessionKey, current => ({
                ...current!,
                conclusions: { ...current!.conclusions, [questionId]: text },
              }))
            }}
            className="max-h-32 min-h-16 resize-y rounded-lg border border-border bg-background p-2 text-sm focus:ring-2 focus:ring-focus"
          />
          {error && (
            <p role="alert" className="text-sm text-status-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-xs text-text-secondary">
              {t('question_discussion.review_hint')}
            </p>
            <button
              type="button"
              data-testid="question-discussion-use-reply"
              disabled={checking || !session.address}
              onClick={() => {
                const reply =
                  session.address &&
                  [...getRuntimeConversationMessages(session.address)]
                    .reverse()
                    .find(
                      message =>
                        message.role === 'assistant' &&
                        message.status === 'done' &&
                        message.content.trim()
                    )
                if (!reply) {
                  setError(t('question_discussion.no_reply'))
                  return
                }
                setError(null)
                store.update(sessionKey, current => ({
                  ...current!,
                  conclusions: { ...current!.conclusions, [questionId]: reply.content },
                }))
              }}
              className="min-h-11 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-50 md:min-h-8"
            >
              {t('question_discussion.use_reply')}
            </button>
            <button
              type="button"
              data-testid="question-discussion-apply"
              onClick={() => void apply()}
              disabled={checking || !conclusion.trim() || !canDiscussQuestion(session.payload)}
              className="min-h-11 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50 md:min-h-8"
            >
              {t(checking ? 'question_discussion.checking' : 'question_discussion.apply')}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  )
}
