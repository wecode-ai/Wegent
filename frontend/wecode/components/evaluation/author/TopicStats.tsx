// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileCheck, Users, MessageSquare, BarChart3 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from '@/hooks/useTranslation'
import type { TopicStatistics } from '@wecode/types/evaluation'

/**
 * Props for the TopicStats component
 */
interface TopicStatsProps {
  /** Statistics data for the topic */
  statistics: TopicStatistics | null
  /** Whether the statistics are loading */
  isLoading?: boolean
}

/**
 * Individual stat card component
 */
interface StatCardProps {
  /** Icon component to display */
  icon: React.ReactNode
  /** Main value to display */
  value: string | number
  /** Label for the stat */
  label: string
  /** Optional subtitle (e.g., "published/total") */
  subtitle?: string
  /** Optional progress percentage (0-100) */
  progress?: number
  /** Color theme for the card */
  color: 'blue' | 'green' | 'purple' | 'amber'
}

/**
 * StatCard - Individual statistic card with icon and optional progress bar
 */
function StatCard({ icon, value, label, subtitle, progress, color }: StatCardProps) {
  const colorClasses = {
    blue: {
      bg: 'bg-blue-50',
      icon: 'text-blue-600',
      progress: 'bg-blue-600',
    },
    green: {
      bg: 'bg-emerald-50',
      icon: 'text-emerald-600',
      progress: 'bg-emerald-600',
    },
    purple: {
      bg: 'bg-purple-50',
      icon: 'text-purple-600',
      progress: 'bg-purple-600',
    },
    amber: {
      bg: 'bg-amber-50',
      icon: 'text-amber-600',
      progress: 'bg-amber-600',
    },
  }

  const c = colorClasses[color]

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 hover:shadow-md hover:-translate-y-[2px] transition-all duration-250">
      <div className="flex items-start justify-between">
        <div>
          <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center mb-3`}>
            {icon}
          </div>
          <div className="text-2xl font-bold text-gray-900">{value}</div>
          <div className="text-sm text-gray-500 mt-1">{label}</div>
          {subtitle && <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>}
        </div>
      </div>
      {progress !== undefined && progress >= 0 && (
        <div className="mt-4">
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full ${c.progress} rounded-full transition-all duration-500`}
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
          <div className="text-xs text-gray-400 mt-1.5">{Math.round(progress)}%</div>
        </div>
      )}
    </div>
  )
}

/**
 * Loading skeleton for stat cards
 */
function StatCardSkeleton() {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
      <Skeleton className="w-10 h-10 rounded-xl mb-3" />
      <Skeleton className="h-8 w-16 mb-2" />
      <Skeleton className="h-4 w-24" />
    </div>
  )
}

/**
 * TopicStats - Statistics overview component for the author topic detail page
 *
 * Displays 4 key metrics in a grid:
 * - Questions (published/total)
 * - Respondents
 * - Answers
 * - Grading Progress
 *
 * Design matches the ai-assessment-2026 card style with:
 * - White rounded-2xl cards
 * - Colored icon backgrounds
 * - Hover effects with shadow and translate
 * - Progress bar for grading completion
 */
export function TopicStats({ statistics, isLoading = false }: TopicStatsProps) {
  const { t } = useTranslation('evaluation')

  if (isLoading || !statistics) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
    )
  }

  // Calculate grading progress percentage
  const totalGrading =
    statistics.grading_pending + statistics.grading_completed + statistics.grading_published
  const gradingProgress = totalGrading > 0 ? (statistics.grading_completed / totalGrading) * 100 : 0

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Questions Card */}
      <StatCard
        icon={<FileCheck className="w-5 h-5 text-blue-600" />}
        value={statistics.published_questions}
        label={t('questions.title')}
        subtitle={`${statistics.published_questions} ${t('topics.published')} / ${statistics.total_questions} ${t('common:total')}`}
        color="blue"
      />

      {/* Respondents Card */}
      <StatCard
        icon={<Users className="w-5 h-5 text-emerald-600" />}
        value={statistics.total_respondents}
        label={t('respondents.title')}
        color="green"
      />

      {/* Answers Card */}
      <StatCard
        icon={<MessageSquare className="w-5 h-5 text-purple-600" />}
        value={statistics.total_answers}
        label={t('answers.title')}
        color="purple"
      />

      {/* Grading Progress Card */}
      <StatCard
        icon={<BarChart3 className="w-5 h-5 text-amber-600" />}
        value={statistics.grading_completed}
        label={t('grading.title')}
        subtitle={`${statistics.grading_published} ${t('grading.status.published')}`}
        progress={gradingProgress}
        color="amber"
      />
    </div>
  )
}
