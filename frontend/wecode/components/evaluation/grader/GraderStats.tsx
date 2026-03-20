// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Clock, Loader2, CheckCircle, XCircle, Send } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { GradingTaskStatus } from '@wecode/types/evaluation'

interface GradingStats {
  pending_count?: number
  running_count?: number
  completed_count?: number
  failed_count?: number
  published_count?: number
}

interface GraderStatsProps {
  stats: GradingStats | null
  activeFilter?: string
  onFilterChange?: (filter: string) => void
}

interface StatCardProps {
  icon: React.ReactNode
  label: string
  value: number
  colorClass: string
  bgClass: string
  isActive?: boolean
  onClick?: () => void
}

function StatCard({ icon, label, value, colorClass, bgClass, isActive, onClick }: StatCardProps) {
  return (
    <div
      onClick={onClick}
      className={`
        bg-white rounded-2xl border border-gray-100 p-4
        transition-all duration-200 ease-out
        hover:shadow-md hover:-translate-y-[2px]
        ${onClick ? 'cursor-pointer' : ''}
        ${isActive ? 'ring-2 ring-primary shadow-md' : 'shadow-sm'}
      `}
    >
      <div className="flex items-center gap-3">
        <div className={`h-10 w-10 rounded-xl ${bgClass} flex items-center justify-center`}>
          <span className={colorClass}>{icon}</span>
        </div>
        <div>
          <div className="text-xs text-gray-500 font-medium">{label}</div>
          <div className="text-xl font-bold text-gray-900">{value}</div>
        </div>
      </div>
    </div>
  )
}

/**
 * GraderStats Component
 *
 * Displays grading task statistics with interactive filtering.
 * Features:
 * - 5 status cards with colored icons
 * - Click-to-filter functionality
 * - Active state highlighting
 * - Hover animations
 *
 * Design inspired by TopicStats from author pages
 */
export function GraderStats({ stats, activeFilter = 'all', onFilterChange }: GraderStatsProps) {
  const { t } = useTranslation('evaluation')

  const statItems = [
    {
      key: GradingTaskStatus.PENDING.toString(),
      icon: <Clock className="h-5 w-5" />,
      label: t('grading.status.pending'),
      value: stats?.pending_count ?? 0,
      colorClass: 'text-amber-600',
      bgClass: 'bg-amber-50',
    },
    {
      key: GradingTaskStatus.RUNNING.toString(),
      icon: <Loader2 className="h-5 w-5" />,
      label: t('grading.status.running'),
      value: stats?.running_count ?? 0,
      colorClass: 'text-blue-600',
      bgClass: 'bg-blue-50',
    },
    {
      key: GradingTaskStatus.COMPLETED.toString(),
      icon: <CheckCircle className="h-5 w-5" />,
      label: t('grading.status.completed'),
      value: stats?.completed_count ?? 0,
      colorClass: 'text-emerald-600',
      bgClass: 'bg-emerald-50',
    },
    {
      key: GradingTaskStatus.FAILED.toString(),
      icon: <XCircle className="h-5 w-5" />,
      label: t('grading.status.failed'),
      value: stats?.failed_count ?? 0,
      colorClass: 'text-red-600',
      bgClass: 'bg-red-50',
    },
    {
      key: GradingTaskStatus.PUBLISHED.toString(),
      icon: <Send className="h-5 w-5" />,
      label: t('grading.status.published'),
      value: stats?.published_count ?? 0,
      colorClass: 'text-teal-600',
      bgClass: 'bg-teal-50',
    },
  ]

  const handleClick = (key: string) => {
    if (onFilterChange) {
      // Toggle filter: if already active, clear it
      onFilterChange(activeFilter === key ? 'all' : key)
    }
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {statItems.map(item => (
        <StatCard
          key={item.key}
          icon={item.icon}
          label={item.label}
          value={item.value}
          colorClass={item.colorClass}
          bgClass={item.bgClass}
          isActive={activeFilter === item.key}
          onClick={() => handleClick(item.key)}
        />
      ))}
    </div>
  )
}
