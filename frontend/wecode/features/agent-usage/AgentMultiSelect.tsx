// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useWecodeTranslation } from '@wecode/i18n/useWecodeTranslation'
import { UsageAgent } from '@wecode/api/agent-usage'

export function agentUsageKey(agent: UsageAgent): string {
  return `${agent.owner_user_id}\u0000${agent.namespace}\u0000${agent.name}`
}

interface AgentMultiSelectProps {
  agents: UsageAgent[]
  selected: string[]
  onChange: (selected: string[]) => void
  onSearch: (query: string) => void
  onLoadMore: () => void
  hasMore: boolean
  loading?: boolean
}

export function AgentMultiSelect({
  agents,
  selected,
  onChange,
  onSearch,
  onLoadMore,
  hasMore,
  loading = false,
}: AgentMultiSelectProps) {
  const { t } = useWecodeTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const initialSearch = useRef(true)
  const allSelected = selected.length === 0

  useEffect(() => {
    if (initialSearch.current) {
      initialSearch.current = false
      return
    }
    const timer = setTimeout(() => onSearch(search), 300)
    return () => clearTimeout(timer)
  }, [onSearch, search])

  const toggle = (key: string) => {
    onChange(selected.includes(key) ? selected.filter(item => item !== key) : [...selected, key])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid="agent-usage-agent-select"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between bg-base font-normal text-text-primary"
        >
          <span className="truncate">
            {selected.length === 0
              ? t('agent_usage.all_agents')
              : t('agent_usage.selected_agents', { count: selected.length })}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0"
        onMouseLeave={() => setOpen(false)}
      >
        <Command>
          <CommandInput
            placeholder={t('agent_usage.search_agents')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList
            className="max-h-72"
            onScroll={event => {
              const target = event.currentTarget
              const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 40
              if (nearBottom && hasMore && !loading) onLoadMore()
            }}
          >
            <CommandEmpty>
              {loading ? t('agent_usage.searching') : t('agent_usage.no_matching_agents')}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t('agent_usage.all_agents')}
                onSelect={() => {
                  onChange([])
                  setOpen(true)
                }}
                className="gap-3 border-b border-border px-3 py-2.5"
              >
                <Checkbox checked={allSelected} tabIndex={-1} className="pointer-events-none" />
                <span className="font-medium">{t('agent_usage.all_agents')}</span>
              </CommandItem>
              {agents.map(agent => {
                const key = agentUsageKey(agent)
                return (
                  <CommandItem
                    key={key}
                    value={`${agent.name} ${agent.namespace} ${agent.author_name}`}
                    onSelect={() => {
                      toggle(key)
                      setOpen(true)
                    }}
                    className="gap-3 px-3 py-2.5"
                  >
                    <Checkbox
                      checked={selected.includes(key)}
                      tabIndex={-1}
                      className="pointer-events-none"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">{agent.name}</p>
                      <p className="truncate text-xs text-text-muted">{agent.namespace}</p>
                    </div>
                    <div className="ml-4 max-w-40 shrink-0 text-right">
                      <p className="text-[11px] text-text-muted">{t('agent_usage.author')}</p>
                      <p className="truncate text-xs text-text-secondary" title={agent.author_name}>
                        {agent.author_name}
                      </p>
                    </div>
                  </CommandItem>
                )
              })}
              {loading && (
                <div className="py-3 text-center text-xs text-text-muted">
                  {t('agent_usage.loading_more')}
                </div>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
