// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, Plus, XIcon } from 'lucide-react'

import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LongTextTooltip, TruncatedText } from '@/components/common/long-text'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { loadKBExtensions } from '@/features/knowledge/document/extension-loader'
import { useExternalKnowledgeSources } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import {
  KnowledgeSourcePicker,
  type GroupedKnowledgeBases,
} from '@/features/tasks/components/chat/KnowledgeSourcePicker'
import {
  groupContextItems,
  removeGroup,
  type KnowledgeSelectionGroup,
} from '@/features/tasks/utils/knowledge-selection-groups'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { KnowledgeBaseDefaultRef } from '@/types/api'
import type { AllGroupedKnowledgeResponse, KnowledgeBaseWithGroupInfo } from '@/types/knowledge'
import type {
  ContextItem,
  ExternalKnowledgeContext,
  ExternalKnowledgeRef,
  KnowledgeBaseContext,
} from '@/types/context'

interface AgentDefaultKnowledgeScopeSelectorProps {
  defaultKnowledgeBaseRefs: KnowledgeBaseDefaultRef[]
  onDefaultKnowledgeBaseRefsChange: (value: KnowledgeBaseDefaultRef[]) => void
  defaultExternalKnowledgeRefs: ExternalKnowledgeRef[]
  onDefaultExternalKnowledgeRefsChange: (value: ExternalKnowledgeRef[]) => void
  disabled?: boolean
  allowedSources?: Array<'personal' | 'group' | 'organization'>
  allowedGroupNamespaces?: string[]
  allowExternalKnowledge?: boolean
}

type TranslationFunction = ReturnType<typeof useTranslation>['t']

function buildExternalContextId(ref: ExternalKnowledgeRef) {
  const targetType = ref.target_type ?? 'knowledge_base'
  if (targetType !== 'knowledge_base') {
    const targetId = ref.node_id ?? ref.document_id ?? 'unknown'
    return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}:${targetType}:${targetId}`
  }
  return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}`
}

function toKnowledgeBaseContext(ref: KnowledgeBaseDefaultRef): KnowledgeBaseContext {
  const scopeRestricted = Boolean(
    ref.scope_restricted || ref.document_ids?.length || ref.folder_ids?.length
  )
  return {
    id: ref.id,
    name: ref.name,
    type: 'knowledge_base',
    document_ids: ref.document_ids,
    document_names: ref.document_names,
    folder_ids: ref.folder_ids,
    folder_names: ref.folder_names,
    include_subfolders: ref.include_subfolders,
    scope_restricted: scopeRestricted,
  }
}

function toExternalKnowledgeContext(ref: ExternalKnowledgeRef): ExternalKnowledgeContext {
  return {
    type: 'external_knowledge',
    id: buildExternalContextId(ref),
    name: ref.target_name || ref.name || ref.id || ref.provider,
    ref,
  }
}

function toKnowledgeBaseRef(context: KnowledgeBaseContext): KnowledgeBaseDefaultRef {
  const scopeRestricted = Boolean(
    context.scope_restricted || context.document_ids?.length || context.folder_ids?.length
  )
  return {
    id: Number(context.id),
    name: context.name,
    ...(context.document_ids?.length ? { document_ids: context.document_ids } : {}),
    ...(context.document_names?.length ? { document_names: context.document_names } : {}),
    ...(context.folder_ids?.length ? { folder_ids: context.folder_ids } : {}),
    ...(context.folder_names?.length ? { folder_names: context.folder_names } : {}),
    ...(scopeRestricted
      ? {
          include_subfolders: context.include_subfolders ?? true,
          scope_restricted: true,
        }
      : {}),
  }
}

function splitContexts(contexts: ContextItem[]) {
  const knowledgeBaseRefs: KnowledgeBaseDefaultRef[] = []
  const externalKnowledgeRefs: ExternalKnowledgeRef[] = []

  for (const context of contexts) {
    if (context.type === 'knowledge_base') {
      knowledgeBaseRefs.push(toKnowledgeBaseRef(context))
    } else if (context.type === 'external_knowledge') {
      externalKnowledgeRefs.push(context.ref)
    }
  }

  return { knowledgeBaseRefs, externalKnowledgeRefs }
}

function toKnowledgeBase(item: KnowledgeBaseWithGroupInfo) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    user_id: item.user_id,
    namespace: item.namespace,
    document_count: item.document_count,
    is_active: true,
    summary_enabled: false,
    kb_type: item.kb_type || 'notebook',
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: item.created_at,
    updated_at: item.updated_at,
  }
}

