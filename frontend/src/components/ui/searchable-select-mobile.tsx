// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { Check, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchableSelectItem } from './searchable-select'

interface SearchableSelectMobileProps {
  value?: string
  onValueChange?: (value: string) => void
  onSearchChange?: (value: string) => void
  disabled?: boolean
  placeholder?: string
  searchPlaceholder?: string
  items: SearchableSelectItem[]
  loading?: boolean
  error?: string | null
  emptyText?: string
  noMatchText?: string
  className?: string
  triggerClassName?: string
  renderTriggerValue?: (item: SearchableSelectItem | undefined) => React.ReactNode
  footer?: React.ReactNode
  listFooter?: React.ReactNode
  showChevron?: boolean
  defaultOpen?: boolean
  drawerTitle?: string
}

/**
 * Mobile-optimized SearchableSelect using bottom drawer (iOS style)
 *
 * Uses Vaul drawer component for mobile-friendly selection:
 * - Bottom sheet presentation
 * - Touch-friendly item sizing (min 44px)
 * - Search input at top
 * - Safe area handling
 */
export function SearchableSelectMobile({
  value,
  onValueChange,
  onSearchChange,
  disabled,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  items,
  loading,
  error,
  emptyText = 'No items',
  noMatchText = 'No match',
  className,
  triggerClassName,
  renderTriggerValue,
  footer,
  listFooter,
  showChevron = false,
  defaultOpen = false,
  drawerTitle = 'Select an option',
}: SearchableSelectMobileProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen)
  const [searchValue, setSearchValue] = React.useState('')

  // Find selected item
  const selectedItem = React.useMemo(() => {
    return items.find(item => item.value === value)
  }, [items, value])

  // Filter items based on search
  const filteredItems = React.useMemo(() => {
    if (!searchValue) return items
    const lowerSearch = searchValue.toLowerCase()
    return items.filter(item => {
      const searchText = item.searchText || item.label
      return searchText.toLowerCase().includes(lowerSearch)
    })
  }, [items, searchValue])

  const handleSelect = (currentValue: string) => {
    onValueChange?.(currentValue)
    setIsOpen(false)
  }

  const handleSearchValueChange = (search: string) => {
    setSearchValue(search)
    onSearchChange?.(search)
  }

  // Reset search when drawer closes
  React.useEffect(() => {
    if (!isOpen) {
      setSearchValue('')
      onSearchChange?.('')
    }
  }, [isOpen, onSearchChange])

  return (
    <div className={className}>
      <Drawer open={isOpen} onOpenChange={setIsOpen}>
        {/* Trigger Button */}
        <button
          type="button"
          onClick={() => !disabled && setIsOpen(true)}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full min-w-0 items-center justify-between rounded-lg border text-left',
            'border-border bg-base px-3 text-xs text-text-muted',
            'shadow-sm active:bg-hover transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-primary/20',
            'disabled:cursor-not-allowed disabled:opacity-50',
            // Touch-friendly sizing on mobile
            'min-h-[44px]',
            triggerClassName
          )}
        >
          <div className="flex-1 min-w-0">
            {selectedItem && renderTriggerValue ? (
              renderTriggerValue(selectedItem)
            ) : (
              <span className="truncate block">
                {selectedItem ? selectedItem.label : placeholder}
              </span>
            )}
          </div>
          {showChevron && (
            <svg
              className="ml-2 h-4 w-4 shrink-0 opacity-50"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          )}
        </button>

        {/* Drawer Content */}
        <DrawerContent className="max-h-[85vh] pb-4 flex flex-col">
          <DrawerHeader className="border-b border-border px-4 pb-4 flex-shrink-0">
            <div className="flex items-center justify-between mb-3">
              <DrawerTitle className="text-lg font-semibold">{drawerTitle}</DrawerTitle>
              <DrawerClose asChild>
                <button
                  type="button"
                  className="rounded-full p-2 hover:bg-hover active:bg-muted transition-colors"
                  aria-label="Close"
                >
                  <X className="h-5 w-5 text-text-muted" />
                </button>
              </DrawerClose>
            </div>
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchValue}
                onChange={e => handleSearchValueChange(e.target.value)}
                className="pl-9 h-11 text-base"
              />
            </div>
          </DrawerHeader>

          {/* Items List */}
          <ScrollArea className="flex-1 overflow-y-auto min-h-0">
            <div className="px-2 py-2">
              {error ? (
                <div className="py-8 px-4 text-center text-sm text-error">{error}</div>
              ) : filteredItems.length === 0 ? (
                <div className="py-8 px-4 text-center text-sm text-text-muted">
                  {loading ? 'Loading...' : searchValue ? noMatchText : emptyText}
                </div>
              ) : (
                <>
                  {filteredItems.map(item => (
                    <button
                      key={item.value}
                      type="button"
                      disabled={item.disabled}
                      onClick={() => handleSelect(item.value)}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left',
                        'transition-colors',
                        'active:bg-primary/10',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        // Touch-friendly sizing
                        'min-h-[44px]',
                        value === item.value && 'bg-primary/10'
                      )}
                    >
                      <Check
                        className={cn(
                          'h-5 w-5 shrink-0',
                          value === item.value ? 'opacity-100 text-primary' : 'opacity-0'
                        )}
                      />
                      {item.content ? (
                        <div className="flex-1 min-w-0">{item.content}</div>
                      ) : (
                        <span className="flex-1 min-w-0 text-sm" title={item.label}>
                          {item.label}
                        </span>
                      )}
                    </button>
                  ))}
                  {listFooter}
                </>
              )}
            </div>
          </ScrollArea>

          {/* Footer */}
          {footer && <div className="border-t border-border flex-shrink-0">{footer}</div>}
        </DrawerContent>
      </Drawer>
    </div>
  )
}
