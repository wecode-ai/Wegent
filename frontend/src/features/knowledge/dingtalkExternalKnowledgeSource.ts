// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { dingtalkDocApi } from '@/apis/dingtalk-doc'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'
import type {
  ExternalKbNode,
  ExternalKbNodeListParams,
  ExternalKbNodeListResponse,
  ExternalKnowledgeBase,
  ExternalKnowledgeBaseListParams,
  ExternalKnowledgeBaseListResponse,
} from '@/types/external-knowledge'
import { registerExternalKnowledgeSource } from './externalKnowledgeSourceRegistry'

const DINGTALK_PROVIDER_ID = 'dingtalk'
const DINGTALK_DOCS_CONTAINER_ID = 'docs'
const READABLE_CONTENT_TYPES = new Set(['adoc'])
const CONTENT_TYPE_ALIASES: Record<string, string> = { alidoc: 'adoc' }

let registered = false

function countDocuments(nodes: DingtalkDocNode[]): number {
  return nodes.reduce((total, node) => {
    const self = node.node_type === 'folder' ? 0 : 1
    return total + self + countDocuments(node.children ?? [])
  }, 0)
}

function matchesQuery(text: string, query?: string): boolean {
  const normalized = query?.trim().toLowerCase()
  if (!normalized) return true
  return text.toLowerCase().includes(normalized)
}

function paginate<T>(items: T[], limit?: number, offset?: number) {
  const start = Math.max(offset ?? 0, 0)
  const size = limit && limit > 0 ? limit : items.length
  const pageItems = items.slice(start, start + size)
  return {
    items: pageItems,
    total: items.length,
    limit: size,
    offset: start,
    has_more: start + pageItems.length < items.length,
  }
}

function toDocsKnowledgeBase(documentCount: number): ExternalKnowledgeBase {
  return {
    provider: DINGTALK_PROVIDER_ID,
    knowledge_base_id: DINGTALK_DOCS_CONTAINER_ID,
    knowledge_base_name: 'DingTalk Docs',
    scope: 'personal',
    document_count: documentCount,
  }
}

function toWikispaceKnowledgeBase(node: DingtalkDocNode): ExternalKnowledgeBase {
  return {
    provider: DINGTALK_PROVIDER_ID,
    knowledge_base_id: node.workspace_id || node.dingtalk_node_id,
    knowledge_base_name: node.name,
    scope: 'organization',
    document_count: countDocuments(node.children ?? []),
    updated_at: node.updated_at,
  }
}

function toExternalNode(node: DingtalkDocNode): ExternalKbNode {
  const rawContentType = node.content_type.trim().toLowerCase()
  const contentType = CONTENT_TYPE_ALIASES[rawContentType] ?? rawContentType
  const contentReadable = node.node_type === 'folder' || READABLE_CONTENT_TYPES.has(contentType)
  return {
    node_id: node.dingtalk_node_id,
    raw_id: node.dingtalk_node_id,
    name: node.name,
    node_type: node.node_type === 'folder' ? 'folder' : 'document',
    parent_id: node.parent_node_id || null,
    has_children: (node.children ?? []).length > 0,
    children: (node.children ?? []).map(toExternalNode),
    source_type: node.source,
    file_extension: contentType || null,
    content_readable: contentReadable,
    browser_open_url: node.doc_url || null,
  }
}

function findWikispaceRoot(nodes: DingtalkDocNode[], knowledgeBaseId: string) {
  return nodes.find(node => (node.workspace_id || node.dingtalk_node_id) === knowledgeBaseId)
}

async function listDingTalkKnowledgeBases(
  params: ExternalKnowledgeBaseListParams = {}
): Promise<ExternalKnowledgeBaseListResponse> {
  const [docsTree, docsStatus, wikispaceTree, wikispaceStatus] = await Promise.all([
    dingtalkDocApi.getDocs(),
    dingtalkDocApi.getSyncStatus(),
    dingtalkDocApi.getWikispaceNodes(),
    dingtalkDocApi.getWikispaceSyncStatus(),
  ])

  const items: ExternalKnowledgeBase[] = []
  if (
    docsStatus.is_configured &&
    docsTree.nodes.length > 0 &&
    (params.scope === undefined || params.scope === 'all' || params.scope === 'personal')
  ) {
    items.push(toDocsKnowledgeBase(countDocuments(docsTree.nodes)))
  }

  if (
    wikispaceStatus.is_configured &&
    (params.scope === undefined || params.scope === 'all' || params.scope === 'organization')
  ) {
    items.push(...wikispaceTree.nodes.map(toWikispaceKnowledgeBase))
  }

  const filteredItems = items.filter(item =>
    matchesQuery([item.knowledge_base_name, item.description ?? ''].join(' '), params.query)
  )

  return paginate(filteredItems, params.limit, params.offset)
}

async function getDingTalkKnowledgeBaseCount(): Promise<number> {
  const response = await listDingTalkKnowledgeBases()
  return response.total ?? response.items.length
}

