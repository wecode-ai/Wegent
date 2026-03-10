// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import { History, FileText, RotateCcw, CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
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
import { listAuthorTopicVersions, rollbackAuthorTopic } from '@wecode/api/evaluation-author'
import type { TopicVersion, QuestionSnapshot } from '@wecode/types/evaluation'

/**
 * Props for the VersionsTab component
 */
interface VersionsTabProps {
  /** Topic ID */
  topicId: number
  /** Current version of the topic */
  currentVersion?: string
}

/**
 * Empty state component when no versions exist
 */
function EmptyState() {
  const { t } = useTranslation('evaluation')

  return (
    <div className="bg-white rounded-2xl border border-gray-100 border-dashed p-12 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-4">
        <History className="w-8 h-8 text-gray-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{t('topics.no_versions')}</h3>
      <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
        {t('topics.no_versions_description')}
      </p>
    </div>
  )
}

/**
 * Loading skeleton for versions list
 */
function VersionsListSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-4">
            <Skeleton className="h-6 w-16 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-48" />
            </div>
            <Skeleton className="h-9 w-24 rounded-lg shrink-0" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * QuestionSnapshotItem - Display a single question snapshot
 */
interface QuestionSnapshotItemProps {
  /** The question snapshot to display */
  snapshot: QuestionSnapshot
  /** Index for display numbering */
  index: number
}

function QuestionSnapshotItem({ snapshot, index }: QuestionSnapshotItemProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-3 border border-gray-100">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-xs font-medium border border-gray-200">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-gray-900 truncate">{snapshot.title}</div>
        <div className="text-xs text-gray-500">
          v{snapshot.version} | ID: {snapshot.question_id}
        </div>
      </div>
      <FileText className="h-4 w-4 text-gray-400 shrink-0" />
    </div>
  )
}

/**
 * VersionCard - Individual version card component
 */
interface VersionCardProps {
  /** The version data to display */
  version: TopicVersion
  /** Whether this is the current version */
  isCurrentVersion: boolean
  /** Callback when rollback is clicked */
  onRollback: (version: TopicVersion) => void
}

