// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MoreVertical, Eye, RotateCcw, Power, GraduationCap, Clock, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ExamTimerDisplay } from '@wecode/components/evaluation/common/ExamTimerDisplay'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  getTopicExamSessions,
  resetUserExamSession,
  updateUserExamSessionPhase,
  forceEndExamSession,
  type ExamSession,
} from '@wecode/api/evaluation-author'

/**
 * Props for the ExamSessionsTab component
 */
interface ExamSessionsTabProps {
  /** Topic ID */
  topicId: number
}

/**
 * Phase configuration with colors (labels come from i18n)
 */
const PHASE_OPTIONS = [
  { value: 'intro', color: 'blue' },
  { value: 'exam', color: 'amber' },
  { value: 'review', color: 'purple' },
  { value: 'completed', color: 'green' },
] as const

type PhaseType = (typeof PHASE_OPTIONS)[number]['value']

/**
 * Format duration in seconds to human readable string
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`
  } else {
    return `${secs}s`
  }
}

/**
 * Get phase badge with appropriate color
 */
function getPhaseBadge(phase: PhaseType, t: (key: string) => string) {
  const option = PHASE_OPTIONS.find(p => p.value === phase) || PHASE_OPTIONS[0]
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-700 border-blue-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    purple: 'bg-purple-100 text-purple-700 border-purple-200',
    green: 'bg-green-100 text-green-700 border-green-200',
  }

  return (
    <Badge variant="info" className={`${colorClasses[option.color]} font-medium`}>
      {t(`exam_sessions.phase.${option.value}`)}
    </Badge>
  )
}

/**
 * Empty state component when no sessions exist
 */
function EmptyState({ t }: { t: (key: string) => string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 border-dashed p-12 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-4">
        <GraduationCap className="w-8 h-8 text-gray-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{t('exam_sessions.no_sessions')}</h3>
      <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
        {t('exam_sessions.no_sessions_description')}
      </p>
    </div>
  )
}

/**
 * Loading skeleton for sessions list
 */
function SessionsListSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-4">
            <Skeleton className="w-10 h-10 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-6 w-24" />
              </div>
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * SessionCard - Individual exam session card component
 */
interface SessionCardProps {
  /** The session data to display */
  session: ExamSession
  /** Topic ID for navigation */
  topicId: number
  /** Callback when reset is clicked */
  onReset: (session: ExamSession) => void
  /** Callback when phase change is clicked */
  onPhaseChange: (session: ExamSession, phase: PhaseType) => void
  /** Callback when force end is clicked */
  onForceEnd: (session: ExamSession) => void
  /** Translation function */
  t: (key: string) => string
}

