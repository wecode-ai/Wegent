// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ChatArea } from '@/features/tasks/components/chat'
import { useTeamContext } from '@/contexts/TeamContext'
import { useTranslation } from '@/hooks/useTranslation'
import { codeWikiApi } from '@/apis/code-wiki'
import { useCodeWikiRunStatus } from './useCodeWikiRunStatus'
import type { CodeWikiPageNode, CodeWikiRunStatus, CodeWikiSummary } from '@/types/code-wiki'
import { PageOutline } from './PageOutline'
import { WikiNavigation } from './WikiNavigation'
import { WikiPageContent } from './WikiPageContent'

interface CodeWikiReaderProps {
  wiki: CodeWikiSummary
}

/** Depth-first, so "the first page" means the first one the reader would see. */
const firstReadable = (nodes: CodeWikiPageNode[]): CodeWikiPageNode | null => {
  for (const node of nodes) {
    if (node.has_content) return node
    const child = firstReadable(node.children)
    if (child) return child
  }
  return null
}

const findByPath = (nodes: CodeWikiPageNode[], path: string): CodeWikiPageNode | null => {
  for (const node of nodes) {
    if (node.path === path) return node
    const found = findByPath(node.children, path)
    if (found) return found
  }
  return null
}

/**
 * Three regions: the wiki's structure, the page, and the page's own outline.
 *
 * The middle switches between reading and a conversation rather than splitting.
 * They never need to be visible at once — asking something replaces the page with
 * the exchange, and going back returns to the page still scrolled where it was,
 * which is what opening the conversation on its own route would lose.
 */

/**
 * What the regenerate control should say and whether it may be used.
 *
 * Four states, not two. It used to be disabled only while its own request was in
 * flight, so reloading the page during a run made a busy wiki look idle and the next
 * click came back as an unexplained conflict. A stale run is deliberately actionable:
 * the server reclaims it before starting the next one, so reporting the wiki as busy
 * would leave the reader waiting for a worker that is already gone.
 */
export function regenerateControl(
  status: CodeWikiRunStatus | null,
  submitting: boolean,
  t: (key: string) => string
): { label: string; disabled: boolean; busy: boolean; hint: string } {
  if (submitting) {
    return {
      label: t('knowledge:codeWiki.reader.regenerating'),
      disabled: true,
      busy: true,
      hint: '',
    }
  }
  if (status?.status === 'running' && !status.is_stale) {
    return {
      label: t('knowledge:codeWiki.reader.generating'),
      disabled: true,
      busy: true,
      hint: '',
    }
  }
  if (status?.status === 'running' && status.is_stale) {
    return {
      label: t('knowledge:codeWiki.reader.regenerate'),
      disabled: false,
      busy: false,
      hint: t('knowledge:codeWiki.reader.previousRunStalled'),
    }
  }
  return {
    label: t('knowledge:codeWiki.reader.regenerate'),
    disabled: false,
    busy: false,
    hint: status?.status === 'failed' ? status.error_message : '',
  }
}

export function CodeWikiReader({ wiki }: CodeWikiReaderProps) {
  const { t } = useTranslation()
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  const [pages, setPages] = useState<CodeWikiPageNode[]>([])
  const [loading, setLoading] = useState(true)
  const [activePath, setActivePath] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [mode, setMode] = useState<'read' | 'chat'>('read')
  const [regenerating, setRegenerating] = useState(false)
  const [scrollHost, setScrollHost] = useState<HTMLElement | null>(null)
  const runStatus = useCodeWikiRunStatus(wiki.id)
  const control = regenerateControl(runStatus.status, regenerating, t)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    codeWikiApi
      .pages(wiki.id)
      .then(response => {
        if (cancelled) return
        setPages(response.pages)
        const first = firstReadable(response.pages)
        if (first) setActivePath(first.path)
      })
      .catch(error => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [wiki.id])

  const activePage = useMemo(
    () => (activePath ? findByPath(pages, activePath) : null),
    [pages, activePath]
  )

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true)
    try {
      const result = await codeWikiApi.regenerate(wiki.id)
      runStatus.refresh()
      // "Nothing to do" is the answer the caller asked for, not a failure: the
      // repository has not moved since the published version.
      toast.success(
        result.started
          ? t('knowledge:codeWiki.reader.started')
          : t('knowledge:codeWiki.reader.upToDate')
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRegenerating(false)
    }
  }, [wiki.id, t, runStatus])

  const knowledgeTeams = useMemo(
    () => teams.filter(team => team.bind_mode?.includes('chat') ?? true),
    [teams]
  )

  if (loading) {
    return (
      <div className="flex flex-1 justify-center py-16">
        <Spinner />
      </div>
    )
  }

  if (pages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
        <p className="text-text-secondary">{t('knowledge:codeWiki.reader.empty')}</p>
        <p className="text-sm text-text-tertiary">{t('knowledge:codeWiki.reader.emptyHint')}</p>
        <Button
          variant="primary"
          onClick={handleRegenerate}
          disabled={control.disabled}
          data-testid="code-wiki-regenerate-empty"
        >
          <RefreshCw className={`mr-1.5 h-4 w-4 ${control.busy ? 'animate-spin' : ''}`} />
          {control.label}
        </Button>
        {control.hint && (
          <p className="text-xs text-amber-500" data-testid="code-wiki-run-hint">
            {control.hint}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1" data-testid="code-wiki-reader">
      <div className="hidden lg:flex">
        <WikiNavigation
          pages={pages}
          activePath={activePath}
          onSelect={node => {
            setActivePath(node.path)
            setMode('read')
          }}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-6 py-3">
          {mode === 'chat' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode('read')}
              data-testid="code-wiki-chat-back"
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              {t('knowledge:codeWiki.reader.back')}
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
            {activePage?.title ?? wiki.name}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRegenerate}
            disabled={control.disabled}
            title={control.hint || undefined}
            data-testid="code-wiki-regenerate"
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${control.busy ? 'animate-spin' : ''}`} />
            {control.label}
          </Button>
        </header>

        {mode === 'read' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div ref={setScrollHost} className="min-h-0 flex-1 overflow-auto px-6 py-6">
              <WikiPageContent page={activePage} onContentChange={setMarkdown} />
            </div>
            <button
              type="button"
              onClick={() => setMode('chat')}
              data-testid="code-wiki-ask"
              className="mx-6 mb-6 rounded-lg border border-border bg-surface px-4 py-3 text-left text-sm text-text-tertiary hover:border-primary/40"
            >
              {t('knowledge:codeWiki.reader.askPlaceholder')}
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="code-wiki-chat">
            <ChatArea
              teams={knowledgeTeams}
              isTeamsLoading={isTeamsLoading}
              showRepositorySelector={false}
              taskType="knowledge"
              knowledgeBaseId={wiki.id}
              onRefreshTeams={refreshTeams}
              inputAlwaysAtBottom={true}
              initialKnowledgeBase={{
                id: wiki.id,
                name: wiki.name,
                namespace: 'default',
                document_count: wiki.document_count,
              }}
            />
          </div>
        )}
      </div>

      {mode === 'read' && <PageOutline content={markdown} scrollContainer={scrollHost} />}
    </div>
  )
}
