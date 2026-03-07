// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { SearchIcon } from './SearchIcon'
import { Input } from '@/components/ui/input'

interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

/**
 * Search box component
 * Unified search input with icon
 */
export function SearchBox({
  value,
  onChange,
  placeholder = 'Search...',
  className = '',
  size = 'md',
}: SearchBoxProps) {
  const sizeClasses = {
    sm: 'pl-8 pr-3 py-1.5 text-sm',
    md: 'pl-10 pr-3 py-2 text-base',
    lg: 'pl-10 pr-3 py-3 text-base',
  }

  const iconSizeClasses = {
    sm: 'left-2.5 h-4 w-4',
    md: 'left-3 h-5 w-5',
    lg: 'left-3 h-5 w-5',
  }

  return (
    <div className={`relative ${className}`}>
      <Input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`${sizeClasses[size]} focus-visible:ring-primary/40`}
      />
      <SearchIcon
        className={`absolute ${iconSizeClasses[size]} top-1/2 transform -translate-y-1/2 text-text-muted`}
      />
    </div>
  )
}