function SessionCard({
  session,
  topicId,
  onReset,
  onPhaseChange,
  onForceEnd,
  t,
}: SessionCardProps) {
  const router = useRouter()

  const handleViewDetail = () => {
    router.push(`/evaluation/author/topics/${topicId}/exam-sessions/${session.user_id}`)
  }

  return (
    <div
      className="
        bg-white rounded-2xl border border-gray-100 shadow-sm
        hover:shadow-md hover:-translate-y-[2px]
        transition-all duration-250
        p-5
      "
    >
      <div className="flex items-center gap-4">
        {/* User Avatar */}
        <div className="shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-semibold text-sm">
          {(session.user_name?.[0] || 'U').toUpperCase()}
        </div>

        {/* User Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h3 className="text-base font-semibold text-gray-900">
                {session.user_name || `User #${session.user_id}`}
              </h3>
              {session.user_email && (
                <span className="text-sm text-gray-500 hidden sm:inline">{session.user_email}</span>
              )}
            </div>

            {/* Phase Badge and Timer */}
            <div className="flex items-center gap-2">
              {session.current_phase === 'exam' && (
                <ExamTimerDisplay
                  initialRemainingSeconds={session.remaining_seconds}
                  phase={session.current_phase}
                  size="sm"
                />
              )}
              {getPhaseBadge(session.current_phase, t)}
            </div>
          </div>

          {/* Meta info */}
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {t('exam_sessions.started_at')}:{' '}
              {session.started_at ? new Date(session.started_at).toLocaleString() : '-'}
            </span>
            {session.exam_duration_seconds !== null && session.exam_duration_seconds > 0 && (
              <span>
                {t('exam_sessions.duration')}: {formatDuration(session.exam_duration_seconds)}
              </span>
            )}
            {session.selected_question_id && (
              <span className="text-blue-600">
                {t('exam_sessions.question')} #{session.selected_question_id}
              </span>
            )}
          </div>
        </div>

        {/* Actions Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-gray-400 hover:text-gray-600 shrink-0"
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={handleViewDetail}>
              <Eye className="w-4 h-4 mr-2" />
              {t('exam_sessions.view_detail')}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <div className="px-2 py-1.5 text-xs font-semibold text-gray-500">
              {t('exam_sessions.change_phase')}
            </div>
            {PHASE_OPTIONS.map(option => (
              <DropdownMenuItem
                key={option.value}
                disabled={session.current_phase === option.value}
                onClick={() => onPhaseChange(session, option.value)}
              >
                {t('exam_sessions.set_to')} {t(`exam_sessions.phase.${option.value}`)}
                {session.current_phase === option.value && (
                  <span className="ml-auto text-xs text-gray-400">
                    ({t('exam_sessions.current')})
                  </span>
                )}
              </DropdownMenuItem>
            ))}

            <DropdownMenuSeparator />

            {session.current_phase !== 'completed' && (
              <DropdownMenuItem
                onClick={() => onForceEnd(session)}
                className="text-orange-600 focus:text-orange-600"
              >
                <Power className="w-4 h-4 mr-2" />
                {t('exam_sessions.force_end')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onReset(session)}
              className="text-red-600 focus:text-red-600"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              {t('exam_sessions.reset_session')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * ExamSessionsTab - Tab content for managing exam sessions
 *
 * Features:
 * - Stats cards showing session counts by phase
 * - Filter tabs: All, Intro, Exam, Review, Completed
 * - Session cards with user info, phase badges, and timers
 * - Action dropdown: View details, Change phase, Force end, Reset session
 * - Empty state when no sessions
 * - Loading skeleton state
 * - Pagination support
 *
 * Design:
 * - Clean white cards with consistent spacing
 * - Color-coded phase badges
 * - Smooth transitions and hover effects
 */
export function ExamSessionsTab({ topicId }: ExamSessionsTabProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [sessions, setSessions] = useState<ExamSession[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<PhaseType | 'all'>('all')
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)

  // Dialog states
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [forceEndDialogOpen, setForceEndDialogOpen] = useState(false)
  const [phaseDialogOpen, setPhaseDialogOpen] = useState(false)
  const [selectedSession, setSelectedSession] = useState<ExamSession | null>(null)
  const [targetPhase, setTargetPhase] = useState<PhaseType>('intro')

  const SESSIONS_PER_PAGE = 20

  // Load sessions data
  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getTopicExamSessions(topicId, {
        page,
        limit: SESSIONS_PER_PAGE,
        phase: activeTab === 'all' ? undefined : activeTab,
      })
      setSessions(response.sessions || [])
      setTotal(response.total || 0)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('exam_sessions.load_failed'),
        variant: 'destructive',
      })
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [topicId, page, activeTab, toast, t])

  useEffect(() => {
    if (topicId) {
      loadSessions()
    }
  }, [topicId, loadSessions])

  // Handle reset session
  const handleResetClick = (session: ExamSession) => {
    setSelectedSession(session)
    setResetDialogOpen(true)
  }

  const handleResetConfirm = async () => {
    if (!selectedSession) return

    try {
      await resetUserExamSession(topicId, selectedSession.user_id)
      toast({
        title: t('exam_sessions.reset_success'),
        description: t('exam_sessions.reset_success_description', {
          user: selectedSession.user_name || `User #${selectedSession.user_id}`,
        }),
      })
      loadSessions()
    } catch (_error) {
      toast({
        title: t('exam_sessions.reset_failed'),
        description: t('exam_sessions.reset_failed_description'),
        variant: 'destructive',
      })
    } finally {
      setResetDialogOpen(false)
      setSelectedSession(null)
    }
  }

  // Handle phase change
  const handlePhaseChangeClick = (session: ExamSession, phase: PhaseType) => {
    setSelectedSession(session)
    setTargetPhase(phase)
    setPhaseDialogOpen(true)
  }

  const handlePhaseChangeConfirm = async () => {
    if (!selectedSession) return

    try {
      const result = await updateUserExamSessionPhase(
        topicId,
        selectedSession.user_id,
        targetPhase,
        true
      )
      toast({
        title: t('exam_sessions.phase_updated'),
        description: result.message,
      })
      loadSessions()
    } catch (_error) {
      toast({
        title: t('exam_sessions.phase_update_failed'),
        description: t('exam_sessions.phase_update_failed_description'),
        variant: 'destructive',
      })
    } finally {
      setPhaseDialogOpen(false)
      setSelectedSession(null)
    }
  }

  // Handle force end
  const handleForceEndClick = (session: ExamSession) => {
    setSelectedSession(session)
    setForceEndDialogOpen(true)
  }

  const handleForceEndConfirm = async () => {
    if (!selectedSession) return

    try {
      const result = await forceEndExamSession(topicId, selectedSession.user_id)
      toast({
        title: t('exam_sessions.force_end_success'),
        description: result.message,
      })
      loadSessions()
    } catch (_error) {
      toast({
        title: t('exam_sessions.force_end_failed'),
        description: t('exam_sessions.force_end_failed_description'),
        variant: 'destructive',
      })
    } finally {
      setForceEndDialogOpen(false)
      setSelectedSession(null)
    }
  }

  // Calculate total pages
  const totalPages = Math.ceil(total / SESSIONS_PER_PAGE)

  return (
    <div className="space-y-6">
      {/* Filter Select - Always visible */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <Select
            value={activeTab}
            onValueChange={value => setActiveTab(value as PhaseType | 'all')}
          >
            <SelectTrigger className="w-40 bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('common.all')}</SelectItem>
              <SelectItem value="intro">{t('exam_sessions.phase.intro')}</SelectItem>
              <SelectItem value="exam">{t('exam_sessions.phase.exam')}</SelectItem>
              <SelectItem value="review">{t('exam_sessions.phase.review')}</SelectItem>
              <SelectItem value="completed">{t('exam_sessions.phase.completed')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="text-sm text-gray-500">
          {t('common:total', 'Total')}: {total}
        </span>
      </div>

      {/* Sessions List */}
      {loading && sessions.length === 0 ? (
        <SessionsListSkeleton />
      ) : sessions.length === 0 && !loading ? (
        <EmptyState t={t} />
      ) : (
        <div className="space-y-4">
          {sessions.map(session => (
            <SessionCard
              key={session.user_id}
              session={session}
              topicId={topicId}
              onReset={handleResetClick}
              onPhaseChange={handlePhaseChangeClick}
              onForceEnd={handleForceEndClick}
              t={t}
            />
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
              >
                {t('common:previous', 'Previous')}
              </Button>
              <span className="text-sm text-gray-500">
                {t('common:page', 'Page')} {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
              >
                {t('common:next', 'Next')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('exam_sessions.reset_dialog_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('exam_sessions.reset_dialog_description', {
                user: selectedSession?.user_name || `User #${selectedSession?.user_id}`,
              })}
              <span className="block mt-2 text-sm text-gray-500">
                {t('exam_sessions.action_cannot_undo')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleResetConfirm}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {t('exam_sessions.reset_session')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Phase Change Confirmation Dialog */}
      <AlertDialog open={phaseDialogOpen} onOpenChange={setPhaseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('exam_sessions.phase_dialog_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('exam_sessions.phase_dialog_description', {
                user: selectedSession?.user_name || `User #${selectedSession?.user_id}`,
                phase: t(`exam_sessions.phase.${targetPhase}`),
              })}
              {targetPhase === 'completed' && (
                <span className="block mt-2 text-orange-600">
                  {t('exam_sessions.completed_note')}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handlePhaseChangeConfirm}>
              {t('common:actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force End Confirmation Dialog */}
      <AlertDialog open={forceEndDialogOpen} onOpenChange={setForceEndDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('exam_sessions.force_end_dialog_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('exam_sessions.force_end_dialog_description', {
                user: selectedSession?.user_name || `User #${selectedSession?.user_id}`,
              })}
              <span className="block mt-2 text-sm text-gray-500">
                {t('exam_sessions.force_end_warning')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleForceEndConfirm}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {t('exam_sessions.force_end')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