function buildGroupedKnowledgeBases(
  response: AllGroupedKnowledgeResponse | null,
  allowedSources?: AgentDefaultKnowledgeScopeSelectorProps['allowedSources'],
  allowedGroupNamespaces?: string[]
): GroupedKnowledgeBases {
  const groups: GroupedKnowledgeBases = {
    personal: [],
    group: new Map(),
    organization: [],
  }
  if (!response) return groups

  const allows = (source: 'personal' | 'group' | 'organization') =>
    !allowedSources?.length || allowedSources.includes(source)

  if (allows('personal')) {
    groups.personal = [
      ...response.personal.created_by_me.map(toKnowledgeBase),
      ...response.personal.shared_with_me.map(toKnowledgeBase),
    ]
  }
  if (allows('organization')) {
    groups.organization = response.organization.knowledge_bases.map(toKnowledgeBase)
  }
  if (allows('group')) {
    for (const group of response.groups) {
      if (allowedGroupNamespaces?.length && !allowedGroupNamespaces.includes(group.group_name)) {
        continue
      }
      groups.group.set(group.group_name, {
        name: group.group_name,
        displayName: group.group_display_name || group.group_name,
        items: group.knowledge_bases.map(toKnowledgeBase),
      })
    }
  }

  groups.personal.sort((a, b) => a.name.localeCompare(b.name))
  groups.organization.sort((a, b) => a.name.localeCompare(b.name))
  for (const group of groups.group.values()) {
    group.items.sort((a, b) => a.name.localeCompare(b.name))
  }
  groups.group = new Map(
    Array.from(groups.group.entries()).sort(
      (a, b) => a[1].displayName.localeCompare(b[1].displayName) || a[0].localeCompare(b[0])
    )
  )
  return groups
}

function groupSubtitle(group: KnowledgeSelectionGroup, t: TranslationFunction) {
  if (group.selectionMode === 'all') return t('team.simple.core.default_knowledge_scope.all')
  return t('team.simple.core.default_knowledge_scope.partial', {
    count: group.selectedTargetCount,
  })
}

function groupTooltip(group: KnowledgeSelectionGroup, subtitle: string) {
  const details = group.selectedTargetNames.slice(0, 5)
  const remaining = group.selectedTargetNames.length - details.length
  return [group.sourceName, subtitle, ...details, ...(remaining > 0 ? [`+${remaining}`] : [])].join(
    '\n'
  )
}

function testIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-')
}

