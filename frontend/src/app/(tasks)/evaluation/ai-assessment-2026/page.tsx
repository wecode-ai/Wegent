// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useExamTimer } from '@wecode/components/evaluation/exam/hooks/useExamTimer'
import { SlotBasedFileUpload } from '@wecode/components/evaluation/exam/SlotBasedFileUpload'
import {
  getExamData,
  submitExamAnswer,
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
  SubmitSection,
  ParticipantInfoSection,
  CompletedState,
  ConfirmModal,
  SuccessModal,
  EndExamConfirmModal,
  LeaveExamConfirmModal,
  TimeWarningModal,
} from '@wecode/components/evaluation/exam'

// Import exam-specific constants, types, and utilities from shared components
import {
  EXAM_DATA,
  UPLOAD_SLOTS_CONFIG,
  type PermissionState,
  type QuestionDataMap,
  createInitialQuestionDataMap,
  uploadSupplementaryNotes,
  buildQuestionDataMapFromAnswers,
  getTotalFileCount,
  hasRequiredFiles,
  hasSupplementaryNotes,
  getTimerColorClass,
} from '@wecode/components/evaluation/exam'

/**
 * AI Assessment 2026 Exam Page
 *
 * This page implements the AI Assessment 2026 exam interface with:
 * - Hardcoded exam data specific to the 2026 AI assessment
 * - Multi-phase exam flow (ready -> intro -> exam -> review -> completed)
 * - Topic selection with detailed requirements
 * - File upload slots for deliverables
 * - Supplementary notes with real-time sync
 * - Timer and progress tracking
 */

// Build upload slots with icons
const UPLOAD_SLOTS = UPLOAD_SLOTS_CONFIG.map(slot => ({
  ...slot,
  icon: <Icon name={slot.iconName} size={18} className={slot.iconClass} />,
}))

// Question IDs for the exam (1, 2, 3)
const QUESTION_IDS = EXAM_DATA.topics.map(t => t.id)

