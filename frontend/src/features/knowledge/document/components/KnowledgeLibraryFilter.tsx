// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronDown, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/hooks/useTranslation'
import { COMPANY_SPACE_FILTER, PERSONAL_SPACE_FILTER } from '../navigation'

export interface KnowledgeTeamOption {
  id: string
  name: string
  displayName: string
  kbCount: number
}

export function KnowledgeLibraryFilter({
  groups,
  personalCount,
  companyCount,
  value,
  onValueChange,
  mobile,
}: {
  groups: KnowledgeTeamOption[]
  personalCount: number
  companyCount?: number
  value: string | null
  onValueChange: (value: string | null) => void
  mobile: boolean
}) {
  const { t } = useTranslation('knowledge')
  const router = useRouter()
  const manageRequested = useRef(false)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase()
  const spaces = [
    {
      id: PERSONAL_SPACE_FILTER,
      key: 'personal',
      displayName: t('document.navigation.personalSpace'),
      kbCount: personalCount,
    },
    ...(companyCount === undefined
      ? []
      : [
          {
            id: COMPANY_SPACE_FILTER,
            key: 'company',
            displayName: t('document.navigation.companySpace'),
            kbCount: companyCount,
          },
        ]),
  ]
  const selected = [...spaces, ...groups].find(option => option.id === value)
  const anyScope = t('document.navigation.anyScope')
  const visibleGroups = groups.filter(group =>
    query
      ? group.displayName.toLocaleLowerCase().includes(query) ||
        group.name.toLocaleLowerCase().includes(query)
      : group.kbCount > 0
  )
  const select = (next: string | null) => {
    onValueChange(next)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (next) setSearch('')
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          role="combobox"
          variant="outline"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={t('document.navigation.libraryFilter')}
          data-testid="knowledge-team-filter"
          className={`${mobile ? 'min-h-11 min-w-11 w-full' : 'h-9 w-64'} max-w-full justify-between bg-base px-3 font-normal`}
        >
          <span className="min-w-0 truncate">
            {value ? selected?.displayName || value : t('document.navigation.filters')}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {selected && (
              <span className="text-xs tabular-nums text-text-muted">{selected.kbCount}</span>
            )}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        onCloseAutoFocus={event => {
          if (manageRequested.current) {
            event.preventDefault()
            manageRequested.current = false
            router.push('/settings?tab=group-manager')
          }
        }}
        className="flex max-h-[min(20rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
      >
        <Command
          shouldFilter={false}
          label={t('document.navigation.searchLibraryFilters')}
          className="h-auto min-h-0 flex-1 [&_[cmdk-input-wrapper]]:shrink-0"
        >
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t('document.navigation.searchLibraryFilters')}
            aria-label={t('document.navigation.searchLibraryFilters')}
            data-testid="knowledge-team-search"
            className="min-h-11"
          />
          <CommandList className="min-h-0 max-h-64 flex-1">
            <CommandEmpty>{t('document.navigation.noMatchingFilters')}</CommandEmpty>
            <div className="p-1">
              {(!query || anyScope.toLocaleLowerCase().includes(query)) && (
                <CommandItem
                  value="all"
                  data-testid="knowledge-team-option-all"
                  data-current={value === null}
                  className="min-h-11"
                  onSelect={() => select(null)}
                >
                  <Check className={value === null ? 'text-primary' : 'opacity-0'} />
                  {anyScope}
                </CommandItem>
              )}
              {spaces
                .filter(space => !query || space.displayName.toLocaleLowerCase().includes(query))
                .map(space => (
                  <CommandItem
                    key={space.id}
                    value={space.id}
                    data-testid={`knowledge-space-option-${space.key}`}
                    data-current={value === space.id}
                    className="min-h-11"
                    onSelect={() => select(space.id)}
                  >
                    <Check className={value === space.id ? 'text-primary' : 'opacity-0'} />
                    <span className="min-w-0 flex-1">{space.displayName}</span>
                    <span
                      className="shrink-0 text-xs tabular-nums text-text-muted"
                      data-testid={`knowledge-space-count-${space.key}`}
                    >
                      {space.kbCount}
                    </span>
                  </CommandItem>
                ))}
              {visibleGroups.map(group => (
                <CommandItem
                  key={group.id}
                  value={group.id}
                  data-testid={`knowledge-team-option-${group.id}`}
                  data-current={value === group.id}
                  className="min-h-11"
                  onSelect={() => select(group.id)}
                >
                  <Check className={value === group.id ? 'text-primary' : 'opacity-0'} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="break-words [overflow-wrap:anywhere]">
                      {group.displayName}
                    </span>
                    {group.displayName !== group.name && (
                      <span className="break-all text-xs text-text-muted">{group.name}</span>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-xs tabular-nums text-text-muted"
                    aria-label={t('document.navigation.teamKnowledgeCount', {
                      count: group.kbCount,
                    })}
                    data-testid={`knowledge-team-count-${group.id}`}
                  >
                    {group.kbCount}
                  </span>
                </CommandItem>
              ))}
            </div>
          </CommandList>
        </Command>
        <div className="shrink-0 border-t border-border p-1">
          <Button asChild variant="ghost" className="min-h-11 min-w-11 w-full justify-start">
            <a
              href="/settings?tab=group-manager"
              data-testid="knowledge-manage-teams"
              onClick={event => {
                event.preventDefault()
                manageRequested.current = true
                setOpen(false)
              }}
            >
              <Settings className="h-4 w-4" />
              {t('document.navigation.manageTeams')}
            </a>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
