// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { formatRelativeTime } from '@/utils/dateTime'
import { codeWikiApi } from '@/apis/code-wiki'
import type { CodeWikiRunRecord, CodeWikiRunStatus } from '@/types/code-wiki'
import { failureText } from './failureText'

interface RunHistoryProps {
  knowledgeBaseId: number
  status: CodeWikiRunStatus | null
}

/** What the chip says before anyone opens it. */
export function summarise(
  status: CodeWikiRunStatus | null,
  t: (key: string, options?: Record<string, unknown>) => string
): { label: string; tone: 'ok' | 'bad' | 'busy' | 'idle' } {
  if (!status || status.status === 'never') {
    return { label: t('codeWiki.history.never'), tone: 'idle' }
  }
  if (status.status === 'running') {
    return {
      label: status.is_stale ? t('codeWiki.history.stalled') : t('codeWiki.history.running'),
      tone: status.is_stale ? 'bad' : 'busy',
    }
  }
  if (status.status === 'failed') {
    return { label: t('codeWiki.history.lastFailed'), tone: 'bad' }
  }
  return {
    label: status.last_published_at
      ? t('codeWiki.history.updated', {
          when: formatRelativeTime(status.last_published_at, t),
        })
      : t('codeWiki.history.completed'),
    tone: 'ok',
  }
}

/**
 * Whether a version can be made live again.
 *
 * Only a completed version that is not already the one readers see. A failed run may
 * well hold pages, but they are the pages of a run that did not succeed, and the
 * server refuses them for the same reason — this is the client's copy of that rule,
 * named so it can be tested rather than inlined into a condition.
 */
export function canRepublish(run: Pick<CodeWikiRunRecord, 'status' | 'published'>): boolean {
  return run.status === 'completed' && !run.published
}

const TONE_CLASS: Record<string, string> = {
  ok: 'text-text-secondary',
  bad: 'text-amber-500',
  busy: 'text-primary',
  idle: 'text-text-tertiary',
}

function RunIcon({ status }: { status: CodeWikiRunRecord['status'] }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
  if (status === 'failed') return <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
}

function RunRow({
  run,
  knowledgeBaseId,
  onRepublished,
}: {
  run: CodeWikiRunRecord
  knowledgeBaseId: number
  onRepublished: () => void
}) {
  const { t } = useTranslation('knowledge')
  const when = formatRelativeTime(run.started_at, t)
  const reason = failureText(run.failure_code, run.error_message, t)
  const [working, setWorking] = useState(false)

  const republish = async () => {
    setWorking(true)
    try {
      await codeWikiApi.republish(knowledgeBaseId, run.generation_id)
      toast.success(t('codeWiki.history.republished'))
      onRepublished()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  return (
    <li
      className="flex gap-2 border-b border-border/60 py-2 last:border-0"
      data-testid="code-wiki-run-row"
    >
      <span className="mt-0.5 shrink-0">
        <RunIcon status={run.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-text-secondary">{when}</span>
          {run.mode && (
            <span className="text-[11px] text-text-tertiary">
              {t(`codeWiki.history.mode.${run.mode}`)}
            </span>
          )}
          {run.published && (
            <span className="rounded bg-primary/10 px-1 text-[11px] text-primary">
              {t('codeWiki.history.current')}
            </span>
          )}
        </div>
        {/* Stated as missing rather than left blank. An empty commit is not a
            cosmetic gap: the next run has nothing to compare against and rebuilds
            the whole wiki, so it is worth being able to see that it happened. */}
        <div className="truncate font-mono text-[11px] text-text-tertiary">
          {run.commit ? (
            run.commit.slice(0, 8)
          ) : (
            <span className="font-sans not-italic">{t('codeWiki.history.commitUnreported')}</span>
          )}
        </div>
        {/* The reason is the point of this panel, so it wraps rather than truncates:
            a clone failure or a missing token is unreadable at one line. */}
        {/* The task's own outcome, when it disagrees with the version's. A run that
            concluded successfully leaves a published version behind even if its
            container then died — showing only one of the two made them look as
            though they contradicted each other. */}
        {run.task_status === 'FAILED' && run.status === 'completed' && (
          <p className="mt-0.5 text-[11px] text-amber-500" data-testid="code-wiki-run-task-failed">
            {t('codeWiki.history.taskFailed')}
          </p>
        )}
        {/* Only a completed version that is not the live one has anything to go
            back to. The gate is advisory now, so a run that went wrong does reach
            readers, and everything it replaced is still in the version store. */}
        {canRepublish(run) && (
          <button
            type="button"
            onClick={republish}
            disabled={working}
            title={t('codeWiki.history.republishHint')}
            data-testid={`code-wiki-republish-${run.generation_id}`}
            className="mt-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:border-primary/40 disabled:opacity-50"
          >
            {t('codeWiki.history.republish')}
          </button>
        )}
        {reason && (
          <p
            className="mt-0.5 break-words text-[11px] text-amber-500"
            data-testid="code-wiki-run-error"
          >
            {reason}
          </p>
        )}
      </div>
    </li>
  )
}

/**
 * Why the wiki looks the way it does.
 *
 * A popover rather than a panel or a route: the reader already has three regions and
 * two modes, and this is a troubleshooting question asked occasionally — most often
 * on a wiki with no pages, where every run failed and the only useful answer is in a
 * run that already ended.
 *
 * Fetched when opened, not polled. The status chip beside it is already live, and
 * repeating a list of finished runs every few seconds would tell nobody anything.
 */
export function RunHistory({ knowledgeBaseId, status }: RunHistoryProps) {
  const { t } = useTranslation('knowledge')
  const [runs, setRuns] = useState<CodeWikiRunRecord[] | null>(null)
  const [loading, setLoading] = useState(false)
  const chip = summarise(status, t)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRuns((await codeWikiApi.history(knowledgeBaseId)).runs)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId])

  return (
    <Popover
      onOpenChange={open => {
        // Re-read on every open: a run may have ended since the last look, and a
        // stale list is worse than a brief spinner on the screen that exists to
        // explain what happened.
        if (open) void load()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-surface-hover ${TONE_CLASS[chip.tone]}`}
          data-testid="code-wiki-history-trigger"
        >
          <Clock className="h-3.5 w-3.5" />
          {chip.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3" data-testid="code-wiki-history">
        <p className="mb-2 text-xs font-medium text-text-primary">{t('codeWiki.history.title')}</p>
        {loading && runs === null ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : runs && runs.length > 0 ? (
          <ul className="max-h-80 overflow-auto">
            {runs.map(run => (
              <RunRow
                key={run.generation_id}
                run={run}
                knowledgeBaseId={knowledgeBaseId}
                onRepublished={load}
              />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-text-tertiary">{t('codeWiki.history.none')}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
