// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import './exam-theme-lock.css'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useExamTimer } from './hooks/useExamTimer'
import { useAutoSave } from './hooks/useAutoSave'
import { DynamicAnswerUploadZone } from './DynamicAnswerUploadZone'
import {
  getExamData,
  updateExamAttachments,
  selectExamQuestion,
  advanceExamPhase,
} from '@wecode/api/evaluation-exam'
import type {
  ExamSessionStatus,
  ExamTopicConfig,
  ExamQuestionContent,
  ExamVideoAttachment,
  SlotAnswer,
  AnswerSlot,
} from '@wecode/types/evaluation-exam'
import {
  isExamTopicConfig,
  isExamQuestionContent,
  DEFAULT_BONUS_ITEMS,
  DEFAULT_SCORING,
  DEFAULT_TIME_NOTE,
} from '@wecode/types/evaluation-exam'
import type { Question } from '@wecode/types/evaluation'

import {
  Icon,
  AIAssessmentTopicCard,
  ExamHeader,
  ExamInfoSection,
  BonusItemsSection,
  ParticipantInfoSection,
  CompletedState,
  PreviewConfirmModal,
  FinalConfirmModal,
  TimeWarningModal,
  UsernameWatermark,
} from './index'
import { ExamTopicDetail } from './ExamTopicDetail'
import { SubmitHintMarkdown } from './SubmitHintMarkdown'
import type { PermissionState, DynamicQuestionDataMap } from './ai-assessment-types'
import { createInitialDynamicQuestionDataMap } from './ai-assessment-types'
import {
  buildDynamicQuestionDataMapFromAnswers,
  hasDynamicRequiredFiles,
  getTimerColorClass,
  extractAttachmentsFromContent,
} from './ai-assessment-utils'
import type { Topic } from './AIAssessmentTopicCard'

interface ExamPageProps {
  topicId: number
}

// Transform ExamTopicConfig rules markdown to rules array
function transformRules(
  rulesMarkdown: string,
  duration?: { intro: number; exam: number; review: number }
): Array<{ icon: string; label: string; text: string }> {
  const rules: Array<{ icon: string; label: string; text: string }> = []
  const lines = rulesMarkdown.split('\n')

  for (const line of lines) {
    const match = line.match(/^-\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)$/)
    if (match) {
      const label = match[1].trim()
      const text = match[2].trim()
      let icon = 'file'
      if (label.includes('时间')) icon = 'clock'
      else if (label.includes('工具')) icon = 'tool'
      else if (label.includes('提交')) icon = 'upload'
      else if (label.includes('公平')) icon = 'shield'
      rules.push({ icon, label, text })
    }
  }

  // Use dynamic duration if provided, otherwise use defaults
  const introMinutes = duration?.intro ?? 5
  const examMinutes = duration?.exam ?? 50
  const reviewMinutes = duration?.review ?? 5

  return rules.length > 0
    ? rules
    : [
        {
          icon: 'clock',
          label: '考试时间',
          text: `${introMinutes}分钟考前介绍答疑+${examMinutes}分钟答题+${reviewMinutes}分钟提交结果初查`,
        },
        {
          icon: 'tool',
          label: '工具不限',
          text: '不限制应用模型或工具，公司内外部工具、国内/海外工具均可使用',
        },
        {
          icon: 'upload',
          label: '提交要求',
          text: '请按要求提交作答说明、AI交互过程记录及产出报告/方案；如选答附加题，可补充提交 Agent或多模态交付物等相关材料',
        },
        {
          icon: 'shield',
          label: '公平原则',
          text: '为确保公平性，现场不得直接使用过往工作产出作为结果提交',
        },
      ]
}

// Transform ExamQuestionContent to Topic format
function transformQuestionToTopic(question: Question, _index: number): Topic {
  const contentData = question.content_data as unknown as ExamQuestionContent | undefined

  if (contentData && isExamQuestionContent(contentData)) {
    return {
      id: question.id,
      title: question.title,
      shortDesc: contentData.display.shortDesc,
      icon: contentData.display.icon,
      context: contentData.contentMarkdown,
      tasks: [],
      requirement: '',
      deliverable: [],
      bonusDeliverable: [],
      attachments: contentData.attachments,
      answerSlots: contentData.answerSlots,
    }
  }

  return {
    id: question.id,
    title: question.title,
    shortDesc: '',
    icon: 'file',
    context: (question.content_data?.content as string) || '',
    tasks: [],
    requirement: '',
    deliverable: [],
    bonusDeliverable: [],
  }
}

