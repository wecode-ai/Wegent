// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  User,
  Clock,
  FileText,
  Paperclip,
  Download,
  CheckCircle,
  Circle,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import {
  getExamSessionDetail,
  type ExamSessionDetail,
  type ExamSessionDetailQuestion,
} from '@wecode/api/evaluation-author'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'

interface Attachment {
  key: string
  filename: string
  size?: number
  content_type?: string
}

interface AttachmentGroup {
  main?: Attachment[]
  interaction?: Attachment[]
  bonusAgent?: {
    link?: string
    files?: Attachment[]
  }
  bonusMultimodal?: Attachment[]
}

interface AnswerContent {
  participantName?: string
  selectedTopicId?: number
  inputs?: {
    supplementaryNotes?: string
  }
  attachments?: AttachmentGroup & {
    supplementaryNotes?: Attachment[]
  }
}

const PHASE_OPTIONS = [
  { value: 'intro', label: '介绍中', color: 'blue' },
  { value: 'exam', label: '考试中', color: 'emerald' },
  { value: 'review', label: '检查中', color: 'orange' },
  { value: 'completed', label: '已完成', color: 'gray' },
]

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}小时${minutes}分钟${secs}秒`
  } else if (minutes > 0) {
    return `${minutes}分钟${secs}秒`
  } else {
    return `${secs}秒`
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function getPhaseBadge(phase: string) {
  const option = PHASE_OPTIONS.find(p => p.value === phase) || PHASE_OPTIONS[0]
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-700 border-blue-200',
    emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    orange: 'bg-orange-100 text-orange-700 border-orange-200',
    gray: 'bg-gray-100 text-gray-700 border-gray-200',
  }

  return <Badge className={`${colorClasses[option.color]} border`}>{option.label}</Badge>
}

function AttachmentItem({
  file,
  onDownload,
}: {
  file: Attachment
  onDownload: (file: Attachment) => void
}) {
  return (
    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center flex-shrink-0 border border-gray-100">
          <Paperclip className="w-5 h-5 text-gray-400" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{file.filename}</p>
          {file.size && <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => onDownload(file)} className="flex-shrink-0">
        <Download className="w-4 h-4" />
      </Button>
    </div>
  )
}

function QuestionAnswerCard({
  question,
  answerContent,
  onDownload,
}: {
  question: ExamSessionDetailQuestion
  answerContent?: AnswerContent
  onDownload: (file: Attachment) => void
}) {
  const hasAnswer = !!answerContent
  const attachments = answerContent?.attachments
  const hasMainFiles = attachments?.main && attachments.main.length > 0
  const hasInteractionFiles = attachments?.interaction && attachments.interaction.length > 0
  const hasBonusAgentFiles =
    attachments?.bonusAgent?.files && attachments.bonusAgent.files.length > 0
  const hasBonusMultimodalFiles =
    attachments?.bonusMultimodal && attachments.bonusMultimodal.length > 0
  const hasSupplementaryNotesFiles =
    attachments?.supplementaryNotes && attachments.supplementaryNotes.length > 0
  const hasSupplementaryNotesText = !!answerContent?.inputs?.supplementaryNotes?.trim()
  const hasLink = attachments?.bonusAgent?.link

  const checklistItems = [
    { label: '已填写说明', done: hasSupplementaryNotesText || hasSupplementaryNotesFiles },
    { label: '已上传交互记录', done: hasInteractionFiles },
    { label: '已上传报告', done: hasMainFiles },
  ]

  return (
    <Card className="overflow-hidden border-gray-200">
      <CardContent className="p-0">
        {/* Question Header */}
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#DF2029]/10 flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-[#DF2029]" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-gray-900">{question.title}</h3>
              <p className="text-sm text-gray-500 mt-1">题目 ID: {question.id}</p>
            </div>
            {hasAnswer ? (
              <Badge className="bg-green-100 text-green-700 border-green-200">
                <CheckCircle className="w-3 h-3 mr-1" />
                已作答
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-gray-400">
                <Circle className="w-3 h-3 mr-1" />
                未作答
              </Badge>
            )}
          </div>
        </div>

        {/* Answer Content */}
        {hasAnswer && (
          <div className="p-5 space-y-6">
            {/* Submission Checklist */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-3">提交检查</h4>
              <div className="grid grid-cols-3 gap-3">
                {checklistItems.map((item, index) => (
                  <div
                    key={index}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm ${
                      item.done ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'
                    }`}
                  >
                    {item.done ? (
                      <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                    ) : (
                      <Circle className="w-4 h-4 flex-shrink-0" />
                    )}
                    <span className="font-medium">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Supplementary Notes Text */}
            {hasSupplementaryNotesText && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  作答说明
                </h4>
                <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                  <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">
                    {answerContent?.inputs?.supplementaryNotes}
                  </pre>
                </div>
              </div>
            )}

            {/* Supplementary Notes Files */}
            {hasSupplementaryNotesFiles && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Paperclip className="w-4 h-4" />
                  作答说明附件
                </h4>
                <div className="space-y-2">
                  {attachments!.supplementaryNotes!.map((file, idx) => (
                    <AttachmentItem key={idx} file={file} onDownload={onDownload} />
                  ))}
                </div>
              </div>
            )}

            {/* Interaction Records */}
            {hasInteractionFiles && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Paperclip className="w-4 h-4" />
                  交互记录
                </h4>
                <div className="space-y-2">
                  {attachments!.interaction!.map((file, idx) => (
                    <AttachmentItem key={idx} file={file} onDownload={onDownload} />
                  ))}
                </div>
              </div>
            )}

            {/* Main Deliverables */}
            {hasMainFiles && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Paperclip className="w-4 h-4" />
                  主要交付物
                </h4>
                <div className="space-y-2">
                  {attachments!.main!.map((file, idx) => (
                    <AttachmentItem key={idx} file={file} onDownload={onDownload} />
                  ))}
                </div>
              </div>
            )}

            {/* Bonus Agent */}
            {(hasBonusAgentFiles || hasLink) && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Paperclip className="w-4 h-4" />
                  智能体部署
                </h4>
                {hasLink && (
                  <div className="p-3 bg-gray-50 rounded-xl border border-gray-100 mb-2">
                    <p className="text-xs text-gray-500 mb-1">部署链接</p>
                    <a
                      href={attachments!.bonusAgent!.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline break-all"
                    >
                      {attachments!.bonusAgent!.link}
                    </a>
                  </div>
                )}
                {hasBonusAgentFiles && (
                  <div className="space-y-2">
                    {attachments!.bonusAgent!.files!.map((file, idx) => (
                      <AttachmentItem key={idx} file={file} onDownload={onDownload} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Bonus Multimodal */}
            {hasBonusMultimodalFiles && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Paperclip className="w-4 h-4" />
                  多模态作品
                </h4>
                <div className="space-y-2">
                  {attachments!.bonusMultimodal!.map((file, idx) => (
                    <AttachmentItem key={idx} file={file} onDownload={onDownload} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!hasAnswer && (
          <div className="p-8 text-center">
            <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">该考生尚未提交此题目的答案</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function ExamSessionDetailPage() {
  const router = useRouter()
  const params = useParams()
  const topicId = Number(params.id)
  const userId = Number(params.userId)
  const { toast } = useToast()

  const [detail, setDetail] = useState<ExamSessionDetail | null>(null)
  const [loading, setLoading] = useState(true)

  const loadDetail = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getExamSessionDetail(topicId, userId)
      setDetail(data)
    } catch (_error) {
      toast({
        title: '加载失败',
        description: '无法加载考试会话详情',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [topicId, userId, toast])

  useEffect(() => {
    loadDetail()
  }, [loadDetail])

  const handleDownload = async (file: Attachment) => {
    try {
      await downloadEvaluationFile(file.key, file.filename)
    } catch (_error) {
      toast({
        title: '下载失败',
        description: '无法下载文件',
        variant: 'destructive',
      })
    }
  }

  // Parse answer content from session_all_answers or question.answer
  const getAnswerContent = (question: ExamSessionDetailQuestion): AnswerContent | undefined => {
    // First try to get from session_all_answers (exam mode)
    if (detail?.session_all_answers && question.id.toString() in detail.session_all_answers) {
      const sessionAnswer = detail.session_all_answers[question.id.toString()] as {
        content_data?: AnswerContent
      }
      if (sessionAnswer && sessionAnswer.content_data) {
        return sessionAnswer.content_data
      }
    }

    // Fall back to question.answer (regular mode)
    if (question.answer?.content_data) {
      return question.answer.content_data as AnswerContent
    }

    return undefined
  }

  return (
    <EvaluationPageLayout>
      <div className="max-w-5xl mx-auto">
        {/* Header with back button */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">考生答题详情</h1>
            <p className="text-sm text-gray-500">查看考生的答题内容和附件</p>
          </div>
        </div>

        {loading ? (
          // Loading skeleton
          <div className="space-y-4">
            <Card>
              <CardContent className="p-5">
                <Skeleton className="h-6 w-48 mb-2" />
                <Skeleton className="h-4 w-32" />
              </CardContent>
            </Card>
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <Skeleton className="h-5 w-full mb-4" />
                  <Skeleton className="h-20 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : detail ? (
          <>
            {/* Session Info Card */}
            <Card className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-100">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-sm">
                      <User className="w-6 h-6 text-blue-600" />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold text-gray-900">
                        {detail.session.user_name}
                      </h2>
                      {detail.session.user_email && (
                        <p className="text-sm text-gray-600">{detail.session.user_email}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {getPhaseBadge(detail.session.current_phase)}
                    {!detail.session.is_active && (
                      <Badge variant="secondary" className="text-gray-400">
                        已重置
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-blue-100 grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">开始时间</p>
                    <p className="text-sm font-medium text-gray-900">
                      {detail.session.started_at
                        ? new Date(detail.session.started_at).toLocaleString('zh-CN')
                        : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">考试用时</p>
                    <p className="text-sm font-medium text-gray-900 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {detail.session.exam_duration_seconds
                        ? formatDuration(detail.session.exam_duration_seconds)
                        : '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">已选题目</p>
                    <p className="text-sm font-medium text-gray-900">
                      {detail.session.selected_question_id
                        ? `题目 ${detail.session.selected_question_id}`
                        : '未选择'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">当前状态</p>
                    <p className="text-sm font-medium text-gray-900">
                      {detail.session.is_overtime ? (
                        <span className="text-orange-600">已超时</span>
                      ) : (
                        <span className="text-emerald-600">正常</span>
                      )}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Topic Info */}
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-2">{detail.topic.name}</h2>
              {detail.topic.description && (
                <p className="text-sm text-gray-600">{detail.topic.description}</p>
              )}
            </div>

            {/* Questions and Answers */}
            <div className="space-y-4">
              <h3 className="text-base font-medium text-gray-700 flex items-center gap-2">
                <FileText className="w-4 h-4" />
                答题内容
              </h3>
              {detail.questions.map(question => (
                <QuestionAnswerCard
                  key={question.id}
                  question={question}
                  answerContent={getAnswerContent(question)}
                  onDownload={handleDownload}
                />
              ))}
            </div>
          </>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">无法加载考试会话详情</p>
              <Button onClick={loadDetail} className="mt-4">
                重试
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </EvaluationPageLayout>
  )
}
