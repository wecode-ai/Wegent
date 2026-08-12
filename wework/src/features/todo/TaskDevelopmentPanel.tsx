import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Circle,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  LoaderCircle,
  MessageSquareWarning,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  RepositoryBinding,
  TaskDevelopment,
  createProjectWorkflowApi,
} from '@/api/projectWorkflows'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'

type ProjectWorkflowApi = ReturnType<typeof createProjectWorkflowApi>

function stateTone(state: string | null): string {
  if (['success', 'passed', 'approved', 'merged', 'mergeable', 'clean'].includes(state || '')) {
    return 'text-emerald-700 dark:text-emerald-400'
  }
  if (
    ['failure', 'failed', 'changes_requested', 'conflicting', 'dirty', 'cancelled'].includes(
      state || ''
    )
  ) {
    return 'text-destructive'
  }
  return 'text-text-muted'
}

function CheckStateIcon({ state }: { state: string | null }) {
  if (['success', 'passed', 'completed', 'skipped', 'neutral'].includes(state || '')) {
    return <Check className="h-3.5 w-3.5 text-emerald-600" />
  }
  if (['failure', 'failed', 'cancelled', 'timed_out'].includes(state || '')) {
    return <X className="h-3.5 w-3.5 text-destructive" />
  }
  if (['running', 'in_progress', 'queued', 'pending'].includes(state || '')) {
    return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-blue-600" />
  }
  return <Circle className="h-3.5 w-3.5 text-text-muted" />
}