export default function AIAssessment2026Page() {
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
    submitCount,
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
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [showEndExamConfirm, setShowEndExamConfirm] = useState(false)
  const [showLeaveExamConfirm, setShowLeaveExamConfirm] = useState(false)
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
        const data = await getExamData(1)
        setExamSession(data.session)
        if (data.session?.selected_question_id) {
          setSelectedTopic(data.session.selected_question_id - 1)
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
      getExamData(1)
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
        const data = await getExamData(1)

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
                supplementaryNotesFiles: content.supplementaryNotesFiles || [],
                supplementaryNotes: content.supplementaryNotes || '',
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

  // Computed values
  const progressSteps = useMemo(() => {
    const anyQuestionSelected = selectedTopic !== null
    const currentQuestionId = selectedTopic !== null ? selectedTopic + 1 : null
    const currentData = currentQuestionId !== null ? questionData[currentQuestionId] : null

    return [
      { label: '选择题目', done: anyQuestionSelected },
      { label: '填写说明', done: anyQuestionSelected && hasSupplementaryNotes(currentData) },
      { label: '上传材料', done: anyQuestionSelected && hasRequiredFiles(currentData) },
      { label: '确认提交', done: submitCount > 0 },
    ]
  }, [selectedTopic, questionData, submitCount])

  const timerColor = useMemo(() => getTimerColorClass(timeLeft, isOvertime), [timeLeft, isOvertime])

  const currentQuestionData = selectedTopic !== null ? questionData[selectedTopic + 1] : null
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
        const data = await getExamData(1, true)
        setExamSession(data.session)
        if (data.session?.selected_question_id) {
          setSelectedTopic(data.session.selected_question_id - 1)
        }
      } else if (examPhase === 'intro') {
        const result = await advanceExamPhase(1, 'exam')
        setExamSession(result.session)
      }
    } catch (error) {
      console.error('Failed to start/enter exam:', error)
      try {
        const data = await getExamData(1)
        setExamSession(data.session)
      } catch (e) {
        console.error('Failed to refresh session:', e)
      }
    } finally {
      setIsTransitioning(false)
    }
  }

  const endAnswering = () => setShowEndExamConfirm(true)

  const confirmEndAnswering = async () => {
    setShowEndExamConfirm(false)
    setIsTransitioning(true)
    try {
      const result = await advanceExamPhase(1, 'review')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to end answering:', error)
    } finally {
      setIsTransitioning(false)
    }
  }

  const finishExam = () => setShowLeaveExamConfirm(true)

  const confirmFinishExam = async () => {
    setShowLeaveExamConfirm(false)
    setIsTransitioning(true)
    try {
      const result = await advanceExamPhase(1, 'completed')
      setExamSession(result.session)
    } catch (error) {
      console.error('Failed to finish exam:', error)
    } finally {
      setIsTransitioning(false)
    }
  }

  const saveCurrentQuestionData = async () => {
    if (selectedTopic === null) return

    const currentData = questionData[selectedTopic + 1]
    if (!currentData) return

    let updatedSupplementaryNotesFiles = currentData.supplementaryNotesFiles || []

    if (currentData.supplementaryNotes.trim()) {
      try {
        const uploadedFile = await uploadSupplementaryNotes(
          currentData.supplementaryNotes,
          1,
          selectedTopic + 1
        )
        if (uploadedFile) {
          updatedSupplementaryNotesFiles = [uploadedFile]
          setQuestionData(prev => ({
            ...prev,
            [selectedTopic + 1]: {
              ...prev[selectedTopic + 1],
              supplementaryNotesFiles: updatedSupplementaryNotesFiles,
              supplementaryNotes: '',
            },
          }))
        }
      } catch (error) {
        console.error('Failed to save supplementary notes:', error)
      }
    }

    try {
      await updateExamAttachments(1, {
        selectedQuestionId: selectedTopic + 1,
        content_data: {
          attachments: {
            main: currentData?.attachments?.main || [],
            interaction: currentData?.attachments?.interaction || [],
            bonusAgent: {
              link: currentData?.linkValues?.bonusAgent || '',
              files: currentData?.attachments?.bonusAgent || [],
            },
            bonusMultimodal: currentData?.attachments?.bonusMultimodal || [],
          },
          supplementaryNotesFiles: updatedSupplementaryNotesFiles,
        },
      })
    } catch (error) {
      console.error('Failed to sync supplementary notes files:', error)
    }
  }

  const handleTopicSelect = async (topicIndex: number | null) => {
    await saveCurrentQuestionData()
    setSelectedTopic(topicIndex)

    if (topicIndex !== null) {
      try {
        await selectExamQuestion(1, topicIndex + 1)
        const data = await getExamData(1)
        if (data.userAnswer?.content_data) {
          const content = data.userAnswer.content_data
          const questionId = topicIndex + 1

          setQuestionData(prev => ({
            ...prev,
            [questionId]: {
              attachments: {
                main: content.attachments?.main || [],
                interaction: content.attachments?.interaction || [],
                bonusAgent: content.attachments?.bonusAgent?.files || [],
                bonusMultimodal: content.attachments?.bonusMultimodal || [],
              },
              supplementaryNotesFiles: content.supplementaryNotesFiles || [],
              supplementaryNotes: content.supplementaryNotes || '',
              linkValues: {
                bonusAgent: content.attachments?.bonusAgent?.link || '',
              },
            },
          }))
        }
      } catch (error) {
        console.error('Failed to select question:', error)
      }
    }
  }

  const confirmSubmit = async () => {
    setShowConfirmModal(false)
    if (selectedTopic === null) return

    const currentData = questionData[selectedTopic + 1]

    try {
      let supplementaryNotesFiles: ExamAttachment[] = currentData.supplementaryNotesFiles || []

      if (currentData.supplementaryNotes.trim()) {
        const uploadedFile = await uploadSupplementaryNotes(
          currentData.supplementaryNotes,
          1,
          selectedTopic + 1
        )
        if (uploadedFile) {
          supplementaryNotesFiles = [uploadedFile]
        }
      }

      const result = await submitExamAnswer(1, {
        selectedQuestionId: selectedTopic + 1,
        participantName,
        content_data: {
          participantName,
          selectedTopicId: selectedTopic + 1,
          supplementaryNotes: currentData.supplementaryNotes,
          supplementaryNotesFiles:
            supplementaryNotesFiles.length > 0
              ? supplementaryNotesFiles
              : currentData.supplementaryNotesFiles,
          attachments: {
            main: currentData.attachments.main,
            interaction: currentData.attachments.interaction,
            bonusAgent: {
              link: currentData.linkValues?.bonusAgent || '',
              files: currentData.attachments.bonusAgent,
            },
            bonusMultimodal: currentData.attachments.bonusMultimodal,
          },
        },
      })

      const newSubmitCount = result?.submit_count || 0
      setExamSession(prev => (prev ? { ...prev, submit_count: newSubmitCount } : null))

      if (supplementaryNotesFiles.length > 0) {
        setQuestionData(prev => ({
          ...prev,
          [selectedTopic + 1]: {
            ...prev[selectedTopic + 1],
            supplementaryNotesFiles,
            supplementaryNotes: currentData.supplementaryNotes,
          },
        }))
      }

      setShowSuccessModal(true)
    } catch {
      // Error handled by API
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
        title={EXAM_DATA.title}
        year={EXAM_DATA.year}
        progressSteps={progressSteps}
        timeLeft={timeLeft}
        timerColor={timerColor}
        showTimer={showTimer}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-10">
        <ExamInfoSection
          title={`微博高层管理人员 AI 应用能力考核`}
          year={EXAM_DATA.year}
          rules={EXAM_DATA.rules}
          examMethod={EXAM_DATA.examMethod}
          timeNote={EXAM_DATA.timeNote}
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
                  （考题三选一，如果多选，每个维度评分取多道题的高分）
                </span>
              )}
            </div>
            {examPhase === 'review' && selectedTopic !== null ? (
              <div className="mb-6">
                <AIAssessmentTopicCard
                  topic={EXAM_DATA.topics[selectedTopic]}
                  selected={true}
                  disabled={true}
                  onClick={() => {}}
                />
                <div className="mt-6">
                  <AIAssessmentTopicDetail topic={EXAM_DATA.topics[selectedTopic]} />
                </div>
              </div>
            ) : examPhase === 'review' ? (
              <div className="text-gray-500 py-4">未选择题目</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
                  {EXAM_DATA.topics.map((topic, i) => (
                    <AIAssessmentTopicCard
                      key={topic.id}
                      topic={topic}
                      selected={selectedTopic === i}
                      disabled={isCompleted && selectedTopic !== i}
                      onClick={() =>
                        !isCompleted && handleTopicSelect(selectedTopic === i ? null : i)
                      }
                    />
                  ))}
                </div>
                {selectedTopic !== null && (
                  <AIAssessmentTopicDetail topic={EXAM_DATA.topics[selectedTopic]} />
                )}
              </>
            )}
          </section>
        )}

        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <BonusItemsSection bonusItems={EXAM_DATA.bonusItems} />
        )}

        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <SupplementaryNotesSection
            notes={questionData[selectedTopic + 1]?.supplementaryNotes || ''}
            disabled={examPhase !== 'exam'}
            required={true}
            onNotesChange={notes =>
              setQuestionData(prev => ({
                ...prev,
                [selectedTopic + 1]: {
                  ...prev[selectedTopic + 1],
                  supplementaryNotes: notes,
                },
              }))
            }
          />
        )}

        {(examPhase === 'exam' || examPhase === 'review') && selectedTopic !== null && (
          <SlotBasedFileUpload
            topicId={1}
            questionId={selectedTopic + 1}
            slots={UPLOAD_SLOTS}
            attachments={questionData[selectedTopic + 1]?.attachments || {}}
            onChange={(slot: string, newAttachments: ExamAttachment[]) => {
              setQuestionData(prev => ({
                ...prev,
                [selectedTopic + 1]: {
                  ...prev[selectedTopic + 1],
                  attachments: {
                    ...prev[selectedTopic + 1].attachments,
                    [slot]: newAttachments,
                  },
                },
              }))
            }}
            onAttachmentsUpdate={async newAttachments => {
              try {
                await updateExamAttachments(1, {
                  selectedQuestionId: selectedTopic + 1,
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
            linkValues={questionData[selectedTopic + 1]?.linkValues || {}}
            onLinkChange={async (slot: string, value: string) => {
              setQuestionData(prev => ({
                ...prev,
                [selectedTopic + 1]: {
                  ...prev[selectedTopic + 1],
                  linkValues: {
                    ...prev[selectedTopic + 1].linkValues,
                    [slot]: value,
                  },
                },
              }))

              try {
                const currentData = questionData[selectedTopic + 1]
                await updateExamAttachments(1, {
                  selectedQuestionId: selectedTopic + 1,
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
            currentTotalCount={
              questionData[selectedTopic + 1]?.supplementaryNotesFiles?.length || 0
            }
            onLimitExceeded={() => {
              alert('每道题目总附件数（包括补充说明文件）不能超过 20 个，请先删除一些附件')
            }}
          />
        )}

        {(examPhase === 'exam' || examPhase === 'review') &&
          selectedTopic !== null &&
          !isCompleted && (
            <SubmitSection
              checkItems={[
                { label: '已填写说明', done: hasNotes, required: true },
                { label: '已上传报告', done: hasMainReport, required: true },
                { label: '已上传交互记录', done: hasInteractionRecord, required: true },
              ]}
              submitCount={submitCount}
              totalFileCount={getTotalFileCount(questionData, selectedTopic + 1)}
              isSubmitReady={isSubmitReady}
              submitButtonText={
                submitCount > 0 ? `再次提交 (第${submitCount + 1}次)` : '提交考核材料'
              }
              onSubmit={() => setShowConfirmModal(true)}
            />
          )}

        {examPhase === 'exam' && submitCount > 0 && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <div className="flex flex-col items-center gap-4">
                <p className="text-sm text-gray-500">完成答题后可以提前结束进入检查阶段</p>
                <button
                  onClick={endAnswering}
                  disabled={isTransitioning}
                  className={`px-10 py-3.5 bg-orange-500 hover:bg-orange-600 text-white text-lg font-bold rounded-2xl shadow-lg shadow-orange-200/50 transition-all hover:shadow-orange-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '结束答题'}
                </button>
              </div>
            </div>
          </section>
        )}

        {examPhase === 'review' && (
          <section className="animate-[slideDown_0.35s_ease-out]">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <div className="flex flex-col items-center gap-4">
                <p className="text-sm text-gray-500">确认无误后结束考试</p>
                <button
                  onClick={finishExam}
                  disabled={isTransitioning}
                  className={`px-10 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white text-lg font-bold rounded-2xl shadow-lg shadow-emerald-200/50 transition-all hover:shadow-emerald-300/60 active:scale-[0.98] ${isTransitioning ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isTransitioning ? '加载中...' : '离开考试'}
                </button>
              </div>
            </div>
          </section>
        )}

        {isCompleted && <CompletedState submitCount={submitCount} />}

        <div className="h-10" />
      </main>

      <ConfirmModal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={confirmSubmit}
        participantName={participantName}
        selectedTopicTitle={selectedTopic !== null ? EXAM_DATA.topics[selectedTopic].title : ''}
        mainFilesCount={
          questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.main.length || 0
        }
        interactionFilesCount={
          questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.interaction
            .length || 0
        }
        hasBonusAgent={
          (questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.bonusAgent
            .length || 0) > 0 ||
          (questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.linkValues?.bonusAgent ||
            '') !== ''
        }
        hasBonusMultimodal={
          (questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.attachments.bonusMultimodal
            .length || 0) > 0
        }
        supplementaryNotesLength={
          questionData[selectedTopic !== null ? selectedTopic + 1 : 1]?.supplementaryNotes.length ||
          0
        }
      />

      <SuccessModal isOpen={showSuccessModal} onClose={() => setShowSuccessModal(false)} />

      <EndExamConfirmModal
        isOpen={showEndExamConfirm}
        onClose={() => setShowEndExamConfirm(false)}
        onConfirm={confirmEndAnswering}
      />

      <LeaveExamConfirmModal
        isOpen={showLeaveExamConfirm}
        onClose={() => setShowLeaveExamConfirm(false)}
        onConfirm={confirmFinishExam}
      />

      <TimeWarningModal
        isOpen={showTimeWarning}
        onClose={() => setShowTimeWarning(false)}
        remainingMinutes={5}
      />
    </div>
  )
}
