// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RepositorySelector } from '@/features/tasks/components/selector'
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'
import { useTranslation } from '@/hooks/useTranslation'
import { codeWikiApi } from '@/apis/code-wiki'
import { useUser } from '@/features/common/UserContext'
import type { GitInfo, GitRepoInfo } from '@/types/api'
import type { CodeWikiResolution, CodeWikiSourceType } from '@/types/code-wiki'

export interface CodeWikiSourceDraft {
  mode: 'select' | 'url'
  repo: GitRepoInfo | null
  urlInput: string
  urlSourceType: CodeWikiSourceType
  language: string
  probe: { url: string; type: CodeWikiSourceType; result: CodeWikiResolution } | null
}

interface CodeWikiSourceFieldsProps {
  value: CodeWikiSourceDraft
  repository: ReturnType<typeof useCodeWikiRepository>
  onChange: Dispatch<SetStateAction<CodeWikiSourceDraft>>
}

const SOURCE_TYPES: CodeWikiSourceType[] = ['github', 'gitlab', 'gitea']

function isSourceType(value: unknown): value is CodeWikiSourceType {
  return SOURCE_TYPES.some(type => type === value)
}

/**
 * Infer which platform hosts a URL, or `null` when it cannot be told.
 *
 * A self-hosted GitLab or Gitea is not recognisable from its domain, so guessing
 * would bind the wiki to a provider that answers meaninglessly about it. Returning
 * null makes the caller ask instead.
 */
function hostOf(url: string): string {
  return url.match(/^https?:\/\/([^/]+)/)?.[1]?.toLowerCase() ?? ''
}

function inferSourceType(url: string, configured: GitInfo[] = []): CodeWikiSourceType | null {
  const host = hostOf(url)
  if (!host) return null

  // What the caller already told us this host is, before the public defaults. A
  // self-hosted GitLab or Gitea is unrecognisable from its domain, and guessing
  // wrong is not a harmless wrong guess: the request reaches a real API of another
  // vendor, which answers with a retired-version error or "invalid token" for a
  // credential that is perfectly good.
  const known = configured.find(entry => entry.git_domain?.toLowerCase() === host)
  if (known && SOURCE_TYPES.includes(known.type as CodeWikiSourceType)) {
    return known.type as CodeWikiSourceType
  }

  if (host === 'github.com') return 'github'
  if (host === 'gitlab.com') return 'gitlab'
  if (host === 'gitea.com') return 'gitea'
  return null
}

export function useCodeWikiRepository(draft: CodeWikiSourceDraft) {
  const { user } = useUser()
  const url = (draft.mode === 'url' ? draft.urlInput : (draft.repo?.git_url ?? '')).trim()
  const inferredType = draft.mode === 'url' ? inferSourceType(url, user?.git_info) : null
  const type =
    draft.mode === 'url'
      ? (inferredType ?? draft.urlSourceType)
      : draft.repo?.type == null
        ? (inferSourceType(url, user?.git_info) ?? 'github')
        : isSourceType(draft.repo.type)
          ? draft.repo.type
          : null
  const probe = draft.probe
  const resolution = probe?.url === url && probe.type === type ? probe.result : null
  return { url, type, inferredType, resolution }
}

/**
 * Where the repository comes from, by picking one or by naming one.
 *
 * Both are needed. The selector lists only repositories the caller is a member of,
 * so a public repository they can read in a browser never appears in it — and a wiki
 * that could not be built for one would be more closed than the repository itself.
 *
 * The shared RepositorySelector is embedded rather than extended: it is used by task
 * creation too, and its list is membership-scoped on the server, which is not
 * something a component can change.
 */