function VersionCard({ version, isCurrentVersion, onRollback }: VersionCardProps) {
  const { t } = useTranslation('evaluation')

  return (
    <div
      className={`
        bg-white rounded-2xl border shadow-sm
        ${isCurrentVersion ? 'border-blue-200 bg-blue-50/30' : 'border-gray-100'}
        overflow-hidden
      `}
    >
      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value={`version-${version.id}`} className="border-0">
          <AccordionTrigger className="hover:no-underline px-5 py-4 [&[data-state=open]]:pb-2">
            <div className="flex flex-1 items-center justify-between pr-4">
              <div className="flex items-center gap-4 flex-wrap">
                {/* Version Badge */}
                <Badge
                  variant={isCurrentVersion ? 'success' : 'secondary'}
                  className="text-sm px-3 py-1"
                >
                  v{version.version}
                </Badge>

                {/* Current Badge */}
                {isCurrentVersion && (
                  <Badge
                    variant="info"
                    className="flex items-center gap-1 bg-blue-100 text-blue-700 border-blue-200"
                  >
                    <CheckCircle className="h-3 w-3" />
                    {t('versions.current')}
                  </Badge>
                )}

                {/* Publish Date */}
                <span className="text-sm text-gray-500">
                  {new Date(version.published_at).toLocaleString()}
                </span>

                {/* Question Count */}
                <span className="text-sm text-gray-400">
                  {version.question_snapshots?.length || 0} {t('questions.title', 'questions')}
                </span>
              </div>

              {/* Rollback Button */}
              {!isCurrentVersion && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={e => {
                    e.stopPropagation()
                    onRollback(version)
                  }}
                  className="ml-4 shrink-0"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t('versions.rollback')}
                </Button>
              )}
            </div>
          </AccordionTrigger>

          <AccordionContent className="px-5 pb-4">
            <div className="pt-2 space-y-2">
              {version.question_snapshots && version.question_snapshots.length > 0 ? (
                version.question_snapshots.map((snapshot, qIndex) => (
                  <QuestionSnapshotItem
                    key={snapshot.question_id}
                    snapshot={snapshot}
                    index={qIndex}
                  />
                ))
              ) : (
                <p className="text-sm text-gray-500 py-4 text-center">
                  {t('questions.no_questions', 'No questions in this version')}
                </p>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}

/**
 * VersionsTab - Tab content for managing topic versions
 *
 * Features:
 * - Vertical timeline/accordion showing version history
 * - Each version shows version number, publish date, question count
 * - Expandable to see question snapshots
 * - Rollback button for non-current versions
 * - Empty state when no versions
 * - Loading skeleton state
 * - Pagination support
 *
 * Design:
 * - Clean white cards with accordion
 * - Current version highlighted with blue border
 * - Smooth transitions and hover effects
 */
export function VersionsTab({ topicId, currentVersion }: VersionsTabProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [versions, setVersions] = useState<TopicVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Rollback dialog state
  const [rollbackVersion, setRollbackVersion] = useState<TopicVersion | null>(null)
  const [isRollbackDialogOpen, setIsRollbackDialogOpen] = useState(false)
  const [isRollingBack, setIsRollingBack] = useState(false)

  const VERSIONS_PER_PAGE = 20

  // Load versions data
  const loadVersions = useCallback(async () => {
    setLoading(true)
    try {
      const response = await listAuthorTopicVersions(topicId, {
        page,
        limit: VERSIONS_PER_PAGE,
      })
      setVersions(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.load_versions_failed'),
        variant: 'destructive',
      })
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [topicId, page, toast, t])

  useEffect(() => {
    if (topicId) {
      loadVersions()
    }
  }, [topicId, loadVersions])

  // Handle rollback click
  const handleRollbackClick = (version: TopicVersion) => {
    setRollbackVersion(version)
    setIsRollbackDialogOpen(true)
  }

  // Handle rollback confirm
  const handleRollbackConfirm = async () => {
    if (!rollbackVersion) return

    setIsRollingBack(true)
    try {
      await rollbackAuthorTopic(topicId, rollbackVersion.version)
      toast({
        title: t('versions.rollback_success'),
        description: t('versions.rollback_success_description', {
          version: rollbackVersion.version,
        }),
      })
      // Reload to get updated current version
      loadVersions()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: t('errors.rollback_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsRollingBack(false)
      setIsRollbackDialogOpen(false)
      setRollbackVersion(null)
    }
  }

  // Calculate total pages
  const totalPages = Math.ceil(total / VERSIONS_PER_PAGE)

  if (loading && versions.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-6 w-32" />
        </div>
        <VersionsListSkeleton />
      </div>
    )
  }

  if (versions.length === 0 && !loading) {
    return <EmptyState />
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-gray-500" />
          <h3 className="text-lg font-semibold text-gray-900">{t('topics.version_history')}</h3>
        </div>
        {currentVersion && (
          <Badge variant="info" className="bg-blue-100 text-blue-700">
            {t('versions.current_version')}: v{currentVersion}
          </Badge>
        )}
      </div>

      {/* Versions list */}
      <div className="space-y-4">
        {versions.map(version => (
          <VersionCard
            key={version.id}
            version={version}
            isCurrentVersion={currentVersion === version.version}
            onRollback={handleRollbackClick}
          />
        ))}
      </div>

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

      {/* Rollback Confirmation Dialog */}
      <AlertDialog open={isRollbackDialogOpen} onOpenChange={setIsRollbackDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('versions.rollback_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('versions.rollback_description', {
                version: rollbackVersion?.version || '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRollingBack}>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRollbackConfirm}
              disabled={isRollingBack}
              className="bg-primary hover:bg-primary/90"
            >
              {isRollingBack ? (
                <>
                  <RotateCcw className="mr-2 h-4 w-4 animate-spin" />
                  {t('versions.rolling_back')}
                </>
              ) : (
                <>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t('versions.rollback')}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
