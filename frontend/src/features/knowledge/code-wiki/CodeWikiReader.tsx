// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, PanelLeft, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Spinner } from '@/components/ui/spinner'
import { ChatArea } from '@/features/tasks/components/chat'
import { useTeamContext } from '@/contexts/TeamContext'
import { useTranslation } from '@/hooks/useTranslation'
import { getFirstSearchParam } from '@/lib/search-params'
import { codeWikiApi } from '@/apis/code-wiki'
import { knowledgeCapableTeams } from '@/features/knowledge/document/utils/knowledgeTeams'
import { useCodeWikiRunStatus } from './useCodeWikiRunStatus'
import type { CodeWikiPageNode, CodeWikiRunStatus } from '@/types/code-wiki'
import type { KnowledgeBase } from '@/types/knowledge'
import { PageOutline } from './PageOutline'
import { RunHistory } from './RunHistory'
import { failureText } from './failureText'
import { WikiNavigation } from './WikiNavigation'
import { WikiPageContent } from './WikiPageContent'

interface CodeWikiReaderProps {
  /** The code wiki being read, as the knowledge page already resolved it. */
  wiki: KnowledgeBase
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

/** Paths a link can actually reach: pages with a body of their own. */
const collectPaths = (nodes: CodeWikiPageNode[], into = new Set<string>()): Set<string> => {
  for (const node of nodes) {
    if (node.has_content) into.add(node.path)
    collectPaths(node.children, into)
  }
  return into
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
      label: t('codeWiki.reader.regenerating'),
      disabled: true,
      busy: true,
      hint: '',
    }
  }
  if (status?.status === 'running' && !status.is_stale) {
    return {
      label: t('codeWiki.reader.generating'),
      disabled: true,
      busy: true,
      hint: '',
    }
  }
  if (status?.status === 'running' && status.is_stale) {
    return {
      label: t('codeWiki.reader.regenerate'),
      disabled: false,
      busy: false,
      hint: t('codeWiki.reader.previousRunStalled'),
    }
  }
  return {
    label: t('codeWiki.reader.regenerate'),
    disabled: false,
    busy: false,
    hint:
      status?.status === 'failed' ? failureText(status.failure_code, status.error_message, t) : '',
  }
}

