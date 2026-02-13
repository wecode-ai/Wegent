// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { CheckCircle, XCircle, Send, Clock, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'

export interface DashboardStatsData {
  pending_tasks: number
  in_progress_tasks: number
  completed_tasks: number
  failed_tasks: number
  published_reports: number
}

interface DashboardStatsProps {
  stats: DashboardStatsData | null
  loading?: boolean
}

interface StatCardProps {
  title: string
  value: number
  icon: React.ReactNode
  onClick?: () => void
  colorClass?: string
}

function StatCard({ title, value, icon, onClick, colorClass = 'text-primary' }: StatCardProps) {
  return (
    <Card
      className={`transition-colors ${onClick ? 'cursor-pointer hover:border-primary' : ''}`}
      onClick={onClick}
    >
      <CardContent className="flex items-center gap-4 p-4">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg bg-surface ${colorClass}`}
        >
          {icon}
        </div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-text-muted">{title}</p>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Dashboard statistics component for grader role.
 * Shows overview of grading tasks by status.
 */
export function DashboardStats({ stats, loading }: DashboardStatsProps) {
  const router = useRouter()
  const { t } = useTranslation('evaluation')

  if (loading || !stats) {
    return (
      <div className="grid gap-4 md:grid-cols-5">
        {[...Array(5)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="flex items-center gap-4 p-4">
              <div className="h-10 w-10 rounded-lg bg-surface" />
              <div>
                <div className="mb-1 h-6 w-12 rounded bg-surface" />
                <div className="h-3 w-20 rounded bg-surface" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-5">
      <StatCard
        title={t('grading.status.pending', 'Pending')}
        value={stats.pending_tasks}
        icon={<Clock className="h-5 w-5" />}
        onClick={() => router.push('/evaluation/grader/tasks?status=pending')}
        colorClass="text-amber-500"
      />
      <StatCard
        title={t('grading.status.in_progress', 'In Progress')}
        value={stats.in_progress_tasks}
        icon={<Loader2 className="h-5 w-5" />}
        onClick={() => router.push('/evaluation/grader/tasks?status=in_progress')}
        colorClass="text-blue-500"
      />
      <StatCard
        title={t('grading.status.completed', 'Completed')}
        value={stats.completed_tasks}
        icon={<CheckCircle className="h-5 w-5" />}
        onClick={() => router.push('/evaluation/grader/tasks?status=completed')}
        colorClass="text-green-500"
      />
      <StatCard
        title={t('grading.status.failed', 'Failed')}
        value={stats.failed_tasks}
        icon={<XCircle className="h-5 w-5" />}
        onClick={() => router.push('/evaluation/grader/tasks?status=failed')}
        colorClass="text-red-500"
      />
      <StatCard
        title={t('grading.status.published', 'Published')}
        value={stats.published_reports}
        icon={<Send className="h-5 w-5" />}
        onClick={() => router.push('/evaluation/grader/reports')}
        colorClass="text-primary"
      />
    </div>
  )
}