export function AgentDefaultKnowledgeScopeSelector({
  defaultKnowledgeBaseRefs,
  onDefaultKnowledgeBaseRefsChange,
  defaultExternalKnowledgeRefs,
  onDefaultExternalKnowledgeRefsChange,
  disabled = false,
  allowedSources,
  allowedGroupNamespaces,
  allowExternalKnowledge = true,
}: AgentDefaultKnowledgeScopeSelectorProps) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [allGroupedKnowledge, setAllGroupedKnowledge] =
    useState<AllGroupedKnowledgeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchValue, setSearchValue] = useState('')
  const externalSources = useExternalKnowledgeSources()

  const selectedContexts = useMemo<ContextItem[]>(
    () => [
      ...defaultKnowledgeBaseRefs.map(toKnowledgeBaseContext),
      ...defaultExternalKnowledgeRefs.map(toExternalKnowledgeContext),
    ],
    [defaultExternalKnowledgeRefs, defaultKnowledgeBaseRefs]
  )

  const groupedKnowledgeBases = useMemo(
    () => buildGroupedKnowledgeBases(allGroupedKnowledge, allowedSources, allowedGroupNamespaces),
    [allGroupedKnowledge, allowedGroupNamespaces, allowedSources]
  )

  const agentDefaultExternalSources = useMemo(
    () =>
      allowExternalKnowledge
        ? externalSources.filter(
            source =>
              source.listKnowledgeBases &&
              source.capabilities?.supportsAgentDefault !== false &&
              source.capabilities?.enforcesPerUserAccess === true
          )
        : [],
    [allowExternalKnowledge, externalSources]
  )

  const selectedGroups = useMemo(() => groupContextItems(selectedContexts), [selectedContexts])

  const emitContexts = useCallback(
    (contexts: ContextItem[]) => {
      const { knowledgeBaseRefs, externalKnowledgeRefs } = splitContexts(contexts)
      onDefaultKnowledgeBaseRefsChange(knowledgeBaseRefs)
      onDefaultExternalKnowledgeRefsChange(externalKnowledgeRefs)
    },
    [onDefaultExternalKnowledgeRefsChange, onDefaultKnowledgeBaseRefsChange]
  )

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setAllGroupedKnowledge(await knowledgeBaseApi.getAllGrouped())
    } catch (fetchError) {
      console.error('Failed to fetch default knowledge scope options:', fetchError)
      setAllGroupedKnowledge(null)
      setError(t('team.simple.core.default_knowledge_scope.load_failed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchKnowledgeBases()
  }, [fetchKnowledgeBases])

  useEffect(() => {
    loadKBExtensions().catch((loadError: unknown) => {
      console.warn('Failed to load KB extensions for default knowledge scope selector', loadError)
    })
  }, [])

  useEffect(() => {
    if (!open) setSearchValue('')
  }, [open])

  const handleSelect = (context: ContextItem) => {
    emitContexts([...selectedContexts.filter(item => item.id !== context.id), context])
  }

  const handleDeselect = (id: number | string) => {
    emitContexts(selectedContexts.filter(context => context.id !== id))
  }

  const handleReplaceContexts = (
    idsToRemove: (number | string)[],
    contextsToAdd: ContextItem[]
  ) => {
    const removedIds = new Set(idsToRemove)
    const addIds = new Set(contextsToAdd.map(context => context.id))
    emitContexts([
      ...selectedContexts.filter(context => !removedIds.has(context.id) && !addIds.has(context.id)),
      ...contextsToAdd,
    ])
  }

  const handleRemoveGroup = (groupKey: string) => {
    emitContexts(removeGroup(selectedContexts, groupKey))
  }

  return (
    <div className="space-y-2" data-testid="agent-default-knowledge-scope-selector">
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-9 w-full justify-between bg-base px-3"
            disabled={disabled}
            data-testid="agent-default-knowledge-scope-trigger"
          >
            <span className="flex min-w-0 items-center gap-2 text-text-muted">
              <Database className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">
                {t('team.simple.core.default_knowledge_scope.select')}
              </span>
            </span>
            <Plus className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className={cn(
            'p-0 w-[760px] max-w-[calc(100vw-24px)] border border-border bg-base',
            'max-h-[var(--radix-popover-content-available-height)] overflow-hidden rounded-xl shadow-xl'
          )}
          align="start"
          side="bottom"
          sideOffset={4}
          collisionPadding={8}
          data-testid="agent-default-knowledge-scope-popover"
        >
          <div className="flex min-h-0 flex-col">
            <Input
              placeholder={t('team.simple.core.default_knowledge_scope.search')}
              value={searchValue}
              onChange={event => setSearchValue(event.target.value)}
              className="h-9 shrink-0 rounded-none border-b border-border text-sm"
              data-testid="agent-default-knowledge-scope-search-input"
            />
            <KnowledgeSourcePicker
              groupedKnowledgeBases={groupedKnowledgeBases}
              boundKnowledgeBases={[]}
              externalSources={agentDefaultExternalSources}
              selectedContexts={selectedContexts}
              searchValue={searchValue}
              loading={loading}
              error={error}
              onRetry={fetchKnowledgeBases}
              onSelect={handleSelect}
              onDeselect={handleDeselect}
              onReplaceContexts={handleReplaceContexts}
            />
          </div>
        </PopoverContent>
      </Popover>

      {selectedGroups.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedGroups.map(group => {
            const subtitle = groupSubtitle(group, t)
            const label = `${group.sourceName} · ${subtitle}`
            return (
              <LongTextTooltip key={group.key} content={groupTooltip(group, subtitle)}>
                <span
                  className="inline-flex max-w-[min(320px,100%)] items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm"
                  data-testid={`agent-default-knowledge-scope-chip-${testIdPart(group.key)}`}
                >
                  <TruncatedText text={label} focusable={false} className="max-w-[260px]" />
                  <button
                    type="button"
                    className="shrink-0 text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disabled}
                    onClick={() => handleRemoveGroup(group.key)}
                    data-testid={`agent-default-knowledge-scope-remove-${testIdPart(group.key)}`}
                    aria-label={t('team.simple.core.default_knowledge_scope.remove', {
                      name: group.sourceName,
                    })}
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </span>
              </LongTextTooltip>
            )
          })}
        </div>
      ) : null}

      <div className="space-y-1 text-xs text-text-muted">
        <p>{t('team.simple.core.default_knowledge_scope.description')}</p>
        <p>{t('team.simple.core.default_knowledge_scope.visibility_hint')}</p>
      </div>
    </div>
  )
}
