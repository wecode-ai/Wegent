// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Check,
  ExternalLink,
  FileText,
  Folder,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  XIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LongTextTooltip, TruncatedText } from '@/components/common/long-text'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ExternalKnowledgeRef } from '@/types/context'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { loadKBExtensions } from '@/features/knowledge/document/extension-loader'
import {
  useExternalKnowledgeSources,
  type ExternalKnowledgeSource,
  type ExternalKnowledgeScopeStatus,
} from '@/features/knowledge/externalKnowledgeSourceRegistry'
import {
  listAllExternalKnowledgeBases,
  listAllExternalNodes,
} from '@/features/knowledge/externalKnowledgePagination'
import type {
  ExternalKbNode,
  ExternalKnowledgeBase,
  ExternalKnowledgeScope,
} from '@/types/external-knowledge'

interface ExternalKnowledgeDefaultSelectorProps {
  value: ExternalKnowledgeRef[]
  onChange: (value: ExternalKnowledgeRef[]) => void
  disabled?: boolean
  helperText?: string | null
}

interface ProviderDefaultOption {
  key: string
  label: string
  ref: ExternalKnowledgeRef
  providerId: string
  providerLabel: string
  knowledgeBaseLabel?: string
  fullLabel: string
  level: number
  type: 'knowledge_base' | 'document'
  disabled: boolean
}

interface ProviderDefaultGroup {
  provider: ExternalKnowledgeSource
  providerLabel: string
  options: ProviderDefaultOption[]
  statuses: ExternalKnowledgeScopeStatus[]
}

function externalRefKey(ref: ExternalKnowledgeRef): string {
  return [
    ref.provider,
    ref.mode,
    ref.id ?? 'all',
    ref.target_type ?? 'knowledge_base',
    ref.node_id ?? ref.document_id ?? '',
    ref.scope ?? '',
  ].join(':')
}

function externalProviderLabel(source: ExternalKnowledgeSource): string {
  return source.shortLabel || source.label || source.providerId
}

function buildProviderRootRef(
  source: ExternalKnowledgeSource,
  knowledgeBase: ExternalKnowledgeBase
): ExternalKnowledgeRef {
  const ref = source.toRef?.(knowledgeBase) ?? {
    provider: source.providerId,
    mode: 'explicit' as const,
    id: knowledgeBase.knowledge_base_id,
    name: knowledgeBase.knowledge_base_name,
    scope: knowledgeBase.scope ?? undefined,
    target_type: 'knowledge_base' as const,
  }
  return {
    ...ref,
    target_type: ref.target_type ?? 'knowledge_base',
    target_name: ref.target_name ?? knowledgeBase.knowledge_base_name,
  }
}

function buildProviderDocumentRef(
  rootRef: ExternalKnowledgeRef,
  node: ExternalKbNode
): ExternalKnowledgeRef {
  return {
    ...rootRef,
    target_type: 'document',
    node_id: node.node_id,
    document_id: node.raw_id ?? node.node_id,
    target_name: node.name,
  }
}

function flattenExternalDocuments(nodes: ExternalKbNode[]) {
  const result: Array<{ node: ExternalKbNode; level: number; path: string[] }> = []

  const walk = (node: ExternalKbNode, level: number, path: string[]) => {
    if (node.node_type === 'folder') {
      ;(node.children ?? []).forEach(child => walk(child, level + 1, [...path, node.name]))
      return
    }
    result.push({ node, level, path })
  }

  nodes.forEach(node => walk(node, 1, []))
  return result
}

async function buildProviderOptions(
  source: ExternalKnowledgeSource,
  knowledgeBases: ExternalKnowledgeBase[]
): Promise<ProviderDefaultOption[]> {
  const providerLabel = externalProviderLabel(source)
  const disabled =
    source.capabilities?.supportsAgentDefault === false ||
    source.capabilities?.enforcesPerUserAccess !== true
  const options: ProviderDefaultOption[] = []

  for (const knowledgeBase of knowledgeBases) {
    const ref = buildProviderRootRef(source, knowledgeBase)
    options.push({
      key: externalRefKey(ref),
      label: knowledgeBase.knowledge_base_name,
      ref,
      providerId: source.providerId,
      providerLabel,
      fullLabel: knowledgeBase.knowledge_base_name,
      level: 0,
      type: 'knowledge_base',
      disabled,
    })

    if (source.capabilities?.supportsDocumentSelection !== true || !source.listNodes) {
      continue
    }

    const nodes = await listAllExternalNodes(source, knowledgeBase.knowledge_base_id)
    flattenExternalDocuments(nodes).forEach(({ node, level, path }) => {
      const documentRef = buildProviderDocumentRef(ref, node)
      const documentPath = [knowledgeBase.knowledge_base_name, ...path, node.name].join(' / ')
      options.push({
        key: externalRefKey(documentRef),
        label: node.name,
        ref: documentRef,
        providerId: source.providerId,
        providerLabel,
        knowledgeBaseLabel: knowledgeBase.knowledge_base_name,
        fullLabel: documentPath,
        level,
        type: 'document',
        disabled,
      })
    })
  }

  return options
}

