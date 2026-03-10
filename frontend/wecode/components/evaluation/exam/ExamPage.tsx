// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import { useUser } from '@/features/common/UserContext'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getExamData, submitExamAnswer, updateExamAttachments } from '@wecode/api/evaluation-exam'
import { useExamTimer } from './hooks/useExamTimer'
import { useExamState } from './hooks/useExamState'
import { TopicCard } from './TopicCard'
import { TopicDetail } from './TopicDetail'
import { FileUploadSection } from './FileUploadSection'
import { ConfirmModal } from './ConfirmModal'
import { SuccessModal } from './SuccessModal'
import type { ExamDataResponse } from '@wecode/api/evaluation-exam'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

/**
 * Main exam page component for the evaluation module.
 *
 * This component implements the exam answering interface where participants:
 * - View exam rules and instructions
 * - Start the exam timer
 * - Select one of three available topics
 * - View detailed topic requirements
 *
 * Features:
 * - Exam data loading with error handling
 * - Sticky header with exam title and timer
 * - Visual topic selection cards (3 columns)
 * - Detailed topic view with requirements
 * - Phase-based UI (ready/active/qa/submitted)
 *
 * @example
 * ```tsx
 * // Used in Next.js route:
 * import { ExamPage } from '@wecode/components/evaluation/exam/ExamPage'
 * export default function ExamPageRoute() {
 *   return <ExamPage />
 * }
 * ```
 */