async function getDingTalkScopeStatuses() {
  const [docsTree, docsStatus, wikispaceTree, wikispaceStatus] = await Promise.all([
    dingtalkDocApi.getDocs(),
    dingtalkDocApi.getSyncStatus(),
    dingtalkDocApi.getWikispaceNodes(),
    dingtalkDocApi.getWikispaceSyncStatus(),
  ])

  return [
    {
      key: 'personal' as const,
      configured: Boolean(docsStatus.is_configured),
      synced: docsTree.nodes.length > 0,
      lastSyncedAt: docsStatus.last_synced_at,
      messageKey: docsStatus.is_configured
        ? 'chat:dingtalkDocs.empty'
        : 'chat:dingtalkDocs.notConfigured',
      testId: 'default-external-knowledge-docs',
    },
    {
      key: 'organization' as const,
      configured: Boolean(wikispaceStatus.is_configured),
      synced: wikispaceTree.nodes.length > 0,
      lastSyncedAt: wikispaceStatus.last_synced_at,
      messageKey: wikispaceStatus.is_configured
        ? 'chat:dingtalkDocs.wikispaceEmpty'
        : 'chat:dingtalkDocs.wikispaceNotConfigured',
      testId: 'default-external-knowledge-wikispace',
    },
  ]
}

async function syncDingTalkScope(scope: string): Promise<void> {
  if (scope === 'organization') {
    await dingtalkDocApi.syncWikispaceNodes()
    return
  }
  await dingtalkDocApi.syncDocs()
}

async function listDingTalkNodes(
  knowledgeBaseId: string,
  params: ExternalKbNodeListParams = {}
): Promise<ExternalKbNodeListResponse> {
  const tree =
    knowledgeBaseId === DINGTALK_DOCS_CONTAINER_ID
      ? await dingtalkDocApi.getDocs()
      : await dingtalkDocApi.getWikispaceNodes()
  const sourceNodes =
    knowledgeBaseId === DINGTALK_DOCS_CONTAINER_ID
      ? tree.nodes
      : (findWikispaceRoot(tree.nodes, knowledgeBaseId)?.children ?? [])
  const items = sourceNodes.map(toExternalNode)

  return paginate(items, params.limit, params.offset)
}

export function registerDingTalkExternalKnowledgeSource(): void {
  if (registered) return

  registerExternalKnowledgeSource(DINGTALK_PROVIDER_ID, {
    providerId: DINGTALK_PROVIDER_ID,
    label: 'DingTalk',
    labelKey: 'chat:dingtalkDocs.tabTitle',
    shortLabel: 'DingTalk',
    icon: 'message',
    displayOrder: 10,
    configureHref: '/settings?section=integrations&tab=integrations',
    syncHref: '/settings?section=integrations&tab=integrations',
    capabilities: {
      enforcesPerUserAccess: true,
      supportsAgentDefault: true,
      supportsKnowledgeBaseSelection: true,
      supportsDocumentSelection: true,
      supportsDocumentTree: true,
      supportsScopedRetrieval: true,
      supportsVirtualContainers: true,
      supportsSyncStatus: true,
    },
    scopes: [
      {
        key: 'personal',
        label: 'DingTalk Docs',
        labelKey: 'chat:dingtalkDocs.myDocsTab',
        icon: 'file',
        displayOrder: 10,
        configureHref: '/settings?section=integrations&tab=integrations',
        syncHref: '/settings?section=integrations&tab=integrations',
        supportsSyncStatus: true,
      },
      {
        key: 'organization',
        label: 'DingTalk Knowledge Bases',
        labelKey: 'chat:dingtalkDocs.wikispaceTab',
        icon: 'database',
        displayOrder: 20,
        configureHref: '/settings?section=integrations&tab=integrations',
        syncHref: '/settings?section=integrations&tab=integrations',
        supportsSyncStatus: true,
      },
    ],
    listKnowledgeBases: listDingTalkKnowledgeBases,
    getKnowledgeBaseCount: getDingTalkKnowledgeBaseCount,
    getKnowledgeBaseDisplay: knowledgeBase =>
      knowledgeBase.knowledge_base_id === DINGTALK_DOCS_CONTAINER_ID
        ? {
            labelKey: 'chat:dingtalkDocs.allDocs',
            icon: 'folderOpen',
            rowVariant: 'primary',
            testId: 'knowledge-picker-dingtalk-all-docs',
          }
        : undefined,
    getScopeStatuses: getDingTalkScopeStatuses,
    syncScope: syncDingTalkScope,
    listNodes: listDingTalkNodes,
    toRef: knowledgeBase => ({
      provider: DINGTALK_PROVIDER_ID,
      mode: 'explicit',
      id: knowledgeBase.knowledge_base_id,
      name: knowledgeBase.knowledge_base_name,
      scope: knowledgeBase.scope ?? undefined,
      target_type: 'knowledge_base',
      workspace_id:
        knowledgeBase.knowledge_base_id === DINGTALK_DOCS_CONTAINER_ID
          ? undefined
          : knowledgeBase.knowledge_base_id,
    }),
  })
  registered = true
}
