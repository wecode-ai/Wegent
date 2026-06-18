// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { WheelEvent } from 'react'
import { Check, Table2 } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import type { TableDocument } from '@/apis/table'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface TableContextTabProps {
  tables: TableDocument[]
  loading: boolean
  error: string | null
  searchValue: string
  onSearchValueChange: (value: string) => void
  onRetry: () => void
  onSelectTable: (doc: TableDocument) => void
  isSelected: (id: number | string) => boolean
  onWheel: (event: WheelEvent<HTMLDivElement>) => void
}

export function TableContextTab({
  tables,
  loading,
  error,
  searchValue,
  onSearchValueChange,
  onRetry,
  onSelectTable,
  isSelected,
  onWheel,
}: TableContextTabProps) {
  const { t } = useTranslation()

  return (
    <Command className="border-0 flex flex-col">
      <CommandInput
        placeholder={t('knowledge:search_placeholder')}
        value={searchValue}
        onValueChange={onSearchValueChange}
        className={cn(
          'h-9 rounded-none border-b border-border flex-shrink-0',
          'placeholder:text-text-muted text-sm'
        )}
      />
      <CommandList className="max-h-[300px] overflow-y-auto" onWheel={onWheel}>
        {loading ? (
          <div className="py-4 px-3 text-center text-sm text-text-muted">
            {t('common:actions.loading')}
          </div>
        ) : error ? (
          <div className="py-4 px-3 text-center">
            <p className="text-sm text-red-500 mb-2">{error}</p>
            <button onClick={onRetry} className="text-xs text-primary hover:underline">
              {t('common:actions.retry')}
            </button>
          </div>
        ) : tables.length === 0 ? (
          <div className="py-6 px-4 text-center">
            <p className="text-sm text-text-muted mb-2">{t('knowledge:table.empty')}</p>
            <p className="text-xs text-text-muted">{t('knowledge:table.emptyHint')}</p>
          </div>
        ) : (
          <>
            <CommandEmpty className="py-4 text-center text-sm text-text-muted">
              {t('common:branches.no_match')}
            </CommandEmpty>
            <CommandGroup>
              {tables.map(doc => {
                const tableContextId = `table-${doc.id}`
                const selected = isSelected(tableContextId)

                return (
                  <CommandItem
                    key={`table-${doc.id}`}
                    value={`${doc.name} ${doc.id}`}
                    onSelect={() => onSelectTable(doc)}
                    className={cn(
                      'group cursor-pointer select-none',
                      'px-3 py-2 text-sm text-text-primary',
                      'rounded-md mx-1 my-[2px]',
                      'data-[selected=true]:bg-blue-500/10 data-[selected=true]:text-blue-600',
                      'aria-selected:bg-hover',
                      '!flex !flex-row !items-start !justify-between !gap-2'
                    )}
                  >
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <Table2 className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                      <div className="flex flex-col min-w-0 flex-1">
                        <span
                          className="font-medium text-sm text-text-primary truncate"
                          title={doc.name}
                        >
                          {doc.name}
                        </span>
                        {doc.source_config?.url && (
                          <span
                            className="text-xs text-text-muted truncate"
                            title={doc.source_config.url}
                          >
                            {formatTableSourceUrl(doc.source_config.url)}
                          </span>
                        )}
                      </div>
                    </div>
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 mt-0.5',
                        selected ? 'opacity-100 text-blue-500' : 'opacity-0'
                      )}
                    />
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  )
}

function formatTableSourceUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
