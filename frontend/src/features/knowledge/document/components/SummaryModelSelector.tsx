// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { modelApis, UnifiedModel } from '@/apis/models'
import { useTranslation } from '@/hooks/useTranslation'
import { getGlobalModelPreference } from '@/utils/modelPreferences'
import type { SummaryModelRef } from '@/types/knowledge'

interface SummaryModelSelectorProps {
  value?: SummaryModelRef | null
  onChange: (value: SummaryModelRef | null) => void
  disabled?: boolean
  error?: string
  /** Optional team ID to read cached model preference from localStorage */
  knowledgeDefaultTeamId?: number | null
}

export function SummaryModelSelector({
  value,
  onChange,
  disabled = false,
  error,
  knowledgeDefaultTeamId,
}: SummaryModelSelectorProps) {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(false)
  // Track the last team ID for which we attempted preselection
  // This allows re-attempting when the team ID changes or dialog reopens
  const attemptedTeamIdRef = useRef<number | null>(null)

  // Fetch models on mount
  useEffect(() => {
    const fetchModels = async () => {
      setLoading(true)
      try {
        // Fetch LLM models (all scopes)
        const response = await modelApis.getUnifiedModels(undefined, false, 'all', undefined, 'llm')
        // Sort by displayName
        const sortedModels = (response.data || []).sort((a, b) => {
          const nameA = a.displayName || a.name
          const nameB = b.displayName || b.name
          return nameA.localeCompare(nameB)
        })
        setModels(sortedModels)
      } catch (err) {
        console.error('Failed to fetch models:', err)
        setModels([])
      } finally {
        setLoading(false)
      }
    }

    fetchModels()
  }, [])

  // Auto-preselect model from cached preference when:
  // 1. Models are loaded
  // 2. No value is currently selected
  // 3. Valid knowledgeDefaultTeamId is provided
  // 4. Haven't attempted preselection for this team ID yet (allows re-attempting when team changes)
  useEffect(() => {
    // Skip if value exists, still loading, or no teamId
    if (value || loading || models.length === 0 || !knowledgeDefaultTeamId) {
      return
    }

    // Skip if we already attempted preselection for this team ID
    if (attemptedTeamIdRef.current === knowledgeDefaultTeamId) {
      return
    }

    // Mark this team ID as attempted
    attemptedTeamIdRef.current = knowledgeDefaultTeamId

    // Read cached preference from localStorage
    const cachedPreference = getGlobalModelPreference(knowledgeDefaultTeamId)
    if (!cachedPreference?.modelName) {
      return
    }

    // Find matching model in the models list
    const matchedModel = models.find(model => {
      // Match by modelName (required)
      if (model.name !== cachedPreference.modelName) {
        return false
      }
      // If modelType is specified in preference, also match by type
      if (cachedPreference.modelType && model.type !== cachedPreference.modelType) {
        return false
      }
      return true
    })

    if (matchedModel) {
      // Auto-select the matched model
      onChange({
        name: matchedModel.name,
        namespace: matchedModel.namespace || 'default',
        type: matchedModel.type,
      })
    }
  }, [models, value, loading, knowledgeDefaultTeamId, onChange])

  // Find selected model
  const selectedModel = useMemo(() => {
    if (!value) return null
    return models.find(
      m => m.name === value.name && m.namespace === value.namespace && m.type === value.type
    )
  }, [models, value])

  // Get display value
  const displayValue = useMemo(() => {
    if (selectedModel) {
      return selectedModel.displayName || selectedModel.name
    }
    if (value) {
      // Model not found in list but value exists
      return value.name
    }
    return t('document.summary.selectModel')
  }, [selectedModel, value, t])

  const handleSelect = (model: UnifiedModel) => {
    onChange({
      name: model.name,
      namespace: model.namespace || 'default',
      type: model.type,
    })
    setOpen(false)
  }

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'public':
        return t('common:models.public')
      case 'user':
        return t('common:models.my_models')
      case 'group':
        return t('common:models.group')
      default:
        return type
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'w-full justify-between font-normal',
              !value && 'text-text-muted',
              error && 'border-red-500'
            )}
            disabled={disabled || loading}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common:loading', 'Loading...')}
              </span>
            ) : (
              <span className="truncate">{displayValue}</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0" align="start">
          <Command>
            <CommandInput placeholder={t('document.summary.modelPlaceholder')} />
            <CommandList
              onWheel={e => {
                e.stopPropagation()
              }}
            >
              <CommandEmpty>{t('common:noResults', 'No results found')}</CommandEmpty>
              <CommandGroup>
                {models.map(model => {
                  const isSelected =
                    value?.name === model.name &&
                    value?.namespace === model.namespace &&
                    value?.type === model.type
                  return (
                    <CommandItem
                      key={`${model.type}-${model.namespace}-${model.name}`}
                      value={`${model.displayName || model.name} ${model.type}`}
                      onSelect={() => handleSelect(model)}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Check
                          className={cn(
                            'h-4 w-4 shrink-0',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="truncate">{model.displayName || model.name}</span>
                      </div>
                      <Badge variant="secondary" size="sm" className="shrink-0 ml-2">
                        {getTypeLabel(model.type)}
                      </Badge>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  )
}