function formatSelectedRef(ref: ExternalKnowledgeRef): string {
  return ref.target_name || ref.name || ref.id || ref.provider
}

function formatSelectedRefFull(ref: ExternalKnowledgeRef): string {
  const sourceName = ref.name || ref.id || ref.provider
  if (!ref.target_name || ref.target_name === sourceName) return sourceName
  return `${sourceName} / ${ref.target_name}`
}

function ProviderKnowledgeOptionRow({
  option,
  selected,
  disabled,
  onToggle,
}: {
  option: ProviderDefaultOption
  selected: boolean
  disabled: boolean
  onToggle: (option: ProviderDefaultOption) => void
}) {
  const Icon = option.type === 'document' ? FileText : Folder
  return (
    <LongTextTooltip content={option.fullLabel}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm transition-colors last:border-b-0',
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted'
        )}
        disabled={disabled}
        onClick={() => onToggle(option)}
        data-testid={`default-external-knowledge-option-${option.key}`}
        style={{ paddingLeft: `${12 + option.level * 16}px` }}
        aria-label={option.fullLabel}
      >
        <Icon className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <TruncatedText
            text={
              option.knowledgeBaseLabel
                ? `${option.knowledgeBaseLabel} / ${option.label}`
                : option.label
            }
            tooltipText={option.fullLabel}
            focusable={false}
            className="text-text-primary"
          />
        </span>
        {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
      </button>
    </LongTextTooltip>
  )
}

