// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { useMediaQuery } from '@/hooks/useMediaQuery';

export interface SearchableSelectItem {
  value: string;
  label: string;
  searchText?: string; // Optional custom search text
  disabled?: boolean;
  content?: React.ReactNode; // Custom content for the item
}

interface SearchableSelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  onSearchChange?: (value: string) => void; // Callback for search text changes (for server-side search)
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  items: SearchableSelectItem[];
  loading?: boolean;
  error?: string | null;
  emptyText?: string;
  noMatchText?: string;
  className?: string;
  contentClassName?: string;
  triggerClassName?: string;
  renderTriggerValue?: (item: SearchableSelectItem | undefined) => React.ReactNode;
  footer?: React.ReactNode;
  showChevron?: boolean; // Whether to show chevron icon
  title?: string; // Title for mobile drawer
}

export function SearchableSelect({
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
  contentClassName,
  triggerClassName,
  renderTriggerValue,
  footer,
  showChevron = false,
  title,
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [searchValue, setSearchValue] = React.useState('');
  const isMobile = useMediaQuery('(max-width: 767px)');

  // Find selected item
  const selectedItem = React.useMemo(() => {
    return items.find(item => item.value === value);
  }, [items, value]);

  const handleSelect = (currentValue: string) => {
    onValueChange?.(currentValue);
    setIsOpen(false);
  };

  const handleSearchValueChange = (search: string) => {
    setSearchValue(search);
    onSearchChange?.(search);
  };

  // Reset search when popover closes
  React.useEffect(() => {
    if (!isOpen) {
      setSearchValue('');
      onSearchChange?.('');
    }
  }, [isOpen, onSearchChange]);

  // Shared command content for both Popover and Drawer
  const renderCommandContent = () => (
    <Command className="border-0" shouldFilter={!onSearchChange}>
      <CommandInput
        placeholder={searchPlaceholder}
        value={searchValue}
        onValueChange={handleSearchValueChange}
        className={cn(
          'h-9 rounded-none border-b border-border',
          'placeholder:text-text-muted text-sm'
        )}
      />
      <CommandList className={cn('overflow-y-auto', isMobile ? 'max-h-[50vh]' : 'max-h-[300px]')}>
        {error ? (
          <div className="py-4 px-3 text-center text-sm text-error">{error}</div>
        ) : items.length === 0 ? (
          <CommandEmpty className="py-4 text-center text-sm text-text-muted">
            {loading ? 'Loading...' : emptyText}
          </CommandEmpty>
        ) : (
          <>
            <CommandEmpty className="py-4 text-center text-sm text-text-muted">
              {noMatchText}
            </CommandEmpty>
            <CommandGroup>
              {items.map(item => (
                <CommandItem
                  key={item.value}
                  value={item.searchText || item.label}
                  disabled={item.disabled}
                  onSelect={() => handleSelect(item.value)}
                  className={cn(
                    'group cursor-pointer select-none',
                    'px-3 py-2 text-sm text-text-primary',
                    'rounded-md mx-1 my-[2px]',
                    'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                    'aria-selected:bg-hover',
                    'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
                    '!flex !flex-row !items-start !gap-3'
                  )}
                >
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0 mt-0.5 ml-1',
                      value === item.value ? 'opacity-100 text-primary' : 'opacity-0 text-text-muted'
                    )}
                  />
                  {item.content ? (
                    <div className="flex-1 min-w-0">{item.content}</div>
                  ) : (
                    <span
                      className="flex-1 break-all whitespace-pre-wrap"
                      style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                    >
                      {item.label}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );

  // Trigger button component
  const triggerButton = (
    <button
      type="button"
      role="combobox"
      aria-expanded={isOpen}
      aria-controls="searchable-select-popover"
      disabled={disabled}
      onClick={() => !disabled && setIsOpen(true)}
      className={cn(
        'flex h-9 w-full min-w-0 items-center justify-between rounded-lg border text-left',
        'border-border bg-base px-3 text-xs text-text-muted',
        'shadow-sm hover:bg-hover transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-primary/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        triggerClassName
      )}
    >
      <div className="flex-1 min-w-0">
        {selectedItem && renderTriggerValue ? (
          renderTriggerValue(selectedItem)
        ) : (
          <span className="truncate block">{selectedItem ? selectedItem.label : placeholder}</span>
        )}
      </div>
      {showChevron && <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
    </button>
  );

  return (
    <div className={className}>
      {/* Mobile: Use Drawer */}
      {isMobile ? (
        <>
          {triggerButton}
          <Drawer open={isOpen} onOpenChange={setIsOpen}>
            <DrawerContent className="max-h-[85vh]">
              {title && (
                <DrawerHeader className="pb-2">
                  <DrawerTitle>{title}</DrawerTitle>
                </DrawerHeader>
              )}
              <div className="px-2 pb-4">
                {renderCommandContent()}
                {footer}
              </div>
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        /* Desktop: Use Popover */
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
          <PopoverContent
            className={cn(
              'p-0 w-auto min-w-[var(--radix-popover-trigger-width)] max-w-[90vw] border border-border bg-base',
              'shadow-xl rounded-xl overflow-hidden',
              contentClassName
            )}
            align="start"
            sideOffset={4}
          >
            {renderCommandContent()}
            {footer}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
