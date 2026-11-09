import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { X } from 'lucide-react'
import {
  ToolInteractionServicesProvider,
  useToolInteractionServices,
  type RequestUserInputCardProps,
} from '@wegent/collaboration/conversation'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchMessage, RuntimeTaskComposerCreateOptions } from '@/types/workbench'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import { requestUserInputQuestionTarget } from '@/components/layout/requestUserInputOverlay'
import {
  canDiscussQuestion,
  questionDiscussionAnswerQuestions,
  QuestionDiscussionContext,
  QuestionDiscussionStoreContext,
  questionDiscussionKey,
  questionDiscussionPrompt,
  pendingDiscussionQuestion,
  type QuestionDiscussionSession,
  type QuestionDiscussionTab,
} from './questionDiscussion'

const renderUserInput = (props: RequestUserInputCardProps) => <RequestUserInputCard {...props} />

/** Share drafts and route entry points; task panes own the actual sidebar tabs. */
export function QuestionDiscussionScope({ children }: { children: ReactNode }) {
  const { openRuntimeTask } = useWorkbenchPaneContext()
  const opener = useRef<{ key: string; element: HTMLElement | null } | null>(null)
  const store = useContext(QuestionDiscussionStoreContext)
  const inheritedServices = useToolInteractionServices()
  const toolServices = useMemo(
    () => ({ ...inheritedServices, renderRequestUserInput: renderUserInput }),
    [inheritedServices]
  )
  const request = store?.panelRequest
  const open = useCallback(
    (source: RuntimeTaskAddress, payload: RequestUserInputPayload) => {
      if (!store || !canDiscussQuestion(payload)) return
      const key = questionDiscussionKey(source, payload)
      opener.current = {
        key,
        element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      }
      store.update(key, current => ({
        ...current,
        source,
        payload,
        address: current?.address ?? null,
        answers: current?.answers ?? {},
      }))
      store.requestPanel({ key, source })
      void openRuntimeTask(source)
    },
    [store, openRuntimeTask]
  )
  const restoreFocus = useCallback((key: string) => {
    if (opener.current?.key !== key) return
    if (opener.current.element?.isConnected) opener.current.element.focus({ preventScroll: true })
    opener.current = null
  }, [])
  const consume = store?.consumePanelRequest
  const value = useMemo(
    () => (store ? { open, restoreFocus, request, consume } : null),
    [store, open, restoreFocus, request, consume]
  )
  return (
    <QuestionDiscussionContext.Provider value={value}>
      <ToolInteractionServicesProvider value={toolServices}>
        {children}
      </ToolInteractionServicesProvider>
    </QuestionDiscussionContext.Provider>
  )
}

export function QuestionDiscussionTabPanel({
  tab,
  active,
  onClose,
}: {
  tab: QuestionDiscussionTab
  active: boolean
  onClose(): void
}) {
  const store = useContext(QuestionDiscussionStoreContext)
  const discussion = useContext(QuestionDiscussionContext)
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])
  const key = tab.slice('discussion:'.length)
  const session = store?.sessions[key]
  if (!session) return null
  return (
    <div data-testid="question-discussion-sidebar" className="h-full min-h-0">
      <QuestionDiscussionPanel
        key={`${store.accountKey}:${key}`}
        sessionKey={key}
        session={session}
        open={active}
        onClose={() => {
          if (activeRef.current) discussion?.restoreFocus?.(key)
          onClose()
        }}
      />
    </div>
  )
}

function QuestionDiscussionPanel({
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
  const answerQuestions = questionDiscussionAnswerQuestions(session.payload)
  const [selectedQuestionId, setQuestionId] = useState(answerQuestions[0]?.id)
  const questionId = answerQuestions.some(question => question.id === selectedQuestionId)
    ? selectedQuestionId
    : answerQuestions[0]?.id
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeCurrentTab = useStableEvent(onClose)
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true })
  }, [open])
  const [initialAddress] = useState(session.address)
  const checkingRef = useRef(false)
  const onAddressChange = useCallback(
    (address: RuntimeTaskAddress | null) => {
      update(sessionKey, current => ({ ...current!, address }))
    },
    [sessionKey, update]
  )
  const apply = async (text: string) => {
    if (checkingRef.current || !text.trim() || !questionId) return
    checkingRef.current = true
    const target = requestUserInputQuestionTarget(session.payload, questionId)
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
        ...current,
        source: session.source,
        payload: current?.payload ?? target.payload,
        address: current?.address ?? null,
        answers: { ...current?.answers, [target.questionId]: text.trim() },
      }))
      if (panelRef.current) closeCurrentTab()
    } catch {
      setError(t('question_discussion.failed'))
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }
  return (
    <div hidden={!open} aria-hidden={!open} inert={!open} className="h-full min-h-0">
      <div
        ref={panelRef}
        role="region"
        onKeyDown={event => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        data-testid="question-discussion-dialog"
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-text-primary"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-base font-medium">
              {t('question_discussion.title')}
            </h2>
            <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
              {session.payload.questions?.find(question => question.id === questionId)?.question ??
                session.payload.questions?.[0]?.question}
            </p>
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
        {(answerQuestions.length > 1 || checking || error) && (
          <div className="shrink-0 space-y-2 px-4 pb-2">
            {answerQuestions.length > 1 && (
              <>
                <label htmlFor={`${id}-question`} className="block text-sm font-medium">
                  {t('question_discussion.answer_for')}
                </label>
                <select
                  id={`${id}-question`}
                  data-testid="question-discussion-question"
                  value={questionId}
                  onChange={event => setQuestionId(event.target.value)}
                  disabled={checking}
                  className="block min-h-11 w-full min-w-0 max-w-full rounded-lg border border-border bg-background px-2 text-sm md:min-h-8"
                >
                  {answerQuestions.map(question => (
                    <option key={question.id} value={question.id}>
                      {question.question ?? question.header}
                    </option>
                  ))}
                </select>
              </>
            )}
            {checking && (
              <p role="status" className="text-sm text-text-secondary">
                {t('question_discussion.checking')}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-status-error">
                {error}
              </p>
            )}
          </div>
        )}

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
            controlledAddress={session.address}
            draft={{
              value:
                session.input ??
                (session.address
                  ? ''
                  : questionDiscussionPrompt(session.payload, t('question_discussion.prompt'))),
              onChange: input => store.update(sessionKey, current => ({ ...current!, input })),
            }}
            active={open}
            initialInput={
              initialAddress
                ? ''
                : questionDiscussionPrompt(session.payload, t('question_discussion.prompt'))
            }
            onAddressChange={onAddressChange}
            createTask={createTask}
            showExecutionTools={false}
            expanded
            emptyStateText={t('question_discussion.empty')}
            onFillSelectionToAnswer={
              open && !checking && questionId ? text => void apply(text) : undefined
            }
            placeholder={t('question_discussion.placeholder')}
          />
        </div>
      </div>
    </div>
  )
}