export function CodeWikiSourceFields({ value, repository, onChange }: CodeWikiSourceFieldsProps) {
  const { t } = useTranslation('knowledge')
  const [resolving, setResolving] = useState(false)
  const [failedProbe, setFailedProbe] = useState<{ url: string; type: CodeWikiSourceType } | null>(
    null
  )
  const [probeAttempt, setProbeAttempt] = useState(0)
  const { mode, repo, urlInput, urlSourceType } = value
  const { url, type, inferredType, resolution } = repository
  const probeFailed = failedProbe?.url === url && failedProbe.type === type

  // Repository identity is derived from the same draft used to render the inputs.
  // A probe only supplies metadata for that identity.
  useEffect(() => {
    if (!url || !type || resolution) {
      setResolving(false)
      return
    }
    let current = true
    setResolving(true)
    setFailedProbe(null)

    const resolve = async () => {
      try {
        const result = await codeWikiApi.resolve(type, url)
        if (current && result) {
          onChange(draft => ({ ...draft, probe: { url, type, result } }))
        }
      } catch {
        if (current) setFailedProbe({ url, type })
      } finally {
        if (current) setResolving(false)
      }
    }

    // Debounce typed input to limit requests to unauthenticated providers.
    const timer = mode === 'url' ? setTimeout(() => void resolve(), 600) : null
    if (timer === null) void resolve()
    return () => {
      current = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [mode, onChange, probeAttempt, resolution, type, url])

  return (
    <>
      <SimpleConfigRow
        label={
          <>
            {t('codeWiki.create.repository')} <span className="text-red-400">*</span>
          </>
        }
        align="start"
      >
        <div className="space-y-2">
          <div className="flex gap-4 text-xs">
            {(['select', 'url'] as const).map(option => (
              <label key={option} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  checked={mode === option}
                  onChange={() => onChange(draft => ({ ...draft, mode: option }))}
                  data-testid={`code-wiki-source-mode-${option}`}
                />
                <span className={mode === option ? 'text-text-primary' : 'text-text-muted'}>
                  {option === 'select'
                    ? t('codeWiki.create.fromMyRepositories')
                    : t('codeWiki.create.byUrl')}
                </span>
              </label>
            ))}
          </div>

          {mode === 'select' ? (
            <RepositorySelector
              selectedRepo={repo}
              handleRepoChange={repo => onChange(draft => ({ ...draft, repo }))}
              disabled={false}
            />
          ) : (
            <div className="space-y-2">
              {inferredType === null && url !== '' && (
                <Select
                  value={urlSourceType}
                  onValueChange={next =>
                    onChange(draft => ({
                      ...draft,
                      urlSourceType: next as CodeWikiSourceType,
                    }))
                  }
                >
                  <SelectTrigger className="bg-base" data-testid="code-wiki-source-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_TYPES.map(type => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                value={urlInput}
                onChange={event => {
                  const urlInput = event.target.value
                  onChange(draft => ({ ...draft, urlInput }))
                }}
                placeholder="https://github.com/owner/repo"
                data-testid="code-wiki-source-url"
              />
            </div>
          )}

          {url && !type ? (
            <p role="alert" className="text-sm text-error">
              {t('codeWiki.create.unsupportedRepositoryProvider')}
            </p>
          ) : (
            <SourceStatus resolving={resolving} resolution={resolution} />
          )}
          {probeFailed && (
            <p role="alert" className="text-sm text-error">
              {t('codeWiki.create.repositoryProbeFailed')}
            </p>
          )}
          {(probeFailed || resolution?.exists === false) && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              data-testid="code-wiki-source-retry"
              onClick={() => {
                onChange(draft => ({ ...draft, probe: null }))
                setProbeAttempt(attempt => attempt + 1)
              }}
            >
              {t('common:actions.retry')}
            </Button>
          )}
        </div>
      </SimpleConfigRow>

      <SimpleConfigRow label={t('codeWiki.create.language')}>
        <Select
          value={value.language}
          onValueChange={language => onChange(current => ({ ...current, language }))}
        >
          <SelectTrigger className="bg-base" data-testid="code-wiki-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh">{t('codeWiki.create.languageZh')}</SelectItem>
            <SelectItem value="en">{t('codeWiki.create.languageEn')}</SelectItem>
          </SelectContent>
        </Select>
      </SimpleConfigRow>
    </>
  )
}

function SourceStatus({
  resolving,
  resolution,
}: {
  resolving: boolean
  resolution: CodeWikiResolution | null
}) {
  const { t } = useTranslation('knowledge')

  if (resolving) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-text-muted">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t('codeWiki.create.checking')}
      </p>
    )
  }
  if (!resolution) return null

  if (!resolution.exists) {
    return (
      <p
        className="flex items-center gap-1.5 text-xs text-red-400"
        data-testid="code-wiki-source-unreadable"
      >
        <AlertCircle className="w-3 h-3" />
        {t('codeWiki.create.notReadable')}
      </p>
    )
  }

  return (
    <div className="space-y-1" data-testid="code-wiki-source-readable">
      <p className="flex items-center gap-1.5 text-xs text-text-muted">
        <CheckCircle2 className="w-3 h-3 text-green-500" />
        {resolution.visibility === 'public'
          ? t('codeWiki.create.publicRepository')
          : t('codeWiki.create.privateRepository')}
        {resolution.default_branch ? ` · ${resolution.default_branch}` : ''}
      </p>
      {resolution.existing_wikis.length > 0 && (
        <div className="space-y-1" data-testid="code-wiki-existing">
          <p className="flex items-center gap-1.5 text-xs text-amber-500">
            <Users className="w-3 h-3" />
            {t('codeWiki.create.alreadyBuilt', {
              count: resolution.existing_wikis.length,
            })}
          </p>
          {/* Named, not counted: asking for a share needs somebody to ask. One the
              caller can already open is a link instead — there is nothing to ask
              for. */}
          <ul className="pl-4 space-y-0.5">
            {resolution.existing_wikis.map(wiki => (
              <li key={wiki.id} className="text-xs text-text-muted">
                {wiki.accessible ? (
                  <a
                    href={`/knowledge/document/${wiki.id}`}
                    className="text-primary hover:underline"
                    data-testid={`code-wiki-existing-open-${wiki.id}`}
                  >
                    {wiki.name}
                  </a>
                ) : (
                  <span data-testid={`code-wiki-existing-owner-${wiki.id}`}>
                    {wiki.name}
                    {wiki.owner_name
                      ? ` — ${t('codeWiki.create.ownedBy', {
                          owner: wiki.owner_name,
                        })}`
                      : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