function ProviderActionRowView({
  message,
  actionLabel,
  testId,
  disabled,
  loading,
  onClick,
  href,
}: {
  message: string
  actionLabel: string
  testId: string
  disabled?: boolean
  loading?: boolean
  onClick?: () => void
  href?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0">
      <span className="min-w-0 text-text-muted">{message}</span>
      {onClick ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2 text-primary"
          disabled={disabled || loading}
          onClick={onClick}
          data-testid={testId}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          {actionLabel}
        </Button>
      ) : (
        <Link
          href={href || '/settings?section=integrations&tab=integrations'}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2 text-sm font-medium text-primary hover:text-primary/80"
          data-testid={testId}
        >
          {actionLabel}
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  )
}

function getScopeActionHref(
  source: ExternalKnowledgeSource,
  scopeKey: ExternalKnowledgeScope,
  action: 'configure' | 'sync'
) {
  const scope = source.scopes?.find(item => item.key === scopeKey)
  if (action === 'sync') {
    return scope?.syncHref || source.syncHref || scope?.configureHref || source.configureHref
  }
  return scope?.configureHref || source.configureHref
}

export function ExternalKnowledgeDefaultSelector({
  value,
  onChange,
  disabled = false,
  helperText,
}: ExternalKnowledgeDefaultSelectorProps) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [triggerWidth, setTriggerWidth] = useState(0)
  const [providerGroups, setProviderGroups] = useState<ProviderDefaultGroup[]>([])
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerError, setProviderError] = useState(false)
  const [syncingScopes, setSyncingScopes] = useState<Set<string>>(new Set())
  const [reloadKey, setReloadKey] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const externalSources = useExternalKnowledgeSources()

  useEffect(() => {
    loadKBExtensions().catch((error: unknown) => {
      console.warn('Failed to load KB extensions for default knowledge selector', error)
    })
  }, [])

  useEffect(() => {
    if (open && triggerRef.current) {
      setTriggerWidth(triggerRef.current.offsetWidth)
    }
  }, [open])

  const providerSources = useMemo(
    () => externalSources.filter(source => source.listKnowledgeBases),
    [externalSources]
  )
  const selectedKeys = useMemo(() => new Set(value.map(externalRefKey)), [value])

  useEffect(() => {
    if (!open || disabled) {
      return
    }

    if (providerSources.length === 0) {
      setProviderGroups([])
      return
    }

    let cancelled = false
    setProviderLoading(true)
    setProviderError(false)
    Promise.all(
      providerSources.map(async source => {
        const [knowledgeBases, statuses] = await Promise.all([
          listAllExternalKnowledgeBases(source, { scope: 'all' }),
          source.getScopeStatuses?.() ?? Promise.resolve([]),
        ])
        return {
          provider: source,
          providerLabel: externalProviderLabel(source),
          options: await buildProviderOptions(source, knowledgeBases),
          statuses,
        }
      })
    )
      .then(groups => {
        if (cancelled) return
        setProviderGroups(groups)
      })
      .catch(error => {
        if (cancelled) return
        console.warn('Failed to load external default knowledge sources', error)
        setProviderGroups([])
        setProviderError(true)
      })
      .finally(() => {
        if (!cancelled) {
          setProviderLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [disabled, open, providerSources, reloadKey])

  const handleToggle = (option: ProviderDefaultOption) => {
    const key = externalRefKey(option.ref)
    if (selectedKeys.has(key)) {
      onChange(value.filter(ref => externalRefKey(ref) !== key))
      return
    }
    onChange([...value, option.ref])
  }

  const handleSyncScope = async (
    source: ExternalKnowledgeSource,
    scope: ExternalKnowledgeScope
  ) => {
    if (!source.syncScope) return
    const key = `${source.providerId}:${scope}`
    setSyncingScopes(prev => new Set(prev).add(key))
    try {
      await source.syncScope(scope)
      setReloadKey(prev => prev + 1)
    } finally {
      setSyncingScopes(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const renderProviderActionRows = (group: ProviderDefaultGroup) =>
    group.statuses
      .filter(status => !status.configured || status.synced === false)
      .map(status => {
        const syncing =
          status.syncing || syncingScopes.has(`${group.provider.providerId}:${status.key}`)
        const canSync = status.configured && Boolean(group.provider.syncScope)
        const action = canSync ? 'sync' : 'configure'
        const testIdBase =
          status.testId ?? `default-external-knowledge-${group.provider.providerId}-${status.key}`
        return (
          <ProviderActionRowView
            key={`${group.provider.providerId}:${status.key}`}
            message={
              status.messageKey
                ? t(status.messageKey)
                : t('team.simple.core.external_knowledge_source_unavailable', {
                    source: group.providerLabel,
                  })
            }
            actionLabel={
              syncing
                ? t('team.simple.core.external_knowledge_syncing')
                : status.actionLabelKey
                  ? t(status.actionLabelKey)
                  : canSync
                    ? t('team.simple.core.external_knowledge_sync_now')
                    : t('team.simple.core.external_knowledge_go_to_settings')
            }
            testId={`${testIdBase}-${action === 'sync' ? 'sync-button' : 'settings-link'}`}
            disabled={disabled}
            loading={syncing}
            onClick={canSync ? () => handleSyncScope(group.provider, status.key) : undefined}
            href={getScopeActionHref(group.provider, status.key, action)}
          />
        )
      })

  const renderListContent = () => {
    if (providerLoading) {
      return (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('team.simple.core.external_knowledge_loading')}</span>
        </div>
      )
    }

    if (providerError) {
      return (
        <div className="px-4 py-8 text-center text-sm text-text-muted">
          {t('team.simple.core.external_knowledge_load_failed')}
        </div>
      )
    }

    const hasOptions = providerGroups.some(group => group.options.length > 0)
    const actionRows = providerGroups.flatMap(renderProviderActionRows)

    if (!hasOptions) {
      return (
        <div>
          {actionRows.length > 0 ? (
            actionRows
          ) : (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              {t('team.simple.core.external_knowledge_empty')}
            </div>
          )}
        </div>
      )
    }

    return (
      <>
        {actionRows}
        {providerGroups.map(group => (
          <div
            key={group.provider.providerId}
            data-testid={`default-external-knowledge-provider-${group.provider.providerId}`}
          >
            {group.options.length > 0 ? (
              <div className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-text-muted last:border-b-0">
                {group.providerLabel}
              </div>
            ) : null}
            {group.options.map(option => (
              <ProviderKnowledgeOptionRow
                key={option.key}
                option={option}
                selected={selectedKeys.has(externalRefKey(option.ref))}
                disabled={disabled || option.disabled}
                onToggle={handleToggle}
              />
            ))}
          </div>
        ))}
      </>
    )
  }

  return (
    <div className="space-y-2" data-testid="default-external-knowledge-selector">
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="flex h-9 w-full items-center justify-between rounded-md border border-border/50 bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            data-testid="default-external-knowledge-trigger"
          >
            <div className="flex min-w-0 items-center gap-2 text-text-muted">
              <MessageSquareText className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">{t('team.simple.core.external_knowledge_select')}</span>
            </div>
            <Plus className="h-4 w-4 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="max-h-[360px] overflow-y-auto border border-border p-0"
          style={{ width: triggerWidth > 0 ? triggerWidth : '100%' }}
          align="start"
          side="bottom"
          sideOffset={4}
          data-testid="default-external-knowledge-popover"
        >
          {renderListContent()}
        </PopoverContent>
      </Popover>

      <div className="flex flex-wrap gap-1.5">
        {value.map(ref => {
          const key = externalRefKey(ref)
          const selectedLabel = formatSelectedRef(ref)
          const selectedFullLabel = formatSelectedRefFull(ref)
          return (
            <LongTextTooltip key={key} content={selectedFullLabel}>
              <span
                className="inline-flex max-w-[min(260px,100%)] items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm"
                data-testid={`default-external-knowledge-chip-${key}`}
                aria-label={selectedFullLabel}
              >
                <TruncatedText
                  text={selectedLabel}
                  tooltipText={selectedFullLabel}
                  focusable={false}
                  className="max-w-[220px]"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0"
                  disabled={disabled}
                  onClick={() => onChange(value.filter(item => externalRefKey(item) !== key))}
                  data-testid={`default-external-knowledge-remove-${key}`}
                >
                  <XIcon className="h-3 w-3" />
                </Button>
              </span>
            </LongTextTooltip>
          )
        })}
      </div>

      {helperText === null ? null : (
        <p className="text-xs text-text-muted">
          {helperText || t('team.simple.core.external_knowledge_helper')}
        </p>
      )}
    </div>
  )
}