export function ExamPage() {
  const router = useRouter()
  const params = useParams()
  const { user, isLoading: isUserLoading } = useUser()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = Number(params.id)

  const [examData, setExamData] = useState<ExamDataResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const {
    phase,
    formattedTime,
    isCompleted,
    isOvertime,
    showTimer,
    selectedQuestionId: _sessionSelectedQuestionId,
  } = useExamTimer({
    session: examData?.session ?? null,
  })

  const {
    state,
    setParticipantName,
    setSelectedQuestionId,
    setSupplementaryNotes,
    addMainFiles,
    removeMainFile,
    addInteractionFiles,
    removeInteractionFile,
    setBonusAgentLink,
    addBonusAgentFiles,
    removeBonusAgentFile,
    addBonusMultimodalFiles,
    removeBonusMultimodalFile,
    isSubmitReady,
  } = useExamState()

  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showSuccessModal, setShowSuccessModal] = useState(false)

  // Check login status after user data is loaded
  useEffect(() => {
    // Wait for user data to finish loading before checking
    if (isUserLoading) return

    if (!user) {
      toast({
        title: t('errors.login_required'),
        description: t('errors.please_login'),
        variant: 'destructive',
      })
      router.push('/login')
    }
  }, [user, isUserLoading, router, toast, t])

  useEffect(() => {
    async function loadExam() {
      try {
        const data = await getExamData(topicId)
        setExamData(data)
      } catch (err: unknown) {
        console.error('Failed to load exam data:', err)
        // Handle permission denied (403)
        const error = err as { status?: number; message?: string }
        if (error?.status === 403 || error?.message?.includes('permission')) {
          toast({
            title: t('errors.load_failed'),
            description: t('errors.permission_denied'),
            variant: 'destructive',
          })
          router.push('/evaluation/respondent')
        } else {
          setError('Failed to load exam data')
        }
      } finally {
        setLoading(false)
      }
    }
    if (user && !isUserLoading) {
      loadExam()
    }
  }, [topicId, user, isUserLoading, router, toast, t])

  // Show loading state while checking auth
  if (isUserLoading || !user) {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-text-secondary">{t('loading')}</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-red-500">Error: {error}</div>
      </div>
    )
  }

  if (!examData) {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-gray-500">No exam data available</div>
      </div>
    )
  }

  const { topic, questions } = examData

  // Validate exam configuration
  const examExtraData = topic.extra_data
  if (!examExtraData?.duration) {
    return (
      <div className="min-h-screen bg-[#fafbfc] flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 mb-2">考试配置不完整</div>
          <div className="text-gray-400 text-sm">请先配置考试信息（时长）</div>
        </div>
      </div>
    )
  }

  // Compute progress steps
  const progressSteps = [
    { label: '选择题目', done: state.selectedQuestionId !== null },
    { label: '填写说明', done: state.supplementaryNotes.trim().length > 0 },
    { label: '上传材料', done: state.mainFiles.length > 0 },
    { label: '确认提交', done: isCompleted },
  ]

  /**
   * Calculate total file count for current question
   */
  const getTotalFileCount = () => {
    return (
      state.mainFiles.length +
      state.interactionFiles.length +
      state.bonusAgentFiles.length +
      state.bonusMultimodalFiles.length
    )
  }

  /**
   * Handle real-time attachments update to backend
   */
  const handleAttachmentsUpdate = async (attachments: {
    main: ExamAttachment[]
    interaction: ExamAttachment[]
    bonusAgent: ExamAttachment[]
    bonusMultimodal: ExamAttachment[]
  }) => {
    if (!state.selectedQuestionId) return

    try {
      await updateExamAttachments(topicId, {
        selectedQuestionId: state.selectedQuestionId,
        content_data: {
          attachments: {
            main: attachments.main,
            interaction: attachments.interaction,
            bonusAgent: {
              link: state.bonusAgentLink,
              files: attachments.bonusAgent,
            },
            bonusMultimodal: attachments.bonusMultimodal,
          },
        },
      })
    } catch (error) {
      console.error('Failed to update attachments:', error)
    }
  }

  /**
   * Handle bonus agent link change with real-time save
   */
  const handleBonusAgentLinkChange = async (link: string) => {
    setBonusAgentLink(link)

    if (!state.selectedQuestionId) return

    try {
      await updateExamAttachments(topicId, {
        selectedQuestionId: state.selectedQuestionId,
        content_data: {
          attachments: {
            main: state.mainFiles,
            interaction: state.interactionFiles,
            bonusAgent: {
              link,
              files: state.bonusAgentFiles,
            },
            bonusMultimodal: state.bonusMultimodalFiles,
          },
        },
      })
    } catch (error) {
      console.error('Failed to update link:', error)
    }
  }

  const handleSubmit = async () => {
    if (!isSubmitReady || !state.selectedQuestionId) return

    try {
      await submitExamAnswer(topicId, {
        selectedQuestionId: state.selectedQuestionId,
        participantName: state.participantName,
        content_data: {
          participantName: state.participantName,
          selectedTopicId: state.selectedQuestionId,
          inputs: {
            supplementaryNotes: state.supplementaryNotes,
          },
          attachments: {
            main: state.mainFiles,
            interaction: state.interactionFiles,
            bonusAgent: {
              link: state.bonusAgentLink,
              files: state.bonusAgentFiles,
            },
            bonusMultimodal: state.bonusMultimodalFiles,
          },
        },
      })

      setShowSuccessModal(true)
    } catch (_error) {
      // Error handled by API
    }
  }

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#DF2029] to-red-600 flex items-center justify-center flex-shrink-0 shadow-sm shadow-red-200">
              <span className="text-white text-xs font-extrabold">W</span>
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-gray-900 truncate">{topic.name}</h1>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {phase !== 'ready' && (
              <div className="hidden sm:flex items-center gap-2">
                {progressSteps.map((step, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <div
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${step.done ? 'bg-[#DF2029]/10 text-[#DF2029]' : 'bg-gray-100 text-gray-400'}`}
                    >
                      {step.done && (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      <span>{step.label}</span>
                    </div>
                    {index < progressSteps.length - 1 && (
                      <div
                        className={`w-4 h-px ${step.done ? 'bg-[#DF2029]/30' : 'bg-gray-200'}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {showTimer && (
              <div
                className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-base font-mono font-bold ${
                  isOvertime
                    ? 'text-red-600 bg-red-50 border-red-200'
                    : 'text-emerald-600 bg-emerald-50 border-emerald-200'
                }`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>{formattedTime}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-10">
        {/* Exam Info Section */}
        <section className="bg-white rounded-3xl shadow-sm border border-gray-100 p-8 sm:p-10">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900 mb-8">{topic.name}</h2>

          {/* Instructions */}
          {topic.extra_data?.instructions && (
            <div className="prose prose-gray max-w-none mb-8">
              <div className="bg-gray-50 rounded-2xl p-6 border border-gray-100">
                <ReactMarkdown>{topic.extra_data.instructions}</ReactMarkdown>
              </div>
            </div>
          )}

          {/* Exam Status Indicator */}
          {phase === 'ready' && (
            <div className="mt-8 flex justify-center">
              <div className="px-6 py-3 bg-gray-100 text-gray-500 rounded-xl text-sm">
                考试即将开始，请等待...
              </div>
            </div>
          )}
        </section>

        {/* Participant Info */}
        {phase !== 'ready' && (
          <section className="fade-in bg-white rounded-3xl shadow-sm border border-gray-100 p-8">
            <div className="flex items-center gap-2.5 mb-5">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-400"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <h2 className="text-xl font-bold text-gray-900">考生信息</h2>
            </div>
            <div className="max-w-md">
              <label className="block text-base font-medium text-gray-700 mb-2">
                姓名 <span className="text-[#DF2029]">*</span>
              </label>
              <input
                type="text"
                value={state.participantName}
                onChange={e => setParticipantName(e.target.value)}
                placeholder="请输入您的姓名"
                disabled={isCompleted}
                className="w-full px-5 py-3 rounded-xl border border-gray-200 text-base focus:border-red-400 focus:ring-2 focus:ring-red-100 transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-50"
              />
            </div>
          </section>
        )}

        {/* Topic Selection */}
        {phase !== 'ready' && (
          <section className="fade-in">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1.5 h-7 bg-[#DF2029] rounded-full" />
              <h2 className="text-xl font-bold text-gray-900">选择考核题目</h2>
              <span className="text-base text-gray-400 ml-1">（三选一）</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
              {questions.map((question, index) => (
                <TopicCard
                  key={question.id}
                  questionId={index + 1}
                  title={question.title}
                  content={question.content_data}
                  selected={state.selectedQuestionId === question.id}
                  onClick={() => setSelectedQuestionId(question.id)}
                />
              ))}
            </div>
            {state.selectedQuestionId && (
              <TopicDetail
                title={questions.find(q => q.id === state.selectedQuestionId)?.title || ''}
                content={questions.find(q => q.id === state.selectedQuestionId)?.content_data}
              />
            )}
          </section>
        )}

        {/* File Uploads */}
        {phase !== 'ready' && state.selectedQuestionId && (
          <FileUploadSection
            topicId={topicId}
            questionId={state.selectedQuestionId}
            mainFiles={state.mainFiles}
            interactionFiles={state.interactionFiles}
            bonusAgentLink={state.bonusAgentLink}
            bonusAgentFiles={state.bonusAgentFiles}
            bonusMultimodalFiles={state.bonusMultimodalFiles}
            onMainFilesChange={files => {
              // Calculate diff and update
              const currentFiles = state.mainFiles
              if (files.length > currentFiles.length) {
                addMainFiles(files.slice(currentFiles.length))
              } else if (files.length < currentFiles.length) {
                // Find removed file and remove it
                for (let i = currentFiles.length - 1; i >= 0; i--) {
                  if (!files.find(f => f.key === currentFiles[i].key)) {
                    removeMainFile(i)
                    break
                  }
                }
              }
            }}
            onInteractionFilesChange={files => {
              const currentFiles = state.interactionFiles
              if (files.length > currentFiles.length) {
                addInteractionFiles(files.slice(currentFiles.length))
              } else if (files.length < currentFiles.length) {
                for (let i = currentFiles.length - 1; i >= 0; i--) {
                  if (!files.find(f => f.key === currentFiles[i].key)) {
                    removeInteractionFile(i)
                    break
                  }
                }
              }
            }}
            onBonusAgentLinkChange={handleBonusAgentLinkChange}
            onBonusAgentFilesChange={files => {
              const currentFiles = state.bonusAgentFiles
              if (files.length > currentFiles.length) {
                addBonusAgentFiles(files.slice(currentFiles.length))
              } else if (files.length < currentFiles.length) {
                for (let i = currentFiles.length - 1; i >= 0; i--) {
                  if (!files.find(f => f.key === currentFiles[i].key)) {
                    removeBonusAgentFile(i)
                    break
                  }
                }
              }
            }}
            onBonusMultimodalFilesChange={files => {
              const currentFiles = state.bonusMultimodalFiles
              if (files.length > currentFiles.length) {
                addBonusMultimodalFiles(files.slice(currentFiles.length))
              } else if (files.length < currentFiles.length) {
                for (let i = currentFiles.length - 1; i >= 0; i--) {
                  if (!files.find(f => f.key === currentFiles[i].key)) {
                    removeBonusMultimodalFile(i)
                    break
                  }
                }
              }
            }}
            onAttachmentsUpdate={handleAttachmentsUpdate}
            disabled={isCompleted}
          />
        )}

        {/* Supplementary Notes */}
        {phase !== 'ready' && state.selectedQuestionId && (
          <section className="slide-down">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1.5 h-7 bg-sky-500 rounded-full" />
              <h2 className="text-xl font-bold text-gray-900">作答补充说明</h2>
            </div>
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <div className="bg-sky-50 border border-sky-100 rounded-2xl p-5 mb-5">
                <p className="text-base text-sky-800 leading-[1.8]">
                  请补充说明你本次借助 AI 完成作答的整体思路，以及使用的模型与工具，例如：
                </p>
                <p className="text-base text-sky-700 leading-[1.8] mt-2">
                  使用过哪些模型或平台、是否在不同阶段切换过不同模型或工具、各自用于哪些环节，是否有其他引用来源或辅助工具。
                </p>
                <p className="text-base text-sky-700 leading-[1.8] mt-2">
                  也可以补充其他你认为可以体现自己AI使用思路、技巧的信息。
                </p>
              </div>
              <textarea
                value={state.supplementaryNotes}
                onChange={e => setSupplementaryNotes(e.target.value)}
                placeholder="请在此输入你的作答补充说明..."
                disabled={isCompleted}
                className="w-full min-h-[200px] px-5 py-4 rounded-2xl border border-gray-200 text-base leading-[1.8] resize-y focus:border-red-400 focus:ring-2 focus:ring-red-100 transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-50"
              />
              <div className="flex justify-end mt-2">
                <span className="text-sm text-gray-400">{state.supplementaryNotes.length} 字</span>
              </div>
            </div>
          </section>
        )}

        {/* Submit Section */}
        {phase !== 'ready' && state.selectedQuestionId && !isCompleted && (
          <section className="slide-down">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
              <h3 className="text-base font-bold text-gray-700 mb-5">提交检查</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-7">
                {[
                  { label: '已选择题目', done: state.selectedQuestionId !== null, required: true },
                  {
                    label: '已填写姓名',
                    done: state.participantName.trim().length > 0,
                    required: true,
                  },
                  { label: '已上传报告', done: state.mainFiles.length > 0, required: true },
                  {
                    label: '已填写说明',
                    done: state.supplementaryNotes.trim().length > 0,
                    required: false,
                  },
                ].map((item, index) => (
                  <div
                    key={index}
                    className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium ${item.done ? 'bg-green-50 text-green-700' : item.required ? 'bg-red-50 text-red-400' : 'bg-gray-50 text-gray-400'}`}
                  >
                    {item.done ? (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-green-500 flex-shrink-0"
                      >
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                        <polyline points="22 4 12 14.01 9 11.01" />
                      </svg>
                    ) : (
                      <div
                        className={`w-4.5 h-4.5 rounded-full border-2 flex-shrink-0 ${item.required ? 'border-red-300' : 'border-gray-300'}`}
                      />
                    )}
                    <span>
                      {item.label}
                      {item.required && !item.done ? ' *' : ''}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col sm:flex-row items-center gap-4 sm:justify-between">
                <div className="text-sm text-gray-400">
                  <p>每道题目总附件数不能超过 20 个，当前已上传 {getTotalFileCount()} 个</p>
                </div>
                <button
                  onClick={() => setShowConfirmModal(true)}
                  disabled={!isSubmitReady}
                  className={`w-full sm:w-auto px-10 py-3.5 rounded-2xl text-base font-bold transition-all ${isSubmitReady ? 'bg-[#DF2029] hover:bg-[#c81d25] text-white shadow-lg shadow-red-200/50 hover:shadow-red-300/60 active:scale-[0.98]' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                >
                  提交考核材料
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Completed State */}
        {isCompleted && (
          <section className="slide-down">
            <div className="bg-gray-50 rounded-3xl border border-gray-200 p-7 sm:p-9 text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-200 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-gray-400"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-gray-700 mb-2">考试已结束</h3>
              <p className="text-sm text-gray-500">您的考试已结束</p>
            </div>
          </section>
        )}
      </main>

      {/* Modals */}
      <ConfirmModal
        isOpen={showConfirmModal}
        onClose={() => setShowConfirmModal(false)}
        onConfirm={handleSubmit}
        participantName={state.participantName}
        selectedTopicTitle={questions.find(q => q.id === state.selectedQuestionId)?.title || ''}
        mainFilesCount={state.mainFiles.length}
        interactionFilesCount={state.interactionFiles.length}
        hasBonusAgent={state.bonusAgentFiles.length > 0 || state.bonusAgentLink !== ''}
        hasBonusMultimodal={state.bonusMultimodalFiles.length > 0}
        supplementaryNotesLength={state.supplementaryNotes.length}
        supplementaryNotesFilesCount={0}
      />

      <SuccessModal isOpen={showSuccessModal} onClose={() => setShowSuccessModal(false)} />
    </div>
  )
}
