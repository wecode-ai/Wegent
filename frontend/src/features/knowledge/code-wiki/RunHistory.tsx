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
    return { label: t('knowledge:codeWiki.history.never'), tone: 'idle' }
  }
  if (status.status === 'running') {
    return {
      label: status.is_stale
        ? t('knowledge:codeWiki.history.stalled')
        : t('knowledge:codeWiki.history.running'),
      tone: status.is_stale ? 'bad' : 'busy',
    }
  }
  if (status.status === 'failed') {
    return { label: t('knowledge:codeWiki.history.lastFailed'), tone: 'bad' }
  }
  return {
    label: status.last_published_at
      ? t('knowledge:codeWiki.history.updated', {
          when: formatRelativeTime(status.last_published_at, t),
        })
      : t('knowledge:codeWiki.history.completed'),
    tone: 'ok',
  }
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

function RunRow({ run }: { run: CodeWikiRunRecord }) {
  const { t } = useTranslation()
  const when = formatRelativeTime(run.started_at, t)
  const reason = failureText(run.failure_code, run.error_message, t)

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
              {t(`knowledge:codeWiki.history.mode.${run.mode}`)}
            </span>
          )}
          {run.published && (
            <span className="rounded bg-primary/10 px-1 text-[11px] text-primary">
              {t('knowledge:codeWiki.history.current')}
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
            <span className="font-sans not-italic">
              {t('knowledge:codeWiki.history.commitUnreported')}
            </span>
          )}
        </div>
        {/* The reason is the point of this panel, so it wraps rather than truncates:
            a clone failure or a missing token is unreadable at one line. */}
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
  const { t } = useTranslation()
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
        <p className="mb-2 text-xs font-medium text-text-primary">
          {t('knowledge:codeWiki.history.title')}
        </p>
        {loading && runs === null ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : runs && runs.length > 0 ? (
          <ul className="max-h-80 overflow-auto">
            {runs.map(run => (
              <RunRow key={run.generation_id} run={run} />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-text-tertiary">{t('knowledge:codeWiki.history.none')}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
