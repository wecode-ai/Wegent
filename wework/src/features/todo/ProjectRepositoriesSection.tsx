import { Archive, GitBranch, Plus } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { RepositoryBinding } from '@/api/projectWorkflows'
import { useTranslation } from '@/hooks/useTranslation'
import type { RepositoryDraft } from './projectWorkflowDrafts'

interface ProjectRepositoriesSectionProps {
  repositories: RepositoryBinding[]
  draft: RepositoryDraft
  setDraft: Dispatch<SetStateAction<RepositoryDraft>>
  canManage: boolean
  busy: boolean
  onValidate: (repository: RepositoryBinding) => void
  onArchive: (repository: RepositoryBinding) => void
  onCreate: () => void
}

export function ProjectRepositoriesSection({
  repositories,
  draft,
  setDraft,
  canManage,
  busy,
  onValidate,
  onArchive,
  onCreate,
}: ProjectRepositoriesSectionProps) {
  const { t } = useTranslation('common')
  return (
    <div className="rounded-xl border border-border p-4" data-testid="project-repositories">
      <header className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted">
          <GitBranch className="h-4 w-4 text-text-secondary" />
        </span>
        <span className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-text-primary">
            {t('workbench.dev_workflow_repositories')}
          </h4>
          <p className="mt-0.5 text-xs text-text-muted">
            {t('workbench.dev_workflow_repositories_description')}
          </p>
        </span>
      </header>
      <div className="mt-4 space-y-2" data-testid="project-repository-list">
        {repositories
          .filter(repository => repository.status === 'active')
          .map(repository => (
            <div
              key={repository.id}
              className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2.5"
            >
              <GitBranch className="h-4 w-4 text-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {repository.repositoryIdentity}
                </span>
                <span className="block truncate text-xs text-text-muted">
                  {repository.provider} · {repository.defaultBranch}
                </span>
              </span>
              {repository.hasCredential ? (
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700">
                  {t('workbench.dev_workflow_credential_ready')}
                </span>
              ) : null}
              {canManage ? (
                <>
                  <button
                    type="button"
                    data-testid={`validate-repository-${repository.id}`}
                    disabled={busy}
                    onClick={() => onValidate(repository)}
                    className="rounded-md px-1.5 py-1 text-xs text-text-muted hover:bg-background hover:text-text-primary"
                  >
                    {t('workbench.dev_workflow_validate')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onArchive(repository)}
                    className="rounded-md p-1 text-text-muted hover:bg-background hover:text-destructive"
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </div>
          ))}
      </div>
      {canManage ? (
        <div className="mt-4 grid gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-2">
          <select
            value={draft.provider}
            onChange={event =>
              setDraft(current => ({
                ...current,
                provider: event.target.value as RepositoryBinding['provider'],
              }))
            }
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="generic">Generic Git</option>
          </select>
          <input
            data-testid="repository-identity"
            value={draft.repositoryIdentity}
            onChange={event =>
              setDraft(current => ({ ...current, repositoryIdentity: event.target.value }))
            }
            placeholder="owner/repository"
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <input
            data-testid="repository-url"
            value={draft.repositoryUrl}
            onChange={event =>
              setDraft(current => ({ ...current, repositoryUrl: event.target.value }))
            }
            placeholder="https://github.com/owner/repository.git"
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm md:col-span-2"
          />
          <input
            value={draft.defaultBranch}
            onChange={event =>
              setDraft(current => ({ ...current, defaultBranch: event.target.value }))
            }
            placeholder={t('workbench.dev_workflow_default_branch')}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <input
            value={draft.credentialRef}
            onChange={event =>
              setDraft(current => ({ ...current, credentialRef: event.target.value }))
            }
            placeholder={t('workbench.dev_workflow_credential_ref')}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <input
            value={draft.branchPattern}
            onChange={event =>
              setDraft(current => ({ ...current, branchPattern: event.target.value }))
            }
            placeholder={t('workbench.dev_workflow_branch_pattern')}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <input
            value={draft.pullRequestBase}
            onChange={event =>
              setDraft(current => ({ ...current, pullRequestBase: event.target.value }))
            }
            placeholder={t('workbench.dev_workflow_pr_base')}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={draft.autoCreatePullRequest}
              onChange={event =>
                setDraft(current => ({ ...current, autoCreatePullRequest: event.target.checked }))
              }
            />
            {t('workbench.dev_workflow_auto_pr')}
          </label>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={draft.autoMerge}
              onChange={event =>
                setDraft(current => ({ ...current, autoMerge: event.target.checked }))
              }
            />
            {t('workbench.dev_workflow_auto_merge')}
          </label>
          <button
            type="button"
            data-testid="create-repository"
            disabled={busy || !draft.repositoryIdentity.trim() || !draft.repositoryUrl.trim()}
            onClick={onCreate}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40 md:col-span-2 md:justify-self-end"
          >
            <Plus className="h-4 w-4" />
            {t('workbench.dev_workflow_add_repository')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
