// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Building2, Check, ChevronDown, User, Users } from 'lucide-react'
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
import type { AvailableGroup } from './CreateKnowledgeBaseDialog'

const SPACE_ICONS = { personal: User, group: Users, organization: Building2 }

export function KnowledgeCreateSpaceSelect({
  spaces,
  value,
  onValueChange,
}: {
  spaces: AvailableGroup[]
  value: string
  onValueChange: (value: string) => void
}) {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase()
  const allowedSpaces = spaces.filter(space => space.canCreate)
  const selected = allowedSpaces.find(space => space.id === value)
  const visibleSpaces = allowedSpaces.filter(
    space =>
      space.displayName.toLocaleLowerCase().includes(query) ||
      space.name.toLocaleLowerCase().includes(query)
  )
  const SpaceIcon = selected ? SPACE_ICONS[selected.type] : User

  return (
    <Popover
      modal
      open={open}
      onOpenChange={next => {
        if (next) setSearch('')
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          role="combobox"
          variant="outline"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={t('document.navigation.space')}
          data-testid="group-selector"
          className="min-h-11 min-w-11 w-full justify-between bg-base px-3 font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected && <SpaceIcon className="h-4 w-4 shrink-0" />}
            <span className="truncate">
              {selected?.displayName || t('document.navigation.space')}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
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
            data-testid="create-space-search"
            className="min-h-11"
          />
          <CommandList className="min-h-0 max-h-64 flex-1">
            <CommandEmpty>{t('document.creation.noMatchingSpaces')}</CommandEmpty>
            <div className="p-1">
              {visibleSpaces.map(space => {
                const Icon = SPACE_ICONS[space.type]
                return (
                  <CommandItem
                    key={space.id}
                    value={space.id}
                    data-testid={`create-space-option-${space.id}`}
                    className="min-h-11"
                    onSelect={() => {
                      onValueChange(space.id)
                      setOpen(false)
                    }}
                  >
                    <Check className={value === space.id ? 'text-primary' : 'opacity-0'} />
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="break-words [overflow-wrap:anywhere]">
                        {space.displayName}
                      </span>
                      {space.type !== 'personal' && space.displayName !== space.name && (
                        <span className="break-all text-xs text-text-muted">{space.name}</span>
                      )}
                    </span>
                  </CommandItem>
                )
              })}
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