export function CodeWikiReader({ wiki }: CodeWikiReaderProps) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()
  const searchParams = useSearchParams()
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  const [pages, setPages] = useState<CodeWikiPageNode[]>([])
  const [loading, setLoading] = useState(true)
  const [activePath, setActivePath] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [scrollHost, setScrollHost] = useState<HTMLElement | null>(null)
  // Whether the chat is still showing its empty state, reported by the page body as
  // it mounts and unmounts inside it. The chat replaces that state with the
  // conversation without telling anyone, so this is the only signal it gives.
  //
  // Seeded from the URL because that signal never arrives when a conversation is
  // already open on arrival: the empty state is not rendered, so the body never
  // mounts and never reports. Landing on ?taskId — which is how the conversation
  // list reopens a task — left this saying the chat was empty, and the page could
  // then never be laid over it.
  const [chatIsEmpty, setChatIsEmpty] = useState(
    () => !getFirstSearchParam(searchParams, ['taskId', 'task_id', 'taskid'])
  )
  // Set when the reader asks for the page back while a conversation exists. The chat
  // stays mounted underneath: hiding it costs nothing and keeps the exchange, where
  // remounting it to reach its empty state discarded the conversation, reloaded the
  // task from the URL it is read from, and flashed the whole page on the way.
  const [showDocument, setShowDocument] = useState(false)
  // Only used below lg, where the page tree is a drawer rather than a column.
  // Controlled so that picking a page closes it: leaving it open would cover the
  // page it was just asked to show.
  const [navigationOpen, setNavigationOpen] = useState(false)
  const projectName = String(
    (wiki.source as { projectName?: string } | undefined)?.projectName ?? ''
  )
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

  // Which links in a page have somewhere to go. Only pages with content count: a
  // section that holds pages but has none of its own cannot be opened, so a link to
  // it should read as broken rather than open a blank page.
  const knownPaths = useMemo(() => collectPaths(pages), [pages])

  // Whether the page is being laid over the chat. One condition, used by both the
  // hiding and the rendering: they were written separately and disagreed, so asking
  // for the page while no conversation existed hid the chat -- and with it the page,
  // which the chat was the one rendering -- while the overlay declined to appear.
  const overlayDocument = showDocument && !chatIsEmpty

  const openPage = useCallback((path: string) => {
    setActivePath(path)
    // Picking a page is a request to read it, so it works during a conversation too:
    // the navigation stays on screen there, and a click that silently did nothing
    // would be worse than not offering it.
    setShowDocument(true)
  }, [])

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true)
    try {
      const result = await codeWikiApi.regenerate(wiki.id)
      runStatus.refresh()
      // "Nothing to do" is the answer the caller asked for, not a failure: the
      // repository has not moved since the published version.
      toast.success(result.started ? t('codeWiki.reader.started') : t('codeWiki.reader.upToDate'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRegenerating(false)
    }
  }, [wiki.id, t, runStatus])

  const knowledgeTeams = useMemo(() => knowledgeCapableTeams(teams), [teams])

  if (loading) {
    return (
      <div className="flex flex-1 justify-center py-16">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="code-wiki-reader">
      {/* Regenerating rebuilds the whole wiki, so the control belongs to the wiki
          rather than to whichever page happens to be open. Sat in the page header it
          read as "regenerate this page". */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        {pages.length > 0 && (
          <Drawer open={navigationOpen} onOpenChange={setNavigationOpen}>
            <DrawerTrigger asChild>
              <button
                type="button"
                aria-label={t('codeWiki.reader.openNavigation')}
                data-testid="code-wiki-open-navigation"
                className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover lg:hidden"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            </DrawerTrigger>
            <DrawerContent className="max-h-[80vh]" data-testid="code-wiki-navigation-drawer">
              <DrawerTitle className="px-4 pt-2 text-sm font-medium">
                {t('codeWiki.reader.openNavigation')}
              </DrawerTitle>
              <div className="min-h-0 overflow-y-auto px-2 pb-4">
                {/* Both halves of the left column, because that is what this drawer
                    stands in for. With only the tree here, a narrow screen could
                    reach the run history exactly when the wiki had no pages -- so on
                    a wiki that had been generated, whether the last run failed and
                    which version is live were unreachable, and so was restoring one. */}
                <div className="border-b border-border px-1 pb-3">
                  <RunHistory knowledgeBaseId={wiki.id} status={runStatus.status} />
                </div>
                <WikiNavigation
                  pages={pages}
                  activePath={activePath}
                  onSelect={node => {
                    openPage(node.path)
                    setNavigationOpen(false)
                  }}
                />
              </div>
            </DrawerContent>
          </Drawer>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/knowledge?type=code')}
          data-testid="code-wiki-back-to-list"
          className="h-11 sm:h-9"
        >
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          {projectName || wiki.name}
        </Button>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={handleRegenerate}
          disabled={control.disabled}
          title={control.hint || undefined}
          data-testid="code-wiki-regenerate"
          className="h-11 sm:h-9"
        >
          <RefreshCw className={`mr-1.5 h-4 w-4 ${control.busy ? 'animate-spin' : ''}`} />
          {control.label}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The left column carries what is true of the wiki: when it last changed,
            and what it contains. Both stay put while the middle column changes.

            Below lg it is a drawer instead of a column. Hiding it outright left a
            narrow screen with no way between pages at all -- the wiki opened on
            whichever page came first and stayed there. */}
        <div className="hidden w-64 shrink-0 flex-col border-r border-border lg:flex">
          <div className="border-b border-border px-3 py-2">
            <RunHistory knowledgeBaseId={wiki.id} status={runStatus.status} />
          </div>
          {pages.length > 0 && (
            <WikiNavigation
              pages={pages}
              activePath={activePath}
              onSelect={node => openPage(node.path)}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {pages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
              <p className="text-text-secondary">{t('codeWiki.reader.empty')}</p>
              <p className="text-sm text-text-tertiary">{t('codeWiki.reader.emptyHint')}</p>
              {control.hint && (
                <p
                  className="max-w-lg text-center text-xs text-amber-500"
                  data-testid="code-wiki-run-hint"
                >
                  {control.hint}
                </p>
              )}
              {/* On narrow screens the left column is hidden, so this is the only way
                  to the history -- and a wiki with no pages is exactly when it is
                  wanted. */}
              <div className="lg:hidden">
                <RunHistory knowledgeBaseId={wiki.id} status={runStatus.status} />
              </div>
            </div>
          ) : (
            /* The document is the chat's empty state, not a separate mode. Reading a
               page and starting a conversation about it are the same screen: the real
               input sits at the bottom while the page is open, and sending replaces
               the page with the exchange. It used to be a fake input that swapped the
               whole column on click, which meant leaving the document to see the box
               you were meant to type in. */
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* The chat is never unmounted. While a conversation is open the page
                  is laid over it, so going back costs a repaint rather than losing
                  the exchange and reloading the task from the URL. */}
              <div
                data-testid="code-wiki-chat-pane"
                className={`flex min-h-0 flex-1 flex-col ${overlayDocument ? 'hidden' : ''}`}
              >
                {!chatIsEmpty && (
                  <div className="flex items-center gap-2 border-b border-border px-6 py-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowDocument(true)}
                      data-testid="code-wiki-back-to-document"
                    >
                      <ArrowLeft className="mr-1.5 h-4 w-4" />
                      {t('codeWiki.reader.back')}
                    </Button>
                  </div>
                )}
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
                    namespace: wiki.namespace,
                    document_count: wiki.document_count,
                  }}
                  emptyStateContent={
                    <WikiPageBody
                      page={activePage}
                      title={activePage?.title ?? wiki.name}
                      onContentChange={setMarkdown}
                      knownPaths={knownPaths}
                      onNavigate={openPage}
                      onScrollHostChange={setScrollHost}
                      onEmptyStateChange={setChatIsEmpty}
                    />
                  }
                />
              </div>

              {overlayDocument && (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex items-center gap-2 border-b border-border px-6 py-3">
                    <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
                      {activePage?.title ?? wiki.name}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowDocument(false)}
                      data-testid="code-wiki-back-to-chat"
                    >
                      {t('codeWiki.reader.backToChat')}
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
                    <WikiPageBody
                      page={activePage}
                      title=""
                      onContentChange={setMarkdown}
                      knownPaths={knownPaths}
                      onNavigate={openPage}
                      onScrollHostChange={setScrollHost}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {pages.length > 0 && (chatIsEmpty || overlayDocument) && (
          <PageOutline content={markdown} scrollContainer={scrollHost} />
        )}
      </div>
    </div>
  )
}

interface WikiPageBodyProps {
  page: CodeWikiPageNode | null
  title: string
  onContentChange: (markdown: string) => void
  knownPaths: ReadonlySet<string>
  onNavigate: (path: string) => void
  onScrollHostChange: (host: HTMLElement | null) => void
  /**
   * Whether the chat is still showing its empty state. Passed only by the instance
   * the chat renders — the overlay copy must not answer for the chat, which is
   * exactly what it would be reporting.
   */
  onEmptyStateChange?: (empty: boolean) => void
}

/**
 * A page, rendered inside the chat's empty state.
 *
 * Reports the element it was mounted into, which is the one that scrolls: the
 * outline rail lives outside the chat so it stays put, but it has to watch the
 * scroller that actually holds the headings. React calls the ref with null when this
 * unmounts — when a conversation starts and the empty state goes away — so the rail
 * loses its container and hides itself rather than pointing at a detached element.
 */
function WikiPageBody({
  page,
  title,
  onContentChange,
  knownPaths,
  onNavigate,
  onScrollHostChange,
  onEmptyStateChange,
}: WikiPageBodyProps) {
  return (
    <div
      className="w-full"
      ref={element => {
        onScrollHostChange(element ? element.parentElement : null)
        onEmptyStateChange?.(Boolean(element))
      }}
    >
      <div className="mb-4 border-b border-border pb-3">
        <span className="font-medium text-text-primary">{title}</span>
      </div>
      <WikiPageContent
        page={page}
        onContentChange={onContentChange}
        knownPaths={knownPaths}
        onNavigate={onNavigate}
      />
    </div>
  )
}