export function TaskDevelopmentPanel({
  projectId,
  itemId,
  api,
}: {
  projectId: string
  itemId: string
  api: ProjectWorkflowApi
}) {
  const { t } = useTranslation('common')
  const [links, setLinks] = useState<TaskDevelopment[]>([])
  const [repositories, setRepositories] = useState<RepositoryBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextLinks, nextRepositories] = await Promise.all([
        api.getTaskDevelopment(projectId, itemId),
        api.listRepositories(projectId),
      ])
      setLinks(nextLinks)
      setRepositories(nextRepositories)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workbench.development_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [api, itemId, projectId, t])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (!links.some(link => link.pullRequestState && link.pullRequestState !== 'merged')) return
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [links, load])

  const repositoryNames = useMemo(
    () => new Map(repositories.map(repository => [repository.id, repository.repositoryIdentity])),
    [repositories]
  )

  const runAction = useCallback(
    async (key: string, action: () => Promise<TaskDevelopment>) => {
      setActionBusy(key)
      setError(null)
      try {
        const updated = await action()
        setLinks(current => current.map(link => (link.id === updated.id ? updated : link)))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('workbench.development_action_failed'))
      } finally {
        setActionBusy(null)
      }
    },
    [t]
  )

  if (!loading && !links.length && !error) return null

  return (
    <section
      data-testid="task-development-panel"
      className="mt-5 overflow-hidden rounded-xl border border-border bg-background"
    >
      <header className="flex min-h-11 items-center gap-2 border-b border-border px-3">
        <GitBranch className="h-4 w-4 text-text-secondary" />
        <h3 className="text-sm font-medium text-text-primary">
          {t('workbench.development_title')}
        </h3>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="task-development-refresh"
          aria-label={t('workbench.development_refresh')}
          disabled={loading}
          onClick={() => void load()}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-muted disabled:opacity-40"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </header>
      <div className="p-3">
        {loading && !links.length ? (
          <div className="flex h-16 items-center justify-center gap-2 text-sm text-text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t('workbench.development_loading')}
          </div>
        ) : (
          <div className="space-y-3">
            {links.map(link => (
              <div
                key={link.id}
                data-testid={`task-development-link-${link.id}`}
                className="rounded-lg border border-border p-3"
              >
                <div className="grid gap-2 text-xs md:grid-cols-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span className="min-w-0">
                      <span className="block text-text-muted">
                        {repositoryNames.get(link.repositoryBindingId) || link.provider}
                      </span>
                      <span className="block truncate font-medium text-text-primary">
                        {link.branchName}
                      </span>
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span className="min-w-0">
                      <span className="block text-text-muted">
                        {t('workbench.development_commit')}
                      </span>
                      <span className="block truncate font-mono text-text-primary">
                        {link.headCommit?.slice(0, 12) || '—'}
                      </span>
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span>
                      <span className="block text-text-muted">CI</span>
                      <span className={cn('block font-medium', stateTone(link.ciState))}>
                        {link.ciState || t('workbench.development_waiting')}
                      </span>
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <GitMerge className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span>
                      <span className="block text-text-muted">
                        {t('workbench.development_review_merge')}
                      </span>
                      <span
                        className={cn(
                          'block font-medium',
                          stateTone(
                            link.pullRequestState === 'merged'
                              ? 'merged'
                              : link.reviewDecision || link.mergeableState
                          )
                        )}
                      >
                        {link.pullRequestState === 'merged'
                          ? t('workbench.development_merged')
                          : link.reviewDecision ||
                            link.mergeableState ||
                            t('workbench.development_waiting')}
                      </span>
                    </span>
                  </span>
                </div>

                {link.workspace ? (
                  <div className="mt-3 rounded-md bg-muted/60 px-2.5 py-2 text-xs">
                    <span className="text-text-muted">
                      {t('workbench.development_workspace')} · {link.workspace.workspaceKind} ·{' '}
                      {link.workspace.status}
                    </span>
                    {link.workspace.workspacePath ? (
                      <span className="mt-0.5 block truncate font-mono text-text-secondary">
                        {link.workspace.workspacePath}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {link.pullRequestId ? (
                  <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs">
                    <GitMerge className="h-3.5 w-3.5 text-text-muted" />
                    <span className="min-w-0 flex-1 truncate">
                      {link.draft ? 'Draft ' : ''}#{link.pullRequestNumber || link.pullRequestId} ·{' '}
                      {link.pullRequestState || t('workbench.development_waiting')}
                    </span>
                    {link.pullRequestUrl ? (
                      <button
                        type="button"
                        data-testid={`task-development-open-pr-${link.id}`}
                        onClick={() => void openExternalUrl(link.pullRequestUrl!)}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-text-secondary hover:bg-background"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {t('workbench.development_open_pr')}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {!link.pullRequestId ? (
                    <button
                      type="button"
                      data-testid={`task-development-create-pr-${link.id}`}
                      disabled={actionBusy !== null}
                      onClick={() =>
                        void runAction(`create:${link.id}`, () =>
                          api.createPullRequest(projectId, itemId, link.id, {
                            title: link.branchName,
                            body: `Automated development run for ${link.branchName}`,
                            draft: true,
                          })
                        )
                      }
                      className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-muted disabled:opacity-40"
                    >
                      {actionBusy === `create:${link.id}` ? (
                        <LoaderCircle className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {t('workbench.development_create_draft_pr')}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        data-testid={`task-development-refresh-pr-${link.id}`}
                        disabled={actionBusy !== null}
                        onClick={() =>
                          void runAction(`refresh:${link.id}`, () =>
                            api.refreshPullRequest(projectId, itemId, link.id)
                          )
                        }
                        className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-muted disabled:opacity-40"
                      >
                        {actionBusy === `refresh:${link.id}` ? (
                          <LoaderCircle className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 inline h-3.5 w-3.5" />
                        )}
                        {t('workbench.development_refresh_provider')}
                      </button>
                      {link.pullRequestState !== 'merged' ? (
                        <button
                          type="button"
                          data-testid={`task-development-merge-pr-${link.id}`}
                          disabled={
                            actionBusy !== null ||
                            link.ciState !== 'success' ||
                            link.reviewDecision !== 'approved'
                          }
                          title={
                            link.ciState !== 'success' || link.reviewDecision !== 'approved'
                              ? t('workbench.development_merge_blocked')
                              : undefined
                          }
                          onClick={() =>
                            void runAction(`merge:${link.id}`, () =>
                              api.mergePullRequest(projectId, itemId, link.id, {
                                version: link.version,
                                method: 'squash',
                              })
                            )
                          }
                          className="rounded-md bg-text-primary px-2.5 py-1.5 text-xs text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          {actionBusy === `merge:${link.id}` ? (
                            <LoaderCircle className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <GitMerge className="mr-1 inline h-3.5 w-3.5" />
                          )}
                          {t('workbench.development_merge_pr')}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>

                {link.checks.length ? (
                  <div className="mt-3 space-y-1" data-testid="task-development-checks">
                    {link.checks.map(check => (
                      <div
                        key={check.id}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/50"
                      >
                        <CheckStateIcon state={check.conclusion || check.status} />
                        <span className="min-w-0 flex-1 truncate">{check.name}</span>
                        <span className={stateTone(check.conclusion || check.status)}>
                          {check.conclusion || check.status}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {link.reviewThreads.length ? (
                  <div
                    className="mt-3 space-y-2"
                    data-testid={`task-development-review-threads-${link.id}`}
                  >
                    <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                      <MessageSquareWarning className="h-3.5 w-3.5" />
                      Review threads ·{' '}
                      {link.reviewThreads.filter(thread => thread.status === 'open').length} open
                    </div>
                    {link.reviewThreads.map(thread => (
                      <div
                        key={thread.id}
                        data-testid={`task-development-review-thread-${thread.id}`}
                        className={cn(
                          'rounded-md border px-2.5 py-2 text-xs',
                          thread.status === 'open'
                            ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20'
                            : 'border-border bg-muted/40'
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'font-medium',
                              thread.status === 'open'
                                ? 'text-amber-800 dark:text-amber-300'
                                : 'text-text-muted'
                            )}
                          >
                            {thread.status}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">
                            {thread.path || 'General review'}
                            {thread.line ? `:${thread.line}` : ''}
                          </span>
                          {thread.author ? (
                            <span className="shrink-0 text-text-muted">@{thread.author}</span>
                          ) : null}
                          {thread.url ? (
                            <button
                              type="button"
                              data-testid={`task-development-open-review-thread-${thread.id}`}
                              onClick={() => void openExternalUrl(thread.url!)}
                              className="rounded p-1 text-text-muted hover:bg-background"
                              aria-label="Open review thread"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </div>
                        {thread.body ? (
                          <p className="mt-1.5 whitespace-pre-wrap break-words text-text-secondary">
                            {thread.body}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {error ? (
          <p data-testid="task-development-error" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
