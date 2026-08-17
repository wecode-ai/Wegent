// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Globe2, UserRound, UsersRound } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import type { Group } from '@/types/group'

export type CapabilityPublishTarget = 'personal' | 'team' | 'marketplace'

interface CapabilityScopeSelectorProps {
  value: CapabilityPublishTarget
  groups: Group[]
  groupName?: string
  groupNames?: string[]
  onChange: (value: CapabilityPublishTarget, groupName?: string, groupNames?: string[]) => void
  existingResource?: boolean
  multipleGroups?: boolean
}

export function CapabilityScopeSelector({
  value,
  groups,
  groupName,
  groupNames,
  onChange,
  existingResource = false,
  multipleGroups = false,
}: CapabilityScopeSelectorProps) {
  const { t } = useTranslation('resource-library')
  const selectedGroupNames = groupNames || (groupName ? [groupName] : [])

  const toggleGroup = (selectedGroupName: string, checked: boolean) => {
    const nextGroupNames = checked
      ? Array.from(new Set([...selectedGroupNames, selectedGroupName]))
      : selectedGroupNames.filter(name => name !== selectedGroupName)
    onChange('team', nextGroupNames[0], nextGroupNames)
  }

  return (
    <section className="space-y-4">
      <div className="flex w-full items-center gap-3">
        <h3 className="shrink-0 text-sm font-semibold text-text-primary">
          {t('new_capability.scope_title')}
        </h3>
        <div className="h-px flex-1 bg-border" aria-hidden />
      </div>
      <div className="space-y-3">
        <p className="mt-1 text-xs text-text-secondary">
          {t(
            existingResource
              ? 'new_capability.existing_scope_description'
              : 'new_capability.scope_description'
          )}
        </p>
        <div
          className="grid gap-2 sm:grid-cols-3"
          role="group"
          aria-label={t('new_capability.scope_title')}
        >
          {(
            [
              ['personal', UserRound],
              ['team', UsersRound],
              ['marketplace', Globe2],
            ] as const
          ).map(([target, Icon]) => (
            <Button
              key={target}
              type="button"
              variant={value === target ? 'primary' : 'outline'}
              className="h-11 min-w-[44px]"
              onClick={() => {
                if (target !== 'team') {
                  onChange(target)
                  return
                }
                const nextGroupNames =
                  selectedGroupNames.length > 0
                    ? selectedGroupNames
                    : multipleGroups
                      ? []
                      : groups[0]?.name
                        ? [groups[0].name]
                        : []
                onChange('team', nextGroupNames[0], nextGroupNames)
              }}
              aria-pressed={value === target}
              data-testid={`capability-scope-${target}`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t(`new_capability.scopes.${target}`)}
            </Button>
          ))}
        </div>
      </div>
      {value === 'team' && multipleGroups && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-text-primary">
              {t('new_capability.group')}
            </span>
            <span className="text-xs text-text-muted">
              {t('sources.selected_groups', { count: selectedGroupNames.length })}
            </span>
          </div>
          <div
            className="max-h-52 overflow-y-auto rounded-md border border-border bg-base"
            data-testid="capability-scope-groups"
          >
            {groups.map(group => (
              <label
                key={group.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-border/70 px-3 py-2 last:border-b-0"
              >
                <Checkbox
                  checked={selectedGroupNames.includes(group.name)}
                  onCheckedChange={checked => toggleGroup(group.name, Boolean(checked))}
                  data-testid={`capability-scope-group-${group.name}`}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text-primary">
                    {group.display_name || group.name}
                  </span>
                  {group.display_name && (
                    <span className="block truncate text-xs text-text-muted">{group.name}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {value === 'team' && !multipleGroups && (
        <label className="block space-y-2 text-sm font-medium" htmlFor="capability-scope-group">
          <span>{t('new_capability.group')}</span>
          <select
            id="capability-scope-group"
            value={groupName || ''}
            onChange={event => onChange('team', event.target.value)}
            className="h-11 w-full rounded-md border border-border bg-base px-3 font-normal"
            data-testid="capability-scope-group"
          >
            <option value="">{t('new_capability.select_group')}</option>
            {groups.map(group => (
              <option key={group.id} value={group.name}>
                {group.display_name || group.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  )
}
