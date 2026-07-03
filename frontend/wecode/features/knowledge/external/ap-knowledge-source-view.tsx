// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Cloud,
  FileText,
  Folder,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { registerKnowledgeSourceView } from '@/features/knowledge/knowledgeSourceViewRegistry'
import {
  type ExternalKnowledgePaginationSource,
  listAllExternalKnowledgeBases,
  listAllExternalNodes,
} from '@/features/knowledge/externalKnowledgePagination'
import {
  listExternalKnowledgeBases,
  listExternalKnowledgeNodes,
} from '@wecode/api/external-knowledge'
import type {
  ExternalKbNode,
  ExternalKnowledgeBase,
  ExternalKnowledgePreview,
} from '@wecode/types/external-knowledge'
import {
  ApReadonlyBadge,
  EmployeeRequiredCard,
  ExternalKnowledgeWarning,
  EmptyState,
} from './components/ExternalKnowledgeShared'
import { ExternalKnowledgePreviewDialog } from './components/ExternalKnowledgePreviewDialog'
import {
  getExternalKnowledgeBaseCount,
  isDocumentNode,
  isFolderNode,
  isMissingEmployeeError,
  resolveExternalNodePreview,
} from './utils'

const AP_PROVIDER = 'ap'
const DEFAULT_EXPANDED_TREE_LEVELS = 1
const apKnowledgePaginationSource: ExternalKnowledgePaginationSource = {
  listKnowledgeBases: params => listExternalKnowledgeBases(AP_PROVIDER, params),
  listNodes: (knowledgeBaseId, params) =>
    listExternalKnowledgeNodes(AP_PROVIDER, knowledgeBaseId, params),
}
type ApScopeTab = 'personal' | 'organization'

interface ApKnowledgeSourceLayoutProps {
  activeTab: ApScopeTab
  setActiveTab: (tab: ApScopeTab) => void
  items: ExternalKnowledgeBase[]
  loading: boolean
  error: unknown
  personalItems: ExternalKnowledgeBase[]
  organizationItems: ExternalKnowledgeBase[]
  personalDocumentCount: number
  organizationDocumentCount: number
  previewLoadingNodeId: string | null
  loadKnowledgeBases: () => void
  openNode: (knowledgeBase: ExternalKnowledgeBase, node: ExternalKbNode) => void
}

export function ApKnowledgeSourceView() {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<ApScopeTab>('personal')
  const [items, setItems] = useState<ExternalKnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [preview, setPreview] = useState<ExternalKnowledgePreview | null>(null)
  const [previewTitle, setPreviewTitle] = useState('')
  const [previewLoadingNodeId, setPreviewLoadingNodeId] = useState<string | null>(null)

  const loadKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const knowledgeBases = await listAllExternalKnowledgeBases(apKnowledgePaginationSource, {
        scope: 'all',
      })
      setItems(knowledgeBases)
    } catch (nextError) {
      setError(nextError)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadKnowledgeBases()
  }, [loadKnowledgeBases])

  const personalItems = useMemo(() => items.filter(item => item.scope === 'personal'), [items])
  const organizationItems = useMemo(
    () => items.filter(item => item.scope === 'organization'),
    [items]
  )
  const personalDocumentCount = useMemo(() => sumDocumentCount(personalItems), [personalItems])
  const organizationDocumentCount = useMemo(
    () => sumDocumentCount(organizationItems),
    [organizationItems]
  )

  const openNode = useCallback(
    async (knowledgeBase: ExternalKnowledgeBase, node: ExternalKbNode) => {
      if (!isDocumentNode(node)) return

      if (node.previewable === false) {
        toast({ title: t('external.preview.unsupported') })
        return
      }

      setPreviewLoadingNodeId(node.node_id)
      try {
        const resolvedPreview = await resolveExternalNodePreview(AP_PROVIDER, knowledgeBase, node)

        if (resolvedPreview.preview_mode === 'new_tab') {
          window.open(resolvedPreview.url, '_blank', 'noopener,noreferrer')
          return
        }

        setPreviewTitle(node.name)
        setPreview(resolvedPreview)
      } catch {
        toast({ title: t('external.preview.failed'), variant: 'destructive' })
      } finally {
        setPreviewLoadingNodeId(null)
      }
    },
    [t, toast]
  )

  const layoutProps: ApKnowledgeSourceLayoutProps = {
    activeTab,
    setActiveTab,
    items,
    loading,
    error,
    personalItems,
    organizationItems,
    personalDocumentCount,
    organizationDocumentCount,
    previewLoadingNodeId,
    loadKnowledgeBases,
    openNode,
  }

  return (
    <>
      <ApKnowledgeSourceDesktopView {...layoutProps} />

      <ExternalKnowledgePreviewDialog
        open={Boolean(preview)}
        onOpenChange={open => {
          if (!open) setPreview(null)
        }}
        preview={preview}
        title={previewTitle || t('external.preview.title')}
        testId="external-knowledge-preview-dialog"
        iframeTestId="external-knowledge-preview-iframe"
      />
    </>
  )
}

