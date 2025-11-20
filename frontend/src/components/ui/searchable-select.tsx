// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  showChevron?: boolean; // 是否显示下箭头图标
}

export function SearchableSelect({
  value,
  onValueChange,
  disabled,
  placeholder,
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
  showChevron = false, // 默认隐藏下箭头
}: SearchableSelectProps) {
  const [searchText, setSearchText] = React.useState('');
  const [isOpen, setIsOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const triggerRef = React.useRef<HTMLDivElement>(null);

  // Filter items based on search text
  const filteredItems = React.useMemo(() => {
    if (!searchText.trim()) {
      return items;
    }
    const lowerSearch = searchText.toLowerCase();
    return items.filter(item => {
      const textToSearch = item.searchText || item.label;
      return textToSearch.toLowerCase().includes(lowerSearch);
    });
  }, [items, searchText]);

  // Find selected item
  const selectedItem = React.useMemo(() => {
    return items.find(item => item.value === value);
  }, [items, value]);

  // Reset search when dropdown closes
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setSearchText('');
    } else {
      // Focus input when opening
      setTimeout(() => {
        inputRef.current?.focus();
      }, 10);
    }
  };

  const handleSelect = (newValue: string) => {
    onValueChange?.(newValue);
    setIsOpen(false);
    setSearchText('');
  };

  return (
    <div className={className}>
      <PopoverPrimitive.Root open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverPrimitive.Anchor asChild>
          <div
            ref={triggerRef}
            className={cn('flex items-center justify-between w-full', 'text-sm', triggerClassName)}
          >
            {isOpen ? (
              <Input
                ref={inputRef}
                placeholder={searchPlaceholder}
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="h-auto py-0 px-0 border-0 shadow-none focus-visible:ring-0 flex-1"
                disabled={disabled}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setIsOpen(false);
                  }
                }}
              />
            ) : (
              <PopoverPrimitive.Trigger asChild>
                <button
                  type="button"
                  role="combobox"
                  aria-expanded={isOpen}
                  disabled={disabled}
                  title={selectedItem ? selectedItem.label : undefined}
                  className={cn(
                    'flex-1 truncate text-left pl-2 text-text-secondary font-light',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  {selectedItem && renderTriggerValue ? (
                    renderTriggerValue(selectedItem)
                  ) : selectedItem ? (
                    selectedItem.label
                  ) : (
                    <span className="text-text-muted ml-4">{placeholder}</span>
                  )}
                </button>
              </PopoverPrimitive.Trigger>
            )}
            {showChevron && (
              <ChevronDown className="h-4 w-4 opacity-50 ml-1 flex-shrink-0 pointer-events-none" />
            )}
          </div>
        </PopoverPrimitive.Anchor>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            sideOffset={4}
            onOpenAutoFocus={e => {
              e.preventDefault();
              inputRef.current?.focus();
            }}
            className={cn(
              'z-50 w-full min-w-[200px] overflow-hidden rounded-md border border-border bg-base shadow-md',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
              contentClassName
            )}
          >
            <div className="max-h-[300px] overflow-y-auto">
              <div className="p-1">
                {error ? (
                  <div
                    className="px-2 py-1.5 text-sm text-left font-light"
                    style={{ color: 'rgb(var(--color-error))' }}
                  >
                    {error}
                  </div>
                ) : items.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-text-muted text-left font-light">
                    {loading ? 'Loading...' : emptyText}
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-text-muted text-left font-light">
                    {noMatchText}
                  </div>
                ) : (
                  filteredItems.map(item => (
                    <button
                      key={item.value}
                      type="button"
                      disabled={item.disabled}
                      onClick={() => handleSelect(item.value)}
                      title={item.label}
                      className={cn(
                        'relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none font-light',
                        'hover:bg-muted focus:bg-muted',
                        'disabled:pointer-events-none disabled:opacity-50',
                        value === item.value && 'bg-muted'
                      )}
                    >
                      {value === item.value && <Check className="mr-2 h-4 w-4 flex-shrink-0" />}
                      <div className="flex-1 truncate text-left">{item.content || item.label}</div>
                    </button>
                  ))
                )}
              </div>
            </div>
            {footer}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}
