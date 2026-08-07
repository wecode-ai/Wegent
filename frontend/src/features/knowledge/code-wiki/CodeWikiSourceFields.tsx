// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Users } from 'lucide-react'
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
import { buildKbUrl } from '@/utils/knowledgeUrl'
import { codeWikiApi } from '@/apis/code-wiki'
import { useUser } from '@/features/common/UserContext'
import type { GitInfo, GitRepoInfo } from '@/types/api'
import type { CodeWikiResolution, CodeWikiSourceType } from '@/types/code-wiki'

export interface CodeWikiSource {
  source_type: CodeWikiSourceType
  source_url: string
  language: string
  /** Whether generation runs appear in the conversation list. Off unless asked for. */
  show_generation_task: boolean
  /** Set once resolved; the parent uses it to know the form is usable. */
  resolution: CodeWikiResolution | null
}

interface CodeWikiSourceFieldsProps {
  value: CodeWikiSource
  onChange: (next: CodeWikiSource) => void
}

const SOURCE_TYPES: CodeWikiSourceType[] = ['github', 'gitlab', 'gitea']

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
export function CodeWikiSourceFields({ value, onChange }: CodeWikiSourceFieldsProps) {
  const { t } = useTranslation('knowledge')
  const { user } = useUser()
  const configuredGitInfo = useMemo(() => user?.git_info ?? [], [user])
  const [mode, setMode] = useState<'select' | 'url'>('select')
  const [repo, setRepo] = useState<GitRepoInfo | null>(null)
  const [urlDraft, setUrlDraft] = useState('')
  const [resolving, setResolving] = useState(false)

  const resolution = value.resolution

  const resolve = useCallback(
    async (sourceType: CodeWikiSourceType, url: string) => {
      if (!url) {
        onChange({ ...value, source_url: '', resolution: null })
        return
      }
      setResolving(true)
      try {
        const resolved = await codeWikiApi.resolve(sourceType, url)
        onChange({
          ...value,
          source_type: sourceType,
          source_url: url,
          resolution: resolved,
        })
      } catch {
        // A failed probe is not a failed form: the caller may still submit, and the
        // create call applies the same check authoritatively.
        onChange({ ...value, source_type: sourceType, source_url: url, resolution: null })
      } finally {
        setResolving(false)
      }
    },
    [onChange, value]
  )

  const handleRepoChange = useCallback(
    (next: GitRepoInfo | null) => {
      setRepo(next)
      if (!next) {
        onChange({ ...value, source_url: '', resolution: null })
        return
      }
      const sourceType = (next.type as CodeWikiSourceType) ?? 'github'
      void resolve(sourceType, next.git_url)
    },
    [onChange, resolve, value]
  )

  // Debounced so that typing a URL costs one probe rather than one per keystroke —
  // anonymous GitHub requests are capped at 60 an hour per address.
  useEffect(() => {
    if (mode !== 'url') return
    const inferred = inferSourceType(urlDraft, configuredGitInfo)
    const timer = setTimeout(() => {
      void resolve(inferred ?? value.source_type, urlDraft.trim())
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDraft, mode, configuredGitInfo])

  const inferred = useMemo(
    () => inferSourceType(urlDraft, configuredGitInfo),
    [urlDraft, configuredGitInfo]
  )

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
                  onChange={() => setMode(option)}
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
              handleRepoChange={handleRepoChange}
              disabled={false}
            />
          ) : (
            <div className="space-y-2">
              {inferred === null && urlDraft.trim() !== '' && (
                <Select
                  value={value.source_type}
                  onValueChange={next =>
                    onChange({ ...value, source_type: next as CodeWikiSourceType })
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
                value={urlDraft}
                onChange={e => setUrlDraft(e.target.value)}
                placeholder="https://github.com/owner/repo"
                data-testid="code-wiki-source-url"
              />
            </div>
          )}

          <SourceStatus resolving={resolving} resolution={resolution} />
        </div>
      </SimpleConfigRow>

      <SimpleConfigRow label={t('codeWiki.create.language')}>
        <Select value={value.language} onValueChange={language => onChange({ ...value, language })}>
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
                    href={buildKbUrl('default', wiki.name, false)}
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
