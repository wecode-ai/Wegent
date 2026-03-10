// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useExamTimer } from '@wecode/components/evaluation/exam/hooks/useExamTimer'
import { useAutoSave } from '@wecode/components/evaluation/exam/hooks/useAutoSave'
import { SlotBasedFileUpload } from '@wecode/components/evaluation/exam/SlotBasedFileUpload'
import {
  getExamData,
  updateExamAttachments,
  selectExamQuestion,
  advanceExamPhase,
} from '@wecode/api/evaluation-exam'
import type { ExamAttachment, ExamSessionStatus } from '@wecode/types/evaluation-exam'

// Import extracted components
import {
  Icon,
  AIAssessmentTopicCard,
  AIAssessmentTopicDetail,
  ExamHeader,
  ExamInfoSection,
  BonusItemsSection,
  SupplementaryNotesSection,
  ParticipantInfoSection,
  CompletedState,
  PreviewConfirmModal,
  FinalConfirmModal,
  TimeWarningModal,
} from '@wecode/components/evaluation/exam'

// Import exam-specific types and utilities from shared components
import {
  type PermissionState,
  type QuestionDataMap,
  createInitialQuestionDataMap,
  buildQuestionDataMapFromAnswers,
  hasSupplementaryNotes,
  getTimerColorClass,
  // Exam data for topic id=2, questions 4,5
  EXAM_DATA_V2,
  UPLOAD_SLOTS_CONFIG_V2,
} from '@wecode/components/evaluation/exam'

/**
 * AI Assessment 2026 Exam Page V2
 *
 * This page implements the AI Assessment 2026 exam interface with:
 * - Hardcoded exam data specific to the 2026 AI assessment (new questions)
 * - Multi-phase exam flow (ready -> intro -> exam -> review -> completed)
 * - Topic selection with detailed requirements
 * - File upload slots for deliverables
 * - Supplementary notes with real-time sync
 * - Timer and progress tracking
 *
 * Topic ID: 2
 * Question IDs: 4, 5
 */

// Build upload slots with icons
const UPLOAD_SLOTS = UPLOAD_SLOTS_CONFIG_V2.map(slot => ({
  ...slot,
  icon: <Icon name={slot.iconName} size={18} className={slot.iconClass} />,
}))

// Question IDs for the exam (4, 5)
const QUESTION_IDS = EXAM_DATA_V2.topics.map(t => t.id)

// Topic ID for this exam
const TOPIC_ID = 2