function ApKnowledgeSourceDesktopView({
  activeTab,
  setActiveTab,
  loading,
  error,
  personalItems,
  organizationItems,
  personalDocumentCount,
  organizationDocumentCount,
  previewLoadingNodeId,
  loadKnowledgeBases,
  openNode,
}: ApKnowledgeSourceLayoutProps) {
  const { t } = useTranslation('knowledge')

  return (
    <div className="flex h-full min-h-0 flex-col bg-base" data-testid="ap-knowledge-source-view">
      <ApKnowledgeHeader
        loading={loading}
        onRefresh={loadKnowledgeBases}
        testId="ap-knowledge-refresh-button"
      />

      <Tabs
        value={activeTab}
        onValueChange={value => setActiveTab(value as ApScopeTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <ApScopeTabs
          personalDocumentCount={personalDocumentCount}
          organizationDocumentCount={organizationDocumentCount}
          personalTestId="ap-knowledge-tab-personal"
          organizationTestId="ap-knowledge-tab-organization"
          className="px-6 pt-3"
        />

        {loading ? (
          <ApKnowledgeTreeSkeleton />
        ) : isMissingEmployeeError(error) ? (
          <div className="p-6">
            <EmployeeRequiredCard />
          </div>
        ) : error ? (
          <div className="p-6">
            <ExternalKnowledgeWarning
              message={error instanceof Error ? error.message : undefined}
              onRetry={loadKnowledgeBases}
            />
          </div>
        ) : (
          <>
            <TabsContent value="personal" className="mt-3 min-h-0 flex-1 overflow-y-auto">
              <ApKnowledgeTree
                knowledgeBases={personalItems}
                emptyTitle={t('external.status.emptyPersonal')}
                previewLoadingNodeId={previewLoadingNodeId}
                onOpenNode={openNode}
              />
            </TabsContent>
            <TabsContent value="organization" className="mt-3 min-h-0 flex-1 overflow-y-auto">
              <ApKnowledgeTree
                knowledgeBases={organizationItems}
                emptyTitle={t('external.status.emptyOrganization')}
                previewLoadingNodeId={previewLoadingNodeId}
                onOpenNode={openNode}
              />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  )
}

function ApKnowledgeHeader({
  loading,
  onRefresh,
  testId,
}: {
  loading: boolean
  onRefresh: () => void
  testId: string
}) {
  const { t } = useTranslation('knowledge')

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between border-b border-border',
        'px-6 py-4'
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Cloud className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-text-primary">
              {t('external.title')}
            </h2>
            <ApReadonlyBadge />
          </div>
          <p className="mt-1 text-sm text-text-secondary">{t('external.unifiedSubtitle')}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        className="h-11 min-w-[44px] shrink-0 px-3 md:h-10"
        onClick={onRefresh}
        disabled={loading}
        data-testid={testId}
      >
        <RefreshCw className="mr-2 h-4 w-4" />
        <span>{t('external.actions.refresh')}</span>
      </Button>
    </div>
  )
}

function ApScopeTabs({
  personalDocumentCount,
  organizationDocumentCount,
  personalTestId,
  organizationTestId,
  className,
}: {
  personalDocumentCount: number
  organizationDocumentCount: number
  personalTestId: string
  organizationTestId: string
  className?: string
}) {
  const { t } = useTranslation('knowledge')

  return (
    <div className={cn('flex shrink-0', className)}>
      <TabsList className="min-h-11 self-start rounded-md">
        <TabsTrigger value="personal" className="min-h-9" data-testid={personalTestId}>
          <Folder className="mr-1.5 h-3.5 w-3.5" />
          {t('external.scope.personal')}
          {personalDocumentCount > 0 ? (
            <span className="ml-1.5 text-xs text-text-muted">({personalDocumentCount})</span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="organization" className="min-h-9" data-testid={organizationTestId}>
          <BookOpen className="mr-1.5 h-3.5 w-3.5" />
          {t('external.scope.organization')}
          {organizationDocumentCount > 0 ? (
            <span className="ml-1.5 text-xs text-text-muted">({organizationDocumentCount})</span>
          ) : null}
        </TabsTrigger>
      </TabsList>
    </div>
  )
}

function ApKnowledgeTree({
  knowledgeBases,
  emptyTitle,
  previewLoadingNodeId,
  onOpenNode,
}: {
  knowledgeBases: ExternalKnowledgeBase[]
  emptyTitle: string
  previewLoadingNodeId: string | null
  onOpenNode: (knowledgeBase: ExternalKnowledgeBase, node: ExternalKbNode) => void
}) {
  if (knowledgeBases.length === 0) {
    return <ApKnowledgeEmpty title={emptyTitle} />
  }

  return (
    <div className="space-y-0.5 p-2" data-testid="ap-knowledge-tree-view">
      {knowledgeBases.map((knowledgeBase, index) => (
        <ApKnowledgeBaseTreeRoot
          key={knowledgeBase.knowledge_base_id}
          knowledgeBase={knowledgeBase}
          defaultExpanded={index === 0}
          previewLoadingNodeId={previewLoadingNodeId}
          onOpenNode={onOpenNode}
        />
      ))}
    </div>
  )
}

function ApKnowledgeBaseTreeRoot({
  knowledgeBase,
  defaultExpanded,
  previewLoadingNodeId,
  onOpenNode,
}: {
  knowledgeBase: ExternalKnowledgeBase
  defaultExpanded: boolean
  previewLoadingNodeId: string | null
  onOpenNode: (knowledgeBase: ExternalKnowledgeBase, node: ExternalKbNode) => void
}) {
  const { t } = useTranslation('knowledge')
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [nodes, setNodes] = useState<ExternalKbNode[]>([])
  const [loading, setLoading] = useState(defaultExpanded)
  const [error, setError] = useState<unknown>(null)
  const [loaded, setLoaded] = useState(false)

  const loadNodes = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const items = await listAllExternalNodes(
        apKnowledgePaginationSource,
        knowledgeBase.knowledge_base_id
      )
      setNodes(items)
      setLoaded(true)
    } catch (nextError) {
      setError(nextError)
      setNodes([])
    } finally {
      setLoading(false)
    }
  }, [knowledgeBase.knowledge_base_id])

  useEffect(() => {
    if (expanded && !loaded && !error) {
      loadNodes()
    }
  }, [error, expanded, loadNodes, loaded])

  const toggleExpanded = () => {
    setExpanded(prev => !prev)
  }

  return (
    <div data-testid={`ap-knowledge-tree-root-${knowledgeBase.knowledge_base_id}`}>
      <button
        type="button"
        onClick={toggleExpanded}
        className={cn(
          'group flex min-h-[44px] w-full items-center gap-1.5 rounded-md py-2 pr-2 text-sm transition-colors',
          'hover:bg-surface-hover text-text-primary'
        )}
        style={{ paddingLeft: '8px' }}
        aria-expanded={expanded}
        data-testid={`ap-knowledge-root-toggle-${knowledgeBase.knowledge_base_id}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
          )}
        </span>
        <Folder className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">
          {knowledgeBase.knowledge_base_name}
        </span>
        <ApReadonlyBadge />
        <span className="shrink-0 text-xs text-text-muted">
          {knowledgeBase.document_count ?? 0}
        </span>
      </button>

      {expanded ? (
        <div className="mt-0.5">
          {loading ? (
            <div className="space-y-1 pl-9 pr-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="ml-9 flex min-h-[44px] items-center gap-2 rounded-md px-3 text-sm text-text-muted">
              <span className="min-w-0 flex-1 truncate">
                {error instanceof Error ? error.message : t('external.status.unavailable')}
              </span>
              <Button
                type="button"
                variant="ghost"
                className="h-11 min-w-[44px] px-3 md:h-8"
                onClick={loadNodes}
                data-testid={`ap-knowledge-root-retry-${knowledgeBase.knowledge_base_id}`}
              >
                {t('external.actions.retry')}
              </Button>
            </div>
          ) : nodes.length === 0 ? (
            <div className="ml-9 flex min-h-[44px] items-center rounded-md px-3 text-sm text-text-muted">
              {t('external.status.emptyFolder')}
            </div>
          ) : (
            nodes.map(node => (
              <ApKnowledgeTreeNode
                key={node.node_id}
                knowledgeBase={knowledgeBase}
                node={node}
                level={1}
                previewLoadingNodeId={previewLoadingNodeId}
                onOpenNode={onOpenNode}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function ApKnowledgeTreeNode({
  knowledgeBase,
  node,
  level,
  previewLoadingNodeId,
  onOpenNode,
}: {
  knowledgeBase: ExternalKnowledgeBase
  node: ExternalKbNode
  level: number
  previewLoadingNodeId: string | null
  onOpenNode: (knowledgeBase: ExternalKnowledgeBase, node: ExternalKbNode) => void
}) {
  const isFolder = isFolderNode(node)
  const isDocument = isDocumentNode(node)
  const hasChildren = Boolean(isFolder && node.children?.length)
  const [expanded, setExpanded] = useState(level < DEFAULT_EXPANDED_TREE_LEVELS)
  const indentPx = level * 20 + 8

  const handleClick = () => {
    if (isFolder) {
      setExpanded(prev => !prev)
      return
    }
    if (isDocument) {
      onOpenNode(knowledgeBase, node)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          'group block min-h-[44px] w-full rounded-md py-1.5 pr-2 text-left text-sm transition-colors',
          'hover:bg-surface-hover text-text-primary'
        )}
        style={{ paddingLeft: `${indentPx}px` }}
        data-testid={`ap-knowledge-node-${node.node_id}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {hasChildren ? (
              expanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
              )
            ) : null}
          </span>
          {isFolder ? (
            <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-primary" />
          )}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {previewLoadingNodeId === node.node_id ? (
            <Spinner size="sm" className="shrink-0 text-primary" />
          ) : null}
        </div>
      </button>

      {hasChildren && expanded
        ? node.children!.map(child => (
            <ApKnowledgeTreeNode
              key={child.node_id}
              knowledgeBase={knowledgeBase}
              node={child}
              level={level + 1}
              previewLoadingNodeId={previewLoadingNodeId}
              onOpenNode={onOpenNode}
            />
          ))
        : null}
    </div>
  )
}

function ApKnowledgeTreeSkeleton() {
  return (
    <div className="space-y-1 p-2" data-testid="ap-knowledge-skeleton">
      {Array.from({ length: 8 }).map((_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  )
}

function ApKnowledgeEmpty({ title }: { title: string }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center px-4 text-center">
      <EmptyState title={title} testId="ap-knowledge-empty" />
    </div>
  )
}

function sumDocumentCount(items: ExternalKnowledgeBase[]) {
  return items.reduce((total, item) => total + (item.document_count ?? 0), 0)
}

registerKnowledgeSourceView(AP_PROVIDER, {
  id: AP_PROVIDER,
  label: 'WeiboAP',
  icon: <Cloud className="h-4 w-4" />,
  getKnowledgeBaseCount: () => getExternalKnowledgeBaseCount(AP_PROVIDER),
  renderView: () => <ApKnowledgeSourceView />,
})