// Build exam data from topic config and questions
function buildExamData(
  topicConfig: ExamTopicConfig | null,
  questions: Question[],
  topicName?: string,
  topicDescription?: string
) {
  const config = topicConfig || {
    title: topicName || 'AI应用能力考核',
    year: new Date().getFullYear().toString(),
    duration: { intro: 5, exam: 50, review: 5 },
    rulesMarkdown: '',
    scoring: DEFAULT_SCORING,
    timeNote: DEFAULT_TIME_NOTE,
    uploadSlots: [],
    bonusItems: DEFAULT_BONUS_ITEMS,
    description: topicDescription || '',
  }

  const rules = transformRules(config.rulesMarkdown, config.duration)

  // Use description from config or fall back to topicDescription
  const finalDescription = config.description || topicDescription || ''

  return {
    title: config.title,
    year: config.year,
    duration: config.duration,
    description: finalDescription,
    rules,
    examMethod: {
      scoring: config.scoring.description,
      dimensions: config.scoring.dimensions,
      bonus: config.scoring.bonusNote,
    },
    timeNote: config.timeNote,
    topics: questions.map((q, i) => transformQuestionToTopic(q, i)),
    bonusItems: config.bonusItems.map((item, i) => ({
      id: i + 1,
      title: item.title,
      description: item.description,
      platforms: item.platforms,
      deliverables: item.deliverables,
    })),
  }
}

