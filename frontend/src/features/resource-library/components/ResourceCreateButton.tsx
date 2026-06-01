// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Building2, ChevronRight, UserRound } from 'lucide-react'
import { PlusIcon } from '@heroicons/react/24/outline'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { Group } from '@/types/group'
import type { ManagedResourceSourceFilter } from '../types'

export interface ResourceCreateTarget {
  scope: 'personal' | 'group'
  groupName?: string
}

interface ResourceCreateButtonProps {
  label: string
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
  onCreate: (target: ResourceCreateTarget) => void
  'data-testid'?: string
}

function canCreateInGroup(group: Group): boolean {
  return group.my_role === 'Owner' || group.my_role === 'Maintainer'
}

function getGroupLabel(group: Group): string {
  return group.display_name || group.name
}

function groupMatchesQuery(group: Group, query: string): boolean {
  if (!query) return true
  const normalizedQuery = query.toLowerCase()
  return (
    group.name.toLowerCase().includes(normalizedQuery) ||
    (group.display_name || '').toLowerCase().includes(normalizedQuery)
  )
}

export function hasResourceCreateTargets({
  scope = 'personal',
  groupName,
  sourceFilter = 'all',
  groups = [],
}: Pick<ResourceCreateButtonProps, 'scope' | 'groupName' | 'sourceFilter' | 'groups'>): boolean {
  if (sourceFilter === 'system') {
    return false
  }

  if (scope === 'personal' || sourceFilter === 'personal') {
    return true
  }

  const writableGroups = groups.filter(canCreateInGroup)
  if (scope === 'group' && groupName) {
    return writableGroups.some(group => group.name === groupName)
  }

  return scope === 'all' || sourceFilter === 'all' || writableGroups.length > 0
}

export function ResourceCreateButton({
  label,
  scope = 'personal',
  groupName,
  sourceFilter = 'all',
  groups = [],
  onCreate,
  'data-testid': testId = 'resource-create-button',
}: ResourceCreateButtonProps) {
  const { t } = useTranslation('resource-library')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [groupQuery, setGroupQuery] = useState('')
  const writableGroups = useMemo(() => groups.filter(canCreateInGroup), [groups])
  const selectedWritableGroup = groupName
    ? writableGroups.find(group => group.name === groupName)
    : undefined

  if (sourceFilter === 'system') {
    return null
  }

  const handleOpenChange = (open: boolean) => {
    setPickerOpen(open)
    if (!open) {
      setGroupQuery('')
    }
  }

  const handleCreate = (target: ResourceCreateTarget) => {
    handleOpenChange(false)
    onCreate(target)
  }

  if (scope === 'personal' || sourceFilter === 'personal') {
    return (
      <CreateButton
        label={label}
        onClick={() => onCreate({ scope: 'personal' })}
        data-testid={testId}
      />
    )
  }

  if (scope === 'group' && selectedWritableGroup) {
    return (
      <CreateButton
        label={label}
        onClick={() => onCreate({ scope: 'group', groupName: selectedWritableGroup.name })}
        data-testid={testId}
      />
    )
  }

  const includePersonalTarget = scope === 'all' || sourceFilter === 'all'
  const groupTargets =
    scope === 'group' || sourceFilter === 'group' || sourceFilter === 'all' ? writableGroups : []
  const filteredGroups = groupTargets.filter(group => groupMatchesQuery(group, groupQuery))

  if (!includePersonalTarget && groupTargets.length === 0) {
    return null
  }

  return (
    <>
      <CreateButton label={label} onClick={() => handleOpenChange(true)} data-testid={testId} />
      <Dialog open={pickerOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="gap-4 p-5 sm:max-w-[520px]">
          <DialogHeader className="space-y-1">
            <DialogTitle className="text-lg">
              {t('actions.choose_create_target', { action: label })}
            </DialogTitle>
            <DialogDescription className="text-sm text-text-secondary">
              {t('actions.choose_create_target_description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {includePersonalTarget && (
              <TargetSection title={t('targets.personal_section')}>
                <div className="overflow-hidden rounded-lg border border-border">
                  <TargetRow
                    icon={<UserRound className="h-5 w-5" aria-hidden />}
                    label={t('targets.personal')}
                    description={t('targets.personal_description')}
                    selectLabel={t('targets.select')}
                    onClick={() => handleCreate({ scope: 'personal' })}
                    data-testid={`${testId}-personal-option`}
                  />
                </div>
              </TargetSection>
            )}

            {groupTargets.length > 0 && (
              <TargetSection title={t('targets.group_section')}>
                <Input
                  value={groupQuery}
                  onChange={event => setGroupQuery(event.target.value)}
                  placeholder={t('search.groups_placeholder')}
                  className="h-9 px-3 py-2"
                  data-testid={`${testId}-group-search`}
                />
                <div className="mt-2 max-h-[260px] overflow-y-auto rounded-lg border border-border">
                  {filteredGroups.length > 0 ? (
                    filteredGroups.map(group => (
                      <TargetRow
                        key={group.name}
                        icon={<Building2 className="h-5 w-5" aria-hidden />}
                        label={getGroupLabel(group)}
                        description={t('targets.group_description')}
                        selectLabel={t('targets.select')}
                        onClick={() => handleCreate({ scope: 'group', groupName: group.name })}
                        data-testid={`${testId}-group-option-${group.name}`}
                      />
                    ))
                  ) : (
                    <div className="px-3 py-6 text-center text-sm text-text-muted">
                      {t('search.groups_empty')}
                    </div>
                  )}
                </div>
              </TargetSection>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TargetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-text-muted">{title}</h3>
      {children}
    </section>
  )
}

function TargetRow({
  icon,
  label,
  description,
  selectLabel,
  onClick,
  'data-testid': testId,
}: {
  icon: ReactNode
  label: string
  description: string
  selectLabel: string
  onClick: () => void
  'data-testid': string
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex min-h-14 w-full items-center gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary'
      )}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="flex-shrink-0 text-text-secondary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{label}</span>
        <span className="block truncate text-xs text-text-muted">{description}</span>
      </span>
      <span className="flex flex-shrink-0 items-center gap-1 text-xs text-text-muted">
        {selectLabel}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </span>
    </button>
  )
}

function CreateButton({
  label,
  onClick,
  'data-testid': testId,
}: {
  label: string
  onClick: () => void
  'data-testid': string
}) {
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      className="flex items-center gap-2"
      onClick={onClick}
      data-testid={testId}
    >
      <PlusIcon className="h-4 w-4" aria-hidden />
      {label}
    </Button>
  )
}