export default function AIAssessment2026V2Page() {
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

  // Use exam timer hook for accurate timing based on server timestamps
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

  // Per-question state
  const [questionData, setQuestionData] = useState<QuestionDataMap>(
    createInitialQuestionDataMap(QUESTION_IDS)
  )

  // Modal states
  const [showPreviewConfirmModal, setShowPreviewConfirmModal] = useState(false)
  const [showFinalConfirmModal, setShowFinalConfirmModal] = useState(false)
  const [showTimeWarning, setShowTimeWarning] = useState(false)
  const [timeWarningShown, setTimeWarningShown] = useState(false)

  // Check login status and permission after user data is loaded
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
        const data = await getExamData(TOPIC_ID)
        setExamSession(data.session)
        if (data.session?.selected_question_id) {
          // Map question_id to topic index (4->0, 5->1)
          const questionIndex = data.session.selected_question_id - 4
          setSelectedTopic(
            questionIndex >= 0 && questionIndex < QUESTION_IDS.length ? questionIndex : null
          )
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
  }, [user, isUserLoading, router, toast, t])

  // Sync with server when page becomes visible after being hidden
  usePageVisibility({
    onVisible: () => {
      getExamData(TOPIC_ID)
        .then(data => setExamSession(data.session))
        .catch(e => console.error('Failed to sync exam session on visibility change:', e))
    },
    minHiddenTime: 1000,
  })

  // Show time warning when 5 minutes remaining during exam phase
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

  // Fix sticky header by overriding body overflow
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

  // Load existing answer data for all questions
  useEffect(() => {
    async function loadExistingAnswer() {
      if (dataLoadedRef.current || !examSession) return
      dataLoadedRef.current = true

      try {
        const data = await getExamData(TOPIC_ID)

        // Load answers for all questions from allAnswers
        if (data.allAnswers && Object.keys(data.allAnswers).length > 0) {
          const parsedData = buildQuestionDataMapFromAnswers(data.allAnswers)
          setQuestionData(prev => ({ ...prev, ...parsedData }))
        }
        // Fallback: also check userAnswer for backward compatibility
        else if (data.userAnswer?.content_data) {
          const content = data.userAnswer.content_data
          const questionId = content.selectedTopicId

          if (questionId) {
            setQuestionData(prev => ({
              ...prev,
              [questionId]: {
                attachments: {
                  main: content.attachments?.main || [],
                  interaction: content.attachments?.interaction || [],
                  bonusAgent: content.attachments?.bonusAgent?.files || [],
                  bonusMultimodal: content.attachments?.bonusMultimodal || [],
                },
                supplementaryNotesFiles: content.attachments?.supplementaryNotes || [],
                supplementaryNotes: content.inputs?.supplementaryNotes || '',
                linkValues: {
                  bonusAgent: content.attachments?.bonusAgent?.link || '',
                },
              },
            }))
          }
        }
      } catch (error) {
        console.error('Failed to load existing answer:', error)
        dataLoadedRef.current = false
      }
    }
    loadExistingAnswer()
  }, [examSession])

  // Auto-save hook for supplementary notes - saves text directly to DB, NO S3 conversion
  // S3 conversion only happens when entering review phase (handled by backend)
  // Note: includes questionId in data to avoid race conditions when switching topics
  const {
    triggerSave: triggerNotesSave,
    flushSave: flushNotesSave,
    saveStatus: notesSaveStatus,
    lastSavedAt: notesLastSavedAt,
    manualSave: manualSaveNotes,
  } = useAutoSave<{
    questionId: number
    notes: string
  }>({
    onSave: async ({ questionId, notes }) => {
      try {
        await updateExamAttachments(TOPIC_ID, {
          selectedQuestionId: questionId,
          content_data: {
            inputs: {
              supplementaryNotes: notes,
            },
          },
        })
      } catch (error) {
        console.error('Failed to auto-save supplementary notes:', error)
        throw error
      }
    },
    delay: 2000,
    enabled: examPhase === 'exam' && selectedTopic !== null,
  })

  // Warn user if they try to leave with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (notesSaveStatus === 'saving' || notesSaveStatus === 'error') {
        e.preventDefault()
        e.returnValue = '您有未保存的更改，确定要离开吗？'
        return e.returnValue
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [notesSaveStatus])

  // Computed values
  const progressSteps = useMemo(() => {
    const anyQuestionSelected = selectedTopic !== null
    const currentQuestionId = selectedTopic !== null ? QUESTION_IDS[selectedTopic] : null
    const currentData = currentQuestionId !== null ? questionData[currentQuestionId] : null

    return [
      { label: '填写说明', done: anyQuestionSelected && hasSupplementaryNotes(currentData) },
      {
        label: '上传交互记录',
        done: anyQuestionSelected && (currentData?.attachments.interaction.length ?? 0) > 0,
      },
      {
        label: '上传报告',
        done: anyQuestionSelected && (currentData?.attachments.main.length ?? 0) > 0,
      },
    ]
  }, [selectedTopic, questionData])

  const timerColor = useMemo(() => getTimerColorClass(timeLeft, isOvertime), [timeLeft, isOvertime])

  const currentQuestionId = selectedTopic !== null ? QUESTION_IDS[selectedTopic] : null
  const currentQuestionData = currentQuestionId !== null ? questionData[currentQuestionId] : null
  const hasMainReport = (currentQuestionData?.attachments.main.length ?? 0) > 0
  const hasInteractionRecord = (currentQuestionData?.attachments.interaction.length ?? 0) > 0
  const hasNotes = hasSupplementaryNotes(currentQuestionData)

  const isSubmitReady =
    selectedTopic !== null &&
    hasMainReport &&
    hasInteractionRecord &&
    hasNotes &&
    participantName.trim().length > 0 &&
    !isCompleted

  // Handlers
  const startAnswering = async () => {
    if (isTransitioning) return
    setIsTransitioning(true)

    try {
      if (examPhase === 'ready') {
        const data = await getExamData(TOPIC_ID, true)
        setExamSession(data.session)
        if (data.session?.selected_question_id) {
          const questionIndex = data.session.selected_question_id - 4
          setSelectedTopic(
            questionIndex >= 0 && questionIndex < QUESTION_IDS.length ? questionIndex : null
          )
        }
      } else if (examPhase === 'intro') {
        const result = await advanceExamPhase(TOPIC_ID, 'exam')
        setExamSession(result.session)
      }
    } catch (error) {
      console.error('Failed to start/enter exam:', error)
      try {
        const data = await getExamData(TOPIC_ID)
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
    if (selectingTopic !== null) return // Prevent multiple clicks

    // Flush any pending saves before switching
    await flushNotesSave()

    if (topicIndex !== null) {
      setSelectingTopic(topicIndex)
      try {
        const questionId = QUESTION_IDS[topicIndex]
        await selectExamQuestion(TOPIC_ID, questionId)
        const data = await getExamData(TOPIC_ID)
        if (data.userAnswer?.content_data) {
          const content = data.userAnswer.content_data

          setQuestionData(prev => ({
            ...prev,
            [questionId]: {
              attachments: {
                main: content.attachments?.main || [],
                interaction: content.attachments?.interaction || [],
                bonusAgent: content.attachments?.bonusAgent?.files || [],
                bonusMultimodal: content.attachments?.bonusMultimodal || [],
              },
              supplementaryNotesFiles: content.attachments?.supplementaryNotes || [],
              supplementaryNotes: content.inputs?.supplementaryNotes || '',
              linkValues: {
                bonusAgent: content.attachments?.bonusAgent?.link || '',
              },
            },
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

  const handleNotesChange = useCallback(
    (notes: string) => {
      const questionId = QUESTION_IDS[selectedTopic!]
      setQuestionData(prev => ({
        ...prev,
        [questionId]: {
          ...prev[questionId],
          supplementaryNotes: notes,
        },
      }))
      // Pass both questionId and notes to avoid race conditions when switching topics
      triggerNotesSave({ questionId, notes })
    },
    [selectedTopic, triggerNotesSave]
  )

  // Handle blur - flush pending saves immediately
  const handleNotesBlur = useCallback(async () => {
    await flushNotesSave()
  }, [flushNotesSave])

  // Handle manual save
  const handleManualSave = useCallback(async () => {
    if (selectedTopic === null) return
    const questionId = QUESTION_IDS[selectedTopic]
    const notes = questionData[questionId]?.supplementaryNotes || ''
    await manualSaveNotes({ questionId, notes })
  }, [selectedTopic, questionData, manualSaveNotes])

  const enterPreviewMode = async () => {
    setShowPreviewConfirmModal(false)
    setIsTransitioning(true)
    try {
      // Flush any pending saves
      await flushNotesSave()

      // Advance to review phase (triggers S3 conversion on backend)
      const result = await advanceExamPhase(TOPIC_ID, 'review')
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
      const result = await advanceExamPhase(TOPIC_ID, 'exam')
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
      const result = await advanceExamPhase(TOPIC_ID, 'completed')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to complete exam:', error)
    } finally {
      setIsTransitioning(false)
    }
  }

  // Show loading state while checking auth and permission
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

  // Permission denied - don't render any content
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

  return (
    <div className="min-h-screen bg-[#fafbfc] overflow-visible">
      <ExamHeader
        title={EXAM_DATA_V2.title}
        year={EXAM_DATA_V2.year}
        progressSteps={progressSteps}
        timeLeft={timeLeft}
        timerColor={timerColor}
        showTimer={showTimer}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-10">
        <ExamInfoSection
          title={`微博高层管理人员 AI 应用能力考核（二）`}
          year={EXAM_DATA_V2.year}
          rules={EXAM_DATA_V2.rules}
          examMethod={EXAM_DATA_V2.examMethod}
          timeNote={EXAM_DATA_V2.timeNote}
          examPhase={examPhase}
          loading={loading}
          isTransitioning={isTransitioning}
          onStartAnswering={startAnswering}
        />

        {(examPhase === 'exam' || examPhase === 'review') && (
          <ParticipantInfoSection participantName={participantName} />
        )}

        {(examPhase === 'exam' || examPhase === 'review') && (
          <section className="animate-[fadeIn_0.3s_ease-out]">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1.5 h-7 bg-[#DF2029] rounded-full" />
              <h2 className="text-xl font-bold text-gray-900">
                {examPhase === 'review' ? '已选考核题目' : '选择考核题目'}
              </h2>
              {examPhase !== 'review' && (
                <span className="text-[1rem] text-gray-400 ml-1">
                  （考题二选一，如果多选，每个维度评分取多道题的高分）
                </span>
              )}
            </div>
            {examPhase === 'review' && selectedTopic !== null ? (
              <div className="mb-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
                  {EXAM_DATA_V2.topics.map((topic, i) => (
                    <AIAssessmentTopicCard
                      key={topic.id}
                      topic={topic}
                      selected={selectedTopic === i}
                      disabled={selectingTopic !== null} // Disable while loading
                      onClick={() => handleTopicSelect(i)}
                      displayIndex={i + 1}
                    />
                  ))}
                </div>
                <div className="mt-6">
                  <AIAssessmentTopicDetail topic={EXAM_DATA_V2.topics[selectedTopic]} />
                </div>
              </div>
            ) : examPhase === 'review' ? (
              <div className="text-gray-500 py-4">未选择题目</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
                  {EXAM_DATA_V2.topics.map((topic, i) => (
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
                {selectedTopic !== null && (
                  <AIAssessmentTopicDetail topic={EXAM_DATA_V2.topics[selectedTopic]} />
                )}
              </>
            )}
          </section>
        )}

        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <BonusItemsSection bonusItems={EXAM_DATA_V2.bonusItems} />
        )}

        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <SupplementaryNotesSection
            notes={currentQuestionData?.supplementaryNotes || ''}
            disabled={examPhase !== 'exam'}
            required={true}
            onNotesChange={handleNotesChange}
            onBlur={handleNotesBlur}
            onManualSave={handleManualSave}
            saveStatus={notesSaveStatus}
            lastSavedAt={notesLastSavedAt}
          />
        )}

        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <SlotBasedFileUpload
            topicId={TOPIC_ID}
            questionId={currentQuestionId!}
            slots={UPLOAD_SLOTS}
            attachments={currentQuestionData?.attachments || {}}
            onChange={(slot: string, newAttachments: ExamAttachment[]) => {
              setQuestionData(prev => ({
                ...prev,
                [currentQuestionId!]: {
                  ...prev[currentQuestionId!],
                  attachments: {
                    ...prev[currentQuestionId!].attachments,
                    [slot]: newAttachments,
                  },
                },
              }))
            }}
            onAttachmentsUpdate={async newAttachments => {
              try {
                await updateExamAttachments(TOPIC_ID, {
                  selectedQuestionId: currentQuestionId!,
                  content_data: {
                    attachments: {
                      main: newAttachments.main || [],
                      interaction: newAttachments.interaction || [],
                      bonusAgent: { files: newAttachments.bonusAgent || [] },
                      bonusMultimodal: newAttachments.bonusMultimodal || [],
                    },
                  },
                })
              } catch (error) {
                console.error('Failed to update attachments:', error)
              }
            }}
            linkValues={currentQuestionData?.linkValues || {}}
            onLinkChange={async (slot: string, value: string) => {
              setQuestionData(prev => ({
                ...prev,
                [currentQuestionId!]: {
                  ...prev[currentQuestionId!],
                  linkValues: {
                    ...prev[currentQuestionId!].linkValues,
                    [slot]: value,
                  },
                },
              }))

              try {
                const currentData = questionData[currentQuestionId!]
                await updateExamAttachments(TOPIC_ID, {
                  selectedQuestionId: currentQuestionId!,
                  content_data: {
                    attachments: {
                      main: currentData?.attachments?.main || [],
                      interaction: currentData?.attachments?.interaction || [],
                      bonusAgent: {
                        link:
                          slot === 'bonusAgent' ? value : currentData?.linkValues?.bonusAgent || '',
                        files: currentData?.attachments?.bonusAgent || [],
                      },
                      bonusMultimodal: currentData?.attachments?.bonusMultimodal || [],
                    },
                  },
                })
              } catch (error) {
                console.error('Failed to update link:', error)
              }
            }}
            disabled={examPhase !== 'exam'}
            totalFileLimit={20}
            currentTotalCount={currentQuestionData?.supplementaryNotesFiles?.length || 0}
            onLimitExceeded={() => {
              alert('每道题目总附件数（包括作答说明文件）不能超过 20 个，请先删除一些附件')
            }}
          />
        )}

        {/* Unified Submit Button - Exam Phase */}
        {examPhase === 'exam' && selectedTopic !== null && !isCompleted && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              {/* Submission Checklist */}
              <h3 className="text-base font-bold text-gray-700 mb-5">提交检查</h3>
              <div className="grid grid-cols-3 gap-3 mb-5">
                {[
                  { label: '已填写说明', done: hasNotes, required: true },
                  { label: '已上传交互记录', done: hasInteractionRecord, required: true },
                  { label: '已上传报告', done: hasMainReport, required: true },
                ].map((item, index) => (
                  <div
                    key={index}
                    className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium ${
                      item.done
                        ? 'bg-green-50 text-green-700'
                        : item.required
                          ? 'bg-red-50 text-red-400'
                          : 'bg-gray-50 text-gray-400'
                    }`}
                  >
                    {item.done ? (
                      <Icon name="checkCircle" size={18} className="text-green-500" />
                    ) : (
                      <div
                        className={`w-[18px] h-[18px] rounded-full border-2 flex-shrink-0 ${
                          item.required ? 'border-red-300' : 'border-gray-300'
                        }`}
                      />
                    )}
                    <span>
                      {item.label}
                      {item.required && !item.done ? ' *' : ''}
                    </span>
                  </div>
                ))}
              </div>

              {/* File Count Info */}
              <div className="text-sm text-gray-400 mb-5 text-center">
                <p>
                  每道题目总附件数不能超过 20 个，当前已上传{' '}
                  {(() => {
                    const currentData = questionData[currentQuestionId!]
                    if (!currentData) return 0
                    return (
                      (currentData.attachments?.main?.length || 0) +
                      (currentData.attachments?.interaction?.length || 0) +
                      (currentData.attachments?.bonusAgent?.length || 0) +
                      (currentData.attachments?.bonusMultimodal?.length || 0) +
                      (currentData.supplementaryNotesFiles?.length || 0)
                    )
                  })()}{' '}
                  个
                </p>
              </div>

              <div className="flex flex-col items-center gap-4">
                <div className="text-sm text-gray-500 text-center">
                  <p>请确认所有材料已上传完毕</p>
                  <p className="text-xs text-gray-400 mt-1">进入预览后仍可返回答题</p>
                </div>
                <button
                  onClick={() => setShowPreviewConfirmModal(true)}
                  disabled={isTransitioning || !isSubmitReady}
                  className={`px-10 py-3.5 text-lg font-bold rounded-2xl transition-all active:scale-[0.98] ${
                    isSubmitReady
                      ? 'bg-[#DF2029] hover:bg-[#c81d25] text-white shadow-lg shadow-red-200/50 hover:shadow-red-300/60'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  } ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '交卷预览'}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Review Phase Actions */}
        {examPhase === 'review' && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <button
                  onClick={returnToExam}
                  disabled={isTransitioning}
                  className={`px-8 py-3.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-base font-bold rounded-2xl transition-all active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '返回答题'}
                </button>
                <button
                  onClick={() => setShowFinalConfirmModal(true)}
                  disabled={isTransitioning}
                  className={`px-10 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white text-lg font-bold rounded-2xl shadow-lg shadow-emerald-200/50 transition-all hover:shadow-emerald-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '确认交卷'}
                </button>
              </div>
            </div>
          </section>
        )}

        {isCompleted && <CompletedState examDurationSeconds={examDurationSeconds} />}

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