export function ExamPage({ topicId }: ExamPageProps) {
  const router = useRouter()
  const { user, isLoading: isUserLoading } = useUser()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const [examSession, setExamSession] = useState<ExamSessionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedTopic, setSelectedTopic] = useState<number | null>(null)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const dataLoadedRef = useRef(false)
  const [permissionState, setPermissionState] = useState<PermissionState>('checking')
  const participantName = user?.user_name || ''

  // Topic configuration from server
  const [topicConfig, setTopicConfig] = useState<ExamTopicConfig | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [topicName, setTopicName] = useState<string>('')
  const [topicDescription, setTopicDescription] = useState<string>('')
  const [topicDuration, setTopicDuration] = useState<{
    intro: number
    exam: number
    review: number
  } | null>(null)
  const [topicInstructions, setTopicInstructions] = useState<string>('')
  const [topicVideo, setTopicVideo] = useState<ExamVideoAttachment | undefined>(undefined)
  const [topicSubmitHint, setTopicSubmitHint] = useState<string>('')

  const examData = useMemo(
    () => buildExamData(topicConfig, questions, topicName, topicDescription),
    [topicConfig, questions, topicName, topicDescription]
  )

  // Build answerSlots map for all questions
  const answerSlotsMap = useMemo(() => {
    const map: Record<number, AnswerSlot[]> = {}
    for (const topic of examData.topics) {
      if (topic.answerSlots) {
        map[topic.id] = topic.answerSlots
      }
    }
    return map
  }, [examData.topics])

  const questionIds = useMemo(() => questions.map(q => q.id), [questions])

  // Memoize the selected topic to prevent unnecessary re-renders of ExamTopicDetail
  const selectedTopicData = useMemo(() => {
    if (selectedTopic === null || !examData.topics[selectedTopic]) return null
    return examData.topics[selectedTopic]
  }, [examData.topics, selectedTopic])

  const {
    phase: examPhase,
    remainingSeconds: timeLeft,
    isCompleted,
    examDurationSeconds,
    isOvertime,
    showTimer,
  } = useExamTimer({
    session: examSession,
  })

  // Question data using dynamic slots
  const [questionData, setQuestionData] = useState<DynamicQuestionDataMap>({})

  const [showPreviewConfirmModal, setShowPreviewConfirmModal] = useState(false)
  const [showFinalConfirmModal, setShowFinalConfirmModal] = useState(false)
  const [showTimeWarning, setShowTimeWarning] = useState(false)
  const [timeWarningShown, setTimeWarningShown] = useState(false)

  // Auto-save hook for text/link inputs in answer slots
  const {
    triggerSave: triggerTextSave,
    flushSave: flushTextSave,
    saveStatus: textSaveStatus,
    lastSavedAt: textLastSavedAt,
    hasUnsavedChanges: hasUnsavedTextChanges,
  } = useAutoSave<{
    questionId: number
    answers: Record<string, SlotAnswer>
  }>({
    onSave: async ({ questionId, answers }) => {
      try {
        await updateExamAttachments(topicId, {
          selectedQuestionId: questionId,
          content_data: { answers },
        })
      } catch (error) {
        console.error('Failed to auto-save text/link content:', error)
        throw error
      }
    },
    delay: 2000,
    enabled: examPhase === 'exam' && selectedTopic !== null,
  })

  // Warn user about unsaved changes on page leave
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (textSaveStatus === 'saving' || textSaveStatus === 'error' || hasUnsavedTextChanges) {
        e.preventDefault()
        e.returnValue = t('exam.modal.leave_description')
        return e.returnValue
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [textSaveStatus, hasUnsavedTextChanges, t])

  useEffect(() => {
    if (questionIds.length > 0) {
      setQuestionData(createInitialDynamicQuestionDataMap(questionIds, answerSlotsMap))
    }
  }, [questionIds, answerSlotsMap])

  useEffect(() => {
    if (isUserLoading) return

    if (!user) {
      toast({
        title: t('errors.login_required'),
        description: t('errors.please_login'),
        variant: 'destructive',
      })
      router.push('/login')
      return
    }

    async function checkPermissionAndLoadData() {
      try {
        const data = await getExamData(topicId)
        setExamSession(data.session)

        // Set topic name from API response
        if (data.topic?.name) {
          setTopicName(data.topic.name)
        }

        // Read description and duration directly from extra_data
        if (data.topic?.extra_data && typeof data.topic.extra_data === 'object') {
          const extraData = data.topic.extra_data as unknown as Record<string, unknown>
          // Description from extra_data
          if (typeof extraData.description === 'string') {
            setTopicDescription(extraData.description)
          } else if (extraData.description === undefined) {
            // Description was cleared, reset to empty string
            setTopicDescription('')
          }
          // Duration from extra_data.duration
          if (extraData.duration && typeof extraData.duration === 'object') {
            const duration = extraData.duration as unknown as {
              exam?: number
              intro?: number
              review?: number
            }
            // Store duration for later use
            setTopicDuration({
              intro: duration.intro ?? 5,
              exam: duration.exam ?? 50,
              review: duration.review ?? 5,
            })
          }
        }

        // Parse topic configuration from extra_data
        if (data.topic?.extra_data) {
          const extraData = data.topic.extra_data as unknown as Record<string, unknown>

          // Load instructions from extra_data (for custom exam info display)
          if (typeof extraData.instructions === 'string') {
            setTopicInstructions(extraData.instructions)
          }

          // Load video from extra_data
          if (extraData.video && typeof extraData.video === 'object') {
            setTopicVideo(extraData.video as ExamVideoAttachment)
          }

          // Load submit hint from extra_data
          if (typeof extraData.submit_hint === 'string') {
            setTopicSubmitHint(extraData.submit_hint)
          }

          if (isExamTopicConfig(data.topic.extra_data)) {
            setTopicConfig(data.topic.extra_data)
          } else {
            // Use defaults if not in new format
            setTopicConfig(null)
          }
        }

        // Set questions
        if (data.questions) {
          setQuestions(data.questions)
        }

        if (data.session?.selected_question_id) {
          const questionIndex = data.questions.findIndex(
            q => q.id === data.session.selected_question_id
          )
          setSelectedTopic(questionIndex >= 0 ? questionIndex : null)
        }
        setPermissionState('granted')
      } catch (error: unknown) {
        console.error('Failed to load exam data:', error)
        const err = error as { status?: number; message?: string }
        if (err?.status === 403 || err?.message?.includes('permission')) {
          setPermissionState('denied')
          toast({
            title: t('errors.load_failed'),
            description: t('errors.permission_denied'),
            variant: 'destructive',
          })
          router.push('/chat')
        } else {
          setPermissionState('granted')
        }
      } finally {
        setLoading(false)
      }
    }

    checkPermissionAndLoadData()
  }, [user, isUserLoading, router, toast, t, topicId])

  usePageVisibility({
    onVisible: () => {
      getExamData(topicId)
        .then(data => setExamSession(data.session))
        .catch(e => console.error('Failed to sync exam session on visibility change:', e))
    },
    minHiddenTime: 1000,
  })

  useEffect(() => {
    if (
      examPhase === 'exam' &&
      timeLeft <= 5 * 60 &&
      timeLeft > 4 * 60 &&
      !timeWarningShown &&
      !isCompleted
    ) {
      setShowTimeWarning(true)
      setTimeWarningShown(true)
    }
  }, [examPhase, timeLeft, timeWarningShown, isCompleted])

  useEffect(() => {
    const originalBodyOverflow = document.body.style.overflow
    const originalBodyOverflowX = document.body.style.overflowX
    const originalHtmlOverflow = document.documentElement.style.overflow
    const originalHtmlOverflowX = document.documentElement.style.overflowX

    document.body.style.overflow = 'visible'
    document.body.style.overflowX = 'visible'
    document.documentElement.style.overflow = 'visible'
    document.documentElement.style.overflowX = 'visible'

    return () => {
      document.body.style.overflow = originalBodyOverflow
      document.body.style.overflowX = originalBodyOverflowX
      document.documentElement.style.overflow = originalHtmlOverflow
      document.documentElement.style.overflowX = originalHtmlOverflowX
    }
  }, [])

  // Anti-copy protection: prevent right-click and copy keyboard shortcuts
  useEffect(() => {
    // Prevent context menu (right-click)
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      return false
    }

    // Prevent copy keyboard shortcuts (Ctrl+C, Cmd+C, Ctrl+X, Cmd+X)
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for copy (Ctrl+C or Cmd+C)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        return false
      }
      // Check for cut (Ctrl+X or Cmd+X)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault()
        return false
      }
      // Check for select all (Ctrl+A or Cmd+A)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        // Allow select all within input/textarea only
        const target = e.target as HTMLElement
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        if (!isInput) {
          e.preventDefault()
          return false
        }
      }
    }

    // Prevent drag start
    const handleDragStart = (e: DragEvent) => {
      e.preventDefault()
      return false
    }

    // Prevent copy event
    const handleCopy = (e: ClipboardEvent) => {
      e.preventDefault()
      return false
    }

    // Add event listeners
    document.addEventListener('contextmenu', handleContextMenu, true)
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('dragstart', handleDragStart, true)
    document.addEventListener('copy', handleCopy, true)

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('dragstart', handleDragStart, true)
      document.removeEventListener('copy', handleCopy, true)
    }
  }, [])

  // Track if user has made any local changes to prevent overwriting with server data
  const hasLocalChangesRef = useRef(false)

  // Load existing answer data for all questions
  useEffect(() => {
    async function loadExistingAnswer() {
      // Skip loading if data already loaded or dependencies not ready
      if (dataLoadedRef.current || !examSession || Object.keys(answerSlotsMap).length === 0) return
      // BUG FIX: Skip loading if there are local changes to prevent overwriting local state
      // This fixes the "text rollback" bug where deleting to empty would restore old server data
      if (hasLocalChangesRef.current) return

      dataLoadedRef.current = true

      try {
        const data = await getExamData(topicId)
        let loadedData: typeof questionData = {}

        if (data.allAnswers && Object.keys(data.allAnswers).length > 0) {
          loadedData = buildDynamicQuestionDataMapFromAnswers(data.allAnswers, answerSlotsMap)
          setQuestionData(prev => ({ ...prev, ...loadedData }))
        } else if (data.userAnswer?.content_data) {
          const content = data.userAnswer.content_data
          const questionId = content.selectedTopicId

          if (questionId) {
            const slots = answerSlotsMap[questionId] || []
            const answers = extractAttachmentsFromContent(content, slots)
            const questionState = { answers }
            loadedData = { [questionId]: questionState }
            setQuestionData(prev => ({ ...prev, ...loadedData }))
          }
        }
      } catch (error) {
        console.error('Failed to load existing answer:', error)
        dataLoadedRef.current = false
      }
    }
    loadExistingAnswer()
  }, [examSession, topicId, answerSlotsMap])

  const progressSteps = useMemo(() => {
    const anyQuestionSelected = selectedTopic !== null
    const currentQuestionId = selectedTopic !== null ? questionIds[selectedTopic] : null
    const currentData = currentQuestionId !== null ? questionData[currentQuestionId] : null
    const slots = currentQuestionId !== null ? answerSlotsMap[currentQuestionId] || [] : []

    // Generate progress steps from required slots (excluding bonus slots)
    const steps: Array<{ label: string; done: boolean }> = []

    // Add steps for required slots
    for (const slot of slots) {
      if (slot.required && !slot.isBonus) {
        const answer = currentData?.answers[slot.key]
        const hasContent = Boolean(
          (answer?.files && answer.files.length > 0) ||
          (answer?.text && answer.text.trim() !== '') ||
          (answer?.link && answer.link.trim() !== '')
        )
        steps.push({
          label: slot.label,
          done: anyQuestionSelected && hasContent,
        })
      }
    }

    return steps
  }, [selectedTopic, questionData, questionIds, answerSlotsMap])

  const timerColor = useMemo(() => getTimerColorClass(timeLeft, isOvertime), [timeLeft, isOvertime])

  const currentQuestionId = selectedTopic !== null ? questionIds[selectedTopic] : null
  const currentQuestionData = currentQuestionId !== null ? questionData[currentQuestionId] : null

  // Get answerSlots for current question
  const currentAnswerSlots = useMemo(() => {
    if (currentQuestionId === null) return []
    return answerSlotsMap[currentQuestionId] || []
  }, [currentQuestionId, answerSlotsMap])

  // Get current answers for dynamic upload zone
  const currentAnswers = useMemo((): Record<string, SlotAnswer> => {
    if (!currentQuestionData) return {}
    return currentQuestionData.answers || {}
  }, [currentQuestionData])

  const hasRequiredContent = hasDynamicRequiredFiles(currentAnswers, currentAnswerSlots)

  // BUG FIX: Block submission when there are unsaved text changes to prevent data loss
  // This fixes the race condition where paste + quick submit would save empty data
  const isSubmitReady =
    selectedTopic !== null &&
    hasRequiredContent &&
    participantName.trim().length > 0 &&
    !isCompleted &&
    !hasUnsavedTextChanges

  const startAnswering = async () => {
    if (isTransitioning) return
    setIsTransitioning(true)

    try {
      if (examPhase === 'ready') {
        const data = await getExamData(topicId, true)
        setExamSession(data.session)
        if (data.session?.selected_question_id) {
          const questionIndex = questions.findIndex(q => q.id === data.session.selected_question_id)
          setSelectedTopic(questionIndex >= 0 ? questionIndex : null)
        }
        // Auto-select the only question when there's only one question
        if (questions.length === 1) {
          setSelectedTopic(0)
        }
      } else if (examPhase === 'intro') {
        const result = await advanceExamPhase(topicId, 'exam')
        setExamSession(result.session)
        // Auto-select the only question when entering exam phase
        if (questions.length === 1) {
          const questionId = questionIds[0]
          const slots = answerSlotsMap[questionId] || []
          await selectExamQuestion(topicId, questionId)
          const data = await getExamData(topicId)
          if (data.userAnswer?.content_data) {
            const content = data.userAnswer.content_data
            const answers = extractAttachmentsFromContent(content, slots)
            const questionState = { answers }
            setQuestionData(prev => ({
              ...prev,
              [questionId]: questionState,
            }))
          }
          setSelectedTopic(0)
        }
      }
    } catch (error) {
      console.error('Failed to start/enter exam:', error)
      try {
        const data = await getExamData(topicId)
        setExamSession(data.session)
      } catch (e) {
        console.error('Failed to refresh session:', e)
      }
    } finally {
      setIsTransitioning(false)
    }
  }

  const [selectingTopic, setSelectingTopic] = useState<number | null>(null)

  const handleTopicSelect = async (topicIndex: number | null) => {
    if (selectingTopic !== null) return

    if (topicIndex !== null) {
      setSelectingTopic(topicIndex)
      try {
        const questionId = questionIds[topicIndex]
        const slots = answerSlotsMap[questionId] || []
        await selectExamQuestion(topicId, questionId)
        const data = await getExamData(topicId)
        if (data.userAnswer?.content_data) {
          const content = data.userAnswer.content_data
          const answers = extractAttachmentsFromContent(content, slots)
          const questionState = { answers }

          setQuestionData(prev => ({
            ...prev,
            [questionId]: questionState,
          }))
        }
        setSelectedTopic(topicIndex)
      } catch (error) {
        console.error('Failed to select question:', error)
      } finally {
        setSelectingTopic(null)
      }
    } else {
      setSelectedTopic(null)
    }
  }

  const enterPreviewMode = async () => {
    setShowPreviewConfirmModal(false)
    setIsTransitioning(true)
    try {
      // BUG FIX: Force save all text inputs before advancing phase
      // This ensures all content is persisted to backend before review
      await flushTextSave()
      const result = await advanceExamPhase(topicId, 'review')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to enter preview mode:', error)
    } finally {
      setIsTransitioning(false)
    }
  }

  const returnToExam = async () => {
    setIsTransitioning(true)
    try {
      const result = await advanceExamPhase(topicId, 'exam')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to return to exam:', error)
    } finally {
      setIsTransitioning(false)
    }
  }

  const confirmFinalSubmit = async () => {
    setShowFinalConfirmModal(false)
    setIsTransitioning(true)
    try {
      // BUG FIX: Force save all text inputs before final submission
      // This ensures all content is persisted to backend before completing exam
      await flushTextSave()
      const result = await advanceExamPhase(topicId, 'completed')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to complete exam:', error)
    } finally {
      setIsTransitioning(false)
    }
  }

  if (isUserLoading || !user || permissionState === 'checking') {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-text-secondary">{t('exam.loading')}</p>
        </div>
      </div>
    )
  }

  if (permissionState === 'denied') {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-text-secondary">{t('exam.loading')}</p>
        </div>
      </div>
    )
  }

  // Grid layout: 1 question = full width, 2 questions = 2 cols, 3+ = 3 cols
  const gridClass =
    questions.length === 1
      ? 'md:grid-cols-1'
      : questions.length === 2
        ? 'md:grid-cols-2'
        : 'md:grid-cols-3'

  return (
    <div className="exam-page min-h-screen bg-[#fafbfc] overflow-visible" data-theme="light">
      <UsernameWatermark username={participantName} />
      <ExamHeader
        title={examData.title}
        year={examData.year}
        progressSteps={progressSteps}
        timeLeft={timeLeft}
        timerColor={timerColor}
        showTimer={showTimer}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-10">
        <ExamInfoSection
          title={examData.title}
          year={examData.year}
          rules={examData.rules}
          examMethod={examData.examMethod}
          timeNote={examData.timeNote}
          examPhase={examPhase}
          loading={loading}
          isTransitioning={isTransitioning}
          onStartAnswering={startAnswering}
          video={topicVideo || topicConfig?.video}
          instructions={topicInstructions}
          examDurationMinutes={topicDuration?.exam ?? examData.duration.exam}
          description={examData.description}
        />

        {(examPhase === 'exam' || examPhase === 'review') && (
          <ParticipantInfoSection participantName={participantName} />
        )}

        {(examPhase === 'exam' || examPhase === 'review') && (
          <section className="animate-[fadeIn_0.3s_ease-out]">
            {/* Only show question selection header and cards when there are multiple questions */}
            {questions.length > 1 && (
              <div className="flex items-center gap-3 mb-6">
                <div className="w-1.5 h-7 bg-[#DF2029] rounded-full" />
                <h2 className="text-xl font-bold text-gray-900">
                  {examPhase === 'review' ? t('exam.topic.title_selected') : t('exam.topic.title')}
                </h2>
              </div>
            )}
            {examPhase === 'review' && selectedTopic !== null ? (
              <div className="mb-6">
                {/* Show topic cards only when there are multiple questions */}
                {questions.length > 1 && (
                  <div className={`grid grid-cols-1 ${gridClass} gap-5 mb-6`}>
                    {examData.topics.map((topic, i) => (
                      <AIAssessmentTopicCard
                        key={topic.id}
                        topic={topic}
                        selected={selectedTopic === i}
                        disabled={selectingTopic !== null}
                        onClick={() => handleTopicSelect(i)}
                        displayIndex={i + 1}
                      />
                    ))}
                  </div>
                )}
                <div className="mt-6">
                  <ExamTopicDetail topic={selectedTopicData!} />
                </div>
              </div>
            ) : examPhase === 'review' ? (
              <div className="text-gray-500 py-4">{t('exam.confirm.not_selected_topic')}</div>
            ) : (
              <>
                {/* Show topic cards only when there are multiple questions */}
                {questions.length > 1 && (
                  <div className={`grid grid-cols-1 ${gridClass} gap-5 mb-6`}>
                    {examData.topics.map((topic, i) => (
                      <AIAssessmentTopicCard
                        key={topic.id}
                        topic={topic}
                        selected={selectedTopic === i}
                        disabled={(isCompleted && selectedTopic !== i) || selectingTopic !== null}
                        onClick={() =>
                          !isCompleted &&
                          !selectingTopic &&
                          handleTopicSelect(selectedTopic === i ? null : i)
                        }
                        displayIndex={i + 1}
                      />
                    ))}
                  </div>
                )}
                {selectedTopic !== null && selectedTopicData && (
                  <ExamTopicDetail topic={selectedTopicData} />
                )}
              </>
            )}
          </section>
        )}

        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <BonusItemsSection slots={currentAnswerSlots} />
        )}

        {(examPhase === 'exam' || examPhase === 'review') &&
          selectedTopic !== null &&
          currentAnswerSlots.length > 0 && (
            <DynamicAnswerUploadZone
              topicId={topicId}
              questionId={currentQuestionId!}
              answerSlots={currentAnswerSlots}
              answers={currentAnswers}
              onChange={(slotKey: string, value: SlotAnswer) => {
                // Mark that user has made local changes to prevent server data overwrite
                hasLocalChangesRef.current = true
                setQuestionData(prev => ({
                  ...prev,
                  [currentQuestionId!]: {
                    ...prev[currentQuestionId!],
                    answers: {
                      ...prev[currentQuestionId!].answers,
                      [slotKey]: value,
                    },
                  },
                }))
              }}
              onAnswersUpdate={async (answers: Record<string, SlotAnswer>) => {
                try {
                  await updateExamAttachments(topicId, {
                    selectedQuestionId: currentQuestionId!,
                    content_data: {
                      answers,
                    },
                  })
                } catch (error) {
                  console.error('Failed to update attachments:', error)
                }
              }}
              disabled={examPhase !== 'exam'}
              totalFileLimit={20}
              onLimitExceeded={() => {
                toast({
                  title: t('errors.save_failed'),
                  description: t('exam.submit.file_limit', { count: 20 }),
                  variant: 'destructive',
                })
              }}
              onTextChange={(_slotKey: string) => {
                // Trigger debounced auto-save for text/link changes
                const questionId = currentQuestionId!
                const answers = questionData[questionId]?.answers || {}
                triggerTextSave({ questionId, answers })
              }}
              textSaveStatus={Object.fromEntries(
                currentAnswerSlots
                  .filter(s => s.inputMode === 'text' || s.inputMode === 'link+attachment')
                  .map(s => [s.key, textSaveStatus])
              )}
              textLastSavedAt={Object.fromEntries(
                currentAnswerSlots
                  .filter(s => s.inputMode === 'text' || s.inputMode === 'link+attachment')
                  .map(s => [s.key, textLastSavedAt])
              )}
            />
          )}

        {/* Unified Submit Button - Exam Phase */}
        {examPhase === 'exam' && selectedTopic !== null && !isCompleted && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <h3 className="text-base font-bold text-gray-700 mb-5">{t('exam.submit.title')}</h3>
              <div
                className={`grid gap-3 mb-5 ${
                  progressSteps.length === 1
                    ? 'grid-cols-1'
                    : progressSteps.length === 2
                      ? 'grid-cols-2'
                      : progressSteps.length === 3
                        ? 'grid-cols-3'
                        : progressSteps.length === 4
                          ? 'grid-cols-2 sm:grid-cols-4'
                          : progressSteps.length === 5
                            ? 'grid-cols-2 sm:grid-cols-5'
                            : progressSteps.length === 6
                              ? 'grid-cols-2 sm:grid-cols-3'
                              : 'grid-cols-2 sm:grid-cols-4'
                }`}
              >
                {progressSteps.map((item, _index) => (
                  <div
                    key={_index}
                    className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium ${
                      item.done ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-400'
                    }`}
                  >
                    {item.done ? (
                      <Icon name="checkCircle" size={18} className="text-green-500" />
                    ) : (
                      <div className="w-[18px] h-[18px] rounded-full border-2 flex-shrink-0 border-red-300" />
                    )}
                    <span>
                      {item.label}
                      {!item.done ? ' *' : ''}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-col items-center space-y-4">
                <div className="text-sm text-gray-500 text-center">
                  <p>
                    {t('exam.submit.file_limit', {
                      count: (() => {
                        const currentData = questionData[currentQuestionId!]
                        if (!currentData) return 0
                        const answerFiles = Object.values(currentData.answers || {}).reduce(
                          (sum, answer) => sum + (answer.files?.length || 0),
                          0
                        )
                        return answerFiles
                      })(),
                    })}
                  </p>
                </div>
                {topicSubmitHint && (
                  <div className="w-full max-w-3xl mx-auto text-center text-gray-500">
                    <SubmitHintMarkdown content={topicSubmitHint} />
                  </div>
                )}
                <div className="text-sm text-gray-500 text-center">
                  <p>{t('exam.submit.confirm_description')}</p>
                  <p className="text-xs text-gray-500 mt-1">{t('exam.submit.confirm_hint')}</p>
                </div>
              </div>

              <div className="flex justify-center">
                <button
                  onClick={async () => {
                    // BUG FIX: Force save all text inputs when clicking preview button
                    // This ensures content is persisted before showing confirm dialog
                    if (hasUnsavedTextChanges) {
                      await flushTextSave()
                    }
                    setShowPreviewConfirmModal(true)
                  }}
                  disabled={isTransitioning || !isSubmitReady}
                  className={`mt-4 px-10 py-3.5 text-lg font-bold rounded-2xl transition-all active:scale-[0.98] ${
                    isSubmitReady
                      ? 'bg-[#DF2029] hover:bg-[#c81d25] text-white shadow-lg shadow-red-200/50 hover:shadow-red-300/60'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  } ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning
                    ? t('exam.loading')
                    : hasUnsavedTextChanges
                      ? t('exam.saving')
                      : t('exam.confirm.confirm')}
                </button>
              </div>
            </div>
          </section>
        )}

        {examPhase === 'review' && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              {topicSubmitHint && (
                <div className="w-full max-w-3xl mx-auto text-center text-gray-500">
                  <SubmitHintMarkdown content={topicSubmitHint} />
                </div>
              )}
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-4">
                <button
                  onClick={returnToExam}
                  disabled={isTransitioning}
                  className={`px-8 py-3.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-base font-bold rounded-2xl transition-all active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? t('exam.loading') : t('exam.confirm.back_to_exam')}
                </button>
                <button
                  onClick={() => setShowFinalConfirmModal(true)}
                  disabled={isTransitioning}
                  className={`px-10 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white text-lg font-bold rounded-2xl shadow-lg shadow-emerald-200/50 transition-all hover:shadow-emerald-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? t('exam.loading') : t('exam.confirm.final_submit')}
                </button>
              </div>
            </div>
          </section>
        )}

        {isCompleted && (
          <CompletedState
            examDurationSeconds={examDurationSeconds}
            hint={
              topicSubmitHint ? (
                <div className="w-full max-w-3xl mx-auto text-center text-gray-500">
                  <SubmitHintMarkdown content={topicSubmitHint} />
                </div>
              ) : null
            }
          />
        )}

        <div className="h-10" />
      </main>

      <PreviewConfirmModal
        isOpen={showPreviewConfirmModal}
        onClose={() => setShowPreviewConfirmModal(false)}
        onConfirm={enterPreviewMode}
      />

      <FinalConfirmModal
        isOpen={showFinalConfirmModal}
        onClose={() => setShowFinalConfirmModal(false)}
        onConfirm={confirmFinalSubmit}
      />

      <TimeWarningModal
        isOpen={showTimeWarning}
        onClose={() => setShowTimeWarning(false)}
        remainingMinutes={5}
      />
    </div>
  )
}
