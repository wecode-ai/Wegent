// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ChevronsUpDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  buildModelCascadeGroups,
  getModelDisplayName,
  matchesModelSearch,
  type GroupableModel,
} from './model-grouping'
import { ModelCapabilityIcons } from './ModelCapabilityIcons'

export interface ModelCascadeLabels {
  ungrouped: string
  uncategorized: string
  searchPlaceholder: string
  searchResults: string
  noModels: string
  noMatch: string
  primaryGroups: string
  secondaryGroups: string
}

export interface SpecialModelOption {
  key: string
  label: string
  description?: string
  searchText?: string
}

interface ModelCascadeContentProps<T extends GroupableModel> {
  models: T[]
  selectedModel?: T | null
  selectedSpecialKey?: string | null
  specialOptions?: SpecialModelOption[]
  labels: ModelCascadeLabels
  searchValue: string
  onSearchValueChange: (value: string) => void
  onSelectModel: (model: T) => void
  onSelectSpecialOption?: (key: string) => void
  getModelKey?: (model: T) => string
  renderModelBadges?: (model: T) => React.ReactNode
  renderModelMeta?: (model: T) => React.ReactNode
  renderModelActions?: (model: T) => React.ReactNode
  footer?: React.ReactNode
  className?: string
  variant?: 'desktop' | 'mobile'
}

interface GroupedModelSelectProps<T extends GroupableModel> extends Omit<
  ModelCascadeContentProps<T>,
  'searchValue' | 'onSearchValueChange'
> {
  placeholder: string
  disabled?: boolean
  triggerClassName?: string
  contentClassName?: string
  dataTestId?: string
  align?: 'start' | 'center' | 'end'
}

function defaultModelKey(model: GroupableModel): string {
  return `${model.name}:${model.type || ''}`
}

function sanitizeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function getSpecialOptionSearchText(option: SpecialModelOption): string {
  return [option.key, option.label, option.description, option.searchText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function getModelGroupName(
  model: GroupableModel | null | undefined,
  labels: ModelCascadeLabels
): string | null {
  return model?.modelGroup?.trim() || labels.ungrouped
}

function getModelSubGroupName(
  model: GroupableModel | null | undefined,
  labels: ModelCascadeLabels
): string | null {
  return model?.modelSubGroup?.trim() || labels.uncategorized
}

function getGroupCountLabel(count: number): string {
  return String(count)
}

type MobileCascadeStep = 'primary' | 'secondary' | 'models'

export function ModelCascadeContent<T extends GroupableModel>({
  models,
  selectedModel,
  selectedSpecialKey,
  specialOptions = [],
  labels,
  searchValue,
  onSearchValueChange,
  onSelectModel,
  onSelectSpecialOption,
  getModelKey = defaultModelKey,
  renderModelBadges,
  renderModelMeta,
  renderModelActions,
  footer,
  className,
  variant = 'desktop',
}: ModelCascadeContentProps<T>) {
  const groups = useMemo(
    () =>
      buildModelCascadeGroups(models, {
        ungroupedLabel: labels.ungrouped,
        uncategorizedLabel: labels.uncategorized,
      }),
    [models, labels.uncategorized, labels.ungrouped]
  )
  const [activeGroupName, setActiveGroupName] = useState<string>('')
  const [activeSubGroupName, setActiveSubGroupName] = useState<string>('')
  const [mobileStep, setMobileStep] = useState<MobileCascadeStep>('primary')
  const selectedModelOptionRef = useRef<HTMLButtonElement | null>(null)
  const selectedModelKey = selectedModel ? getModelKey(selectedModel) : null

  useEffect(() => {
    if (groups.length === 0) {
      setActiveGroupName('')
      setActiveSubGroupName('')
      return
    }

    const selectedGroupName = getModelGroupName(selectedModel, labels)
    const nextGroup =
      groups.find(group => group.name === activeGroupName) ??
      groups.find(group => group.name === selectedGroupName) ??
      groups[0]
    const selectedSubGroupName = getModelSubGroupName(selectedModel, labels)
    const nextSubGroup =
      nextGroup.subGroups.find(subGroup => subGroup.name === activeSubGroupName) ??
      nextGroup.subGroups.find(subGroup => subGroup.name === selectedSubGroupName) ??
      nextGroup.subGroups[0]

    setActiveGroupName(nextGroup.name)
    setActiveSubGroupName(nextSubGroup?.name ?? '')
  }, [activeGroupName, activeSubGroupName, groups, labels, selectedModel])

  useEffect(() => {
    if (groups.length === 0) {
      setMobileStep('primary')
    }
  }, [groups.length])

  const activeGroup = groups.find(group => group.name === activeGroupName) ?? groups[0]
  const activeSubGroup =
    activeGroup?.subGroups.find(subGroup => subGroup.name === activeSubGroupName) ??
    activeGroup?.subGroups[0]
  const normalizedSearchValue = searchValue.trim()
  const isSearching = normalizedSearchValue.length > 0
  const searchResults = useMemo(
    () => models.filter(model => matchesModelSearch(model, normalizedSearchValue)),
    [models, normalizedSearchValue]
  )
  const specialSearchResults = useMemo(() => {
    if (!normalizedSearchValue) return specialOptions
    const query = normalizedSearchValue.toLowerCase()
    return specialOptions.filter(option => getSpecialOptionSearchText(option).includes(query))
  }, [normalizedSearchValue, specialOptions])

  useEffect(() => {
    if (!selectedModelKey || isSearching) return
    selectedModelOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeGroup?.name, activeSubGroup?.name, isSearching, selectedModelKey])

  const renderSpecialOption = (option: SpecialModelOption) => {
    const isSelected = selectedSpecialKey === option.key

    return (
      <button
        key={option.key}
        type="button"
        data-testid={`model-special-option-${sanitizeTestId(option.key)}`}
        onClick={() => onSelectSpecialOption?.(option.key)}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left',
          'hover:bg-hover focus:bg-hover focus:outline-none',
          isSelected && 'bg-primary/10 text-primary'
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-text-primary">
            {option.label}
          </span>
          {option.description && (
            <span className="block truncate text-xs text-text-muted">{option.description}</span>
          )}
        </span>
        <Check className={cn('h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
      </button>
    )
  }

  const renderModelOption = (model: T, showPath: boolean) => {
    const modelKey = getModelKey(model)
    const isSelected = selectedModelKey === modelKey
    const groupPath = `${getModelGroupName(model, labels)} / ${getModelSubGroupName(model, labels)}`
    const modelActions = renderModelActions?.(model)

    return (
      <div
        key={modelKey}
        className={cn(
          'w-full items-stretch overflow-hidden',
          modelActions ? 'grid grid-cols-[minmax(0,1fr)_40px]' : 'flex',
          isSelected && 'bg-primary/10 text-primary'
        )}
      >
        <button
          ref={isSelected ? selectedModelOptionRef : undefined}
          type="button"
          data-model-key={modelKey}
          data-testid={`model-option-${sanitizeTestId(model.name)}`}
          onClick={() => onSelectModel(model)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 pr-0 text-left',
            'hover:bg-hover focus:bg-hover focus:outline-none'
          )}
        >
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-sm font-medium text-text-primary"
              title={getModelDisplayName(model)}
            >
              {getModelDisplayName(model)}
            </span>
            {showPath && (
              <span className="block truncate text-xs text-text-muted">{groupPath}</span>
            )}
            {renderModelMeta?.(model)}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <ModelCapabilityIcons model={model} />
            {renderModelBadges?.(model)}
          </span>
        </button>
        {modelActions}
      </div>
    )
  }

  const renderMobileSpecialOption = (option: SpecialModelOption, withBorder: boolean) => {
    const isSelected = selectedSpecialKey === option.key

    return (
      <button
        key={option.key}
        type="button"
        data-testid={`model-mobile-special-option-${sanitizeTestId(option.key)}`}
        onClick={() => onSelectSpecialOption?.(option.key)}
        className={cn(
          'flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left',
          'active:bg-hover focus:bg-hover focus:outline-none',
          isSelected && 'bg-primary/10 text-primary',
          withBorder && 'border-b border-border'
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-text-primary">
            {option.label}
          </span>
          {option.description && (
            <span className="block truncate text-xs text-text-muted">{option.description}</span>
          )}
        </span>
        <Check className={cn('h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
      </button>
    )
  }

  const renderMobileModelOption = (model: T, showPath: boolean, withBorder: boolean) => {
    const modelKey = getModelKey(model)
    const isSelected = selectedModelKey === modelKey
    const groupPath = `${getModelGroupName(model, labels)} / ${getModelSubGroupName(model, labels)}`
    const modelActions = renderModelActions?.(model)

    return (
      <div
        key={modelKey}
        className={cn(
          'w-full items-stretch overflow-hidden',
          modelActions ? 'grid grid-cols-[minmax(0,1fr)_40px]' : 'flex',
          isSelected && 'bg-primary/10 text-primary',
          withBorder && 'border-b border-border'
        )}
      >
        <button
          type="button"
          data-model-key={modelKey}
          data-testid={`model-mobile-option-${sanitizeTestId(model.name)}`}
          onClick={() => onSelectModel(model)}
          className={cn(
            'flex min-h-[44px] min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 pr-0 text-left',
            'active:bg-hover focus:bg-hover focus:outline-none'
          )}
        >
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-sm font-medium text-text-primary"
              title={getModelDisplayName(model)}
            >
              {getModelDisplayName(model)}
            </span>
            {showPath && (
              <span className="block truncate text-xs text-text-muted">{groupPath}</span>
            )}
            {renderModelMeta?.(model)}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <ModelCapabilityIcons model={model} />
            {renderModelBadges?.(model)}
          </span>
        </button>
        {modelActions}
      </div>
    )
  }

  const renderMobileBackButton = (label: string, onClick: () => void) => (
    <button
      type="button"
      data-testid="model-mobile-back-button"
      onClick={onClick}
      className="mb-2 flex min-h-[44px] items-center gap-1 text-primary active:opacity-70"
    >
      <ChevronLeft className="h-5 w-5" />
      <span className="truncate text-sm font-medium">{label}</span>
    </button>
  )

  const renderMobilePrimaryGroups = () => (
    <div
      data-testid="model-mobile-primary-groups"
      className="overflow-hidden rounded-lg border border-border bg-base"
    >
      {specialOptions.map((option, index) =>
        renderMobileSpecialOption(option, index < specialOptions.length - 1 || groups.length > 0)
      )}
      {groups.map((group, index) => {
        const isLast = index === groups.length - 1

        return (
          <button
            key={group.name}
            type="button"
            data-testid={`model-mobile-primary-group-${sanitizeTestId(group.name)}`}
            onClick={() => {
              setActiveGroupName(group.name)
              setActiveSubGroupName(group.subGroups[0]?.name ?? '')
              setMobileStep('secondary')
            }}
            className={cn(
              'flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left',
              'active:bg-hover focus:bg-hover focus:outline-none',
              !isLast && 'border-b border-border'
            )}
          >
            <span className="min-w-0 truncate text-sm font-medium text-text-primary">
              {group.name}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                {getGroupCountLabel(group.count)}
              </span>
              <ChevronRight className="h-4 w-4 text-text-muted" />
            </span>
          </button>
        )
      })}
    </div>
  )

  const renderMobileSecondaryGroups = () => (
    <div>
      {renderMobileBackButton(labels.primaryGroups, () => setMobileStep('primary'))}
      <div
        data-testid="model-mobile-secondary-groups"
        className="overflow-hidden rounded-lg border border-border bg-base"
      >
        {activeGroup?.subGroups.map((subGroup, index) => {
          const isLast = index === activeGroup.subGroups.length - 1

          return (
            <button
              key={subGroup.name}
              type="button"
              data-testid={`model-mobile-secondary-group-${sanitizeTestId(subGroup.name)}`}
              onClick={() => {
                setActiveSubGroupName(subGroup.name)
                setMobileStep('models')
              }}
              className={cn(
                'flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2.5 text-left',
                'active:bg-hover focus:bg-hover focus:outline-none',
                !isLast && 'border-b border-border'
              )}
            >
              <span className="min-w-0 truncate text-sm font-medium text-text-primary">
                {subGroup.name}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                  {getGroupCountLabel(subGroup.count)}
                </span>
                <ChevronRight className="h-4 w-4 text-text-muted" />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const renderMobileModels = () => (
    <div>
      {renderMobileBackButton(activeGroup?.name ?? labels.secondaryGroups, () =>
        setMobileStep('secondary')
      )}
      <div
        data-testid="model-mobile-models"
        className="overflow-hidden rounded-lg border border-border bg-base"
      >
        {activeSubGroup?.models.map((model, index) =>
          renderMobileModelOption(model, false, index !== activeSubGroup.models.length - 1)
        )}
      </div>
    </div>
  )

  const renderMobileSearchResults = () => (
    <div
      data-testid="model-mobile-search-results"
      className="max-h-[min(58vh,420px)] overflow-y-auto px-3 py-3"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-base">
        {specialSearchResults.map((option, index) =>
          renderMobileSpecialOption(
            option,
            index < specialSearchResults.length - 1 || searchResults.length > 0
          )
        )}
        {searchResults.map((model, index) =>
          renderMobileModelOption(model, true, index !== searchResults.length - 1)
        )}
        {specialSearchResults.length === 0 && searchResults.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-text-muted">{labels.noMatch}</div>
        )}
      </div>
    </div>
  )

  const renderMobileCascade = () => (
    <div
      data-testid="model-mobile-cascade"
      className="max-h-[min(58vh,420px)] overflow-y-auto px-3 py-3"
    >
      {mobileStep === 'secondary'
        ? renderMobileSecondaryGroups()
        : mobileStep === 'models'
          ? renderMobileModels()
          : renderMobilePrimaryGroups()}
    </div>
  )

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden bg-base',
        variant === 'mobile'
          ? 'max-h-[min(72vh,560px)] w-full min-w-0'
          : 'max-h-[min(520px,var(--radix-popover-content-available-height))] w-[min(760px,calc(100vw-32px))]',
        className
      )}
    >
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <Input
            value={searchValue}
            onChange={event => onSearchValueChange(event.target.value)}
            placeholder={labels.searchPlaceholder}
            data-testid="model-cascade-search-input"
            className="h-9 bg-surface pl-9"
          />
        </div>
      </div>

      {models.length === 0 && specialOptions.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-text-muted">{labels.noModels}</div>
      ) : isSearching ? (
        variant === 'mobile' ? (
          renderMobileSearchResults()
        ) : (
          <ScrollArea
            data-testid="model-cascade-search-results"
            className="h-[clamp(120px,calc(var(--radix-popover-content-available-height,520px)-112px),360px)] min-h-0"
          >
            <div className="px-2 py-2">
              <div className="px-2 pb-1 text-xs font-medium text-text-muted">
                {labels.searchResults}
              </div>
              {specialSearchResults.map(renderSpecialOption)}
              {searchResults.map(model => renderModelOption(model, true))}
              {specialSearchResults.length === 0 && searchResults.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-text-muted">
                  {labels.noMatch}
                </div>
              )}
            </div>
          </ScrollArea>
        )
      ) : variant === 'mobile' ? (
        renderMobileCascade()
      ) : (
        <div
          data-testid="model-cascade-grid"
          className="grid h-[clamp(120px,calc(var(--radix-popover-content-available-height,520px)-112px),360px)] min-h-0 grid-cols-[180px_200px_minmax(260px,1fr)] overflow-hidden"
        >
          <ScrollArea className="border-r border-border">
            <div className="px-2 py-2">
              <div className="px-2 pb-1 text-xs font-medium text-text-muted">
                {labels.primaryGroups}
              </div>
              {specialOptions.map(renderSpecialOption)}
              {groups.map(group => {
                const isActive = group.name === activeGroup?.name

                return (
                  <button
                    key={group.name}
                    type="button"
                    data-testid={`model-primary-group-${sanitizeTestId(group.name)}`}
                    onClick={() => {
                      setActiveGroupName(group.name)
                      setActiveSubGroupName(group.subGroups[0]?.name ?? '')
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left',
                      'hover:bg-hover focus:bg-hover focus:outline-none',
                      isActive && 'bg-primary/10 text-primary'
                    )}
                  >
                    <span className="min-w-0 truncate text-sm font-medium">{group.name}</span>
                    <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                      {getGroupCountLabel(group.count)}
                    </span>
                  </button>
                )
              })}
            </div>
          </ScrollArea>

          <ScrollArea className="border-r border-border">
            <div className="px-2 py-2">
              <div className="px-2 pb-1 text-xs font-medium text-text-muted">
                {labels.secondaryGroups}
              </div>
              {activeGroup?.subGroups.map(subGroup => {
                const isActive = subGroup.name === activeSubGroup?.name

                return (
                  <button
                    key={subGroup.name}
                    type="button"
                    data-testid={`model-secondary-group-${sanitizeTestId(subGroup.name)}`}
                    onClick={() => setActiveSubGroupName(subGroup.name)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left',
                      'hover:bg-hover focus:bg-hover focus:outline-none',
                      isActive && 'bg-primary/10 text-primary'
                    )}
                  >
                    <span className="min-w-0 truncate text-sm font-medium">{subGroup.name}</span>
                    <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
                      {getGroupCountLabel(subGroup.count)}
                    </span>
                  </button>
                )
              })}
            </div>
          </ScrollArea>

          <ScrollArea>
            <div className="px-2 py-2">
              {activeSubGroup?.models.map(model => renderModelOption(model, false))}
            </div>
          </ScrollArea>
        </div>
      )}

      {footer && (
        <div data-testid="model-cascade-footer" className="shrink-0 border-t border-border">
          {footer}
        </div>
      )}
    </div>
  )
}

export function GroupedModelSelect<T extends GroupableModel>({
  models,
  selectedModel,
  selectedSpecialKey,
  specialOptions,
  labels,
  onSelectModel,
  onSelectSpecialOption,
  getModelKey = defaultModelKey,
  renderModelBadges,
  renderModelMeta,
  renderModelActions,
  footer,
  placeholder,
  disabled,
  triggerClassName,
  contentClassName,
  dataTestId = 'grouped-model-select',
  align = 'start',
  variant,
}: GroupedModelSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')

  useEffect(() => {
    if (!open) {
      setSearchValue('')
    }
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid={dataTestId}
          className={cn('h-10 w-full justify-between bg-base px-3 font-normal', triggerClassName)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">
              {selectedModel ? getModelDisplayName(selectedModel) : placeholder}
            </span>
            {selectedModel && <ModelCapabilityIcons model={selectedModel} />}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          'w-auto overflow-hidden rounded-xl border border-border p-0 shadow-xl',
          contentClassName
        )}
      >
        <ModelCascadeContent
          models={models}
          selectedModel={selectedModel}
          selectedSpecialKey={selectedSpecialKey}
          specialOptions={specialOptions}
          labels={labels}
          searchValue={searchValue}
          onSearchValueChange={setSearchValue}
          onSelectModel={model => {
            onSelectModel(model)
            setOpen(false)
          }}
          onSelectSpecialOption={
            onSelectSpecialOption
              ? key => {
                  onSelectSpecialOption(key)
                  setOpen(false)
                }
              : undefined
          }
          getModelKey={getModelKey}
          renderModelBadges={renderModelBadges}
          renderModelMeta={renderModelMeta}
          renderModelActions={renderModelActions}
          footer={footer}
          variant={variant}
        />
      </PopoverContent>
    </Popover>
  )
}
