// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Plus,
  Users,
  Settings,
  History,
  GraduationCap,
  CheckCircle,
  FileCheck,
  ArrowRight,
  Loader2,
} from 'lucide-react'
import { publishAuthorTopic } from '@wecode/api/evaluation-author'
import type { Topic, TopicStatistics } from '@wecode/types/evaluation'

interface QuickActionsPanelProps {
  topic: Topic
  topicId: number
  statistics: TopicStatistics | null
  onTopicUpdate?: (topic: Topic) => void
  onSwitchTab?: (tab: 'permissions' | 'versions' | 'exam-sessions') => void
}

interface ActionCardProps {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
}

function ActionCard({
  icon,
  title,
  description,
  onClick,
  variant = 'default',
  disabled,
}: ActionCardProps) {
  const isPrimary = variant === 'primary'
  const isDanger = variant === 'danger'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        w-full px-4 py-3 text-left rounded-xl transition-all duration-200 flex items-center gap-3
        ${
          isPrimary
            ? 'bg-[#DF2029] hover:bg-[#c41c24] text-white shadow-sm'
            : isDanger
              ? 'bg-red-50 hover:bg-red-100 text-red-700 border border-red-200'
              : 'bg-gray-50 hover:bg-gray-100 text-gray-700'
        }
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
      `}
    >
      <span
        className={`
        w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
        ${isPrimary ? 'bg-white/20' : isDanger ? 'bg-red-100' : 'bg-white'}
      `}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold ${isPrimary ? 'text-white' : ''}`}>{title}</div>
        <div className={`text-xs truncate ${isPrimary ? 'text-white/80' : 'text-gray-500'}`}>
          {description}
        </div>
      </div>
      <ArrowRight
        className={`h-4 w-4 flex-shrink-0 ${isPrimary ? 'text-white/70' : 'text-gray-400'}`}
      />
    </button>
  )
}

export function QuickActionsPanel({
  topic,
  topicId,
  statistics,
  onTopicUpdate,
  onSwitchTab,
}: QuickActionsPanelProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const isPublished = topic.status === 1
  const hasQuestions = (topic.question_count || 0) > 0
  const examMode = topic.extra_data?.exam_mode as boolean | undefined

  const handlePublish = async () => {
    setPublishing(true)
    try {
      const updatedTopic = await publishAuthorTopic(topicId)
      toast({
        title: t('topics.publish_success'),
        description: t('topics.publish_success_description'),
      })
      // Update topic in parent
      if (onTopicUpdate) {
        onTopicUpdate({ ...topic, status: 1, current_version: updatedTopic.version })
      }
      setPublishDialogOpen(false)
    } catch (error) {
      toast({
        title: t('errors.publish_failed'),
        description: error instanceof Error ? error.message : t('errors.publish_failed'),
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }

  const actions = [
    {
      id: 'publish',
      icon: <CheckCircle className="h-5 w-5" />,
      title: isPublished ? t('topics.already_published') : t('topics.publish'),
      description: isPublished
        ? `Version ${topic.current_version} is live`
        : t('topics.publish_description'),
      onClick: () => setPublishDialogOpen(true),
      variant: 'primary' as const,
      disabled: isPublished || !hasQuestions,
    },
    {
      id: 'add-question',
      icon: <Plus className="h-5 w-5 text-[#DF2029]" />,
      title: t('questions.add'),
      description: t('questions.add_description'),
      onClick: () => router.push(`/evaluation/author/topics/${topicId}/questions/new`),
      variant: 'default' as const,
    },
    {
      id: 'permissions',
      icon: <Users className="h-5 w-5 text-blue-600" />,
      title: t('permissions.manage'),
      description: t('permissions.manage_description'),
      onClick: () =>
        onSwitchTab
          ? onSwitchTab('permissions')
          : router.push(`/evaluation/author/topics/${topicId}/permissions`),
      variant: 'default' as const,
    },
    {
      id: 'grading-tasks',
      icon: <FileCheck className="h-5 w-5 text-purple-600" />,
      title: t('grading.view_tasks'),
      description: t('grading.view_tasks_description'),
      onClick: () => router.push(`/evaluation/author/topics/${topicId}/grading-tasks`),
      variant: 'default' as const,
    },
    ...(examMode
      ? [
          {
            id: 'exam-sessions',
            icon: <GraduationCap className="h-5 w-5 text-green-600" />,
            title: t('exam_sessions.view'),
            description: t('exam_sessions.view_description'),
            onClick: () =>
              onSwitchTab
                ? onSwitchTab('exam-sessions')
                : router.push(`/evaluation/author/topics/${topicId}/exam-sessions`),
            variant: 'default' as const,
          },
        ]
      : []),
    {
      id: 'versions',
      icon: <History className="h-5 w-5 text-amber-600" />,
      title: t('topics.view_versions'),
      description: t('topics.view_versions_description'),
      onClick: () =>
        onSwitchTab
          ? onSwitchTab('versions')
          : router.push(`/evaluation/author/topics/${topicId}/versions`),
      variant: 'default' as const,
    },
  ]

  return (
    <>
      {/* Quick Actions Card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-4">
          {t('actions.quick_actions')}
        </h3>
        <div className="space-y-3">
          {actions.map(action => (
            <ActionCard
              key={action.id}
              icon={action.icon}
              title={action.title}
              description={action.description}
              onClick={action.onClick}
              variant={action.variant}
              disabled={action.disabled}
            />
          ))}
        </div>

        {/* Stats Summary */}
        <div className="mt-6 pt-6 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {t('topics.stats_summary')}
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-lg font-bold text-gray-900">{topic.question_count || 0}</div>
              <div className="text-xs text-gray-500">{t('questions.title')}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-lg font-bold text-gray-900">
                {statistics?.total_respondents || 0}
              </div>
              <div className="text-xs text-gray-500">{t('respondents.title')}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-lg font-bold text-gray-900">
                {statistics?.total_answers || 0}
              </div>
              <div className="text-xs text-gray-500">{t('answers.title')}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-lg font-bold text-gray-900">
                {statistics?.grading_completed || 0}
              </div>
              <div className="text-xs text-gray-500">{t('grading.completed')}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Publish Confirmation Dialog */}
      <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('topics.publish_confirm_title')}</DialogTitle>
            <DialogDescription>
              {t('topics.publish_confirm_description', { name: topic.name })}
            </DialogDescription>
          </DialogHeader>

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 my-4">
            <div className="flex items-start gap-3">
              <Settings className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-medium mb-1">{t('topics.publish_note_title')}</p>
                <p className="text-amber-700/80">{t('topics.publish_note_description')}</p>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setPublishDialogOpen(false)}
              disabled={publishing}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handlePublish}
              disabled={publishing}
              className="bg-[#DF2029] hover:bg-[#c41c24]"
            >
              {publishing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('actions.publishing')}
                </>
              ) : (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {t('actions.publish')}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
