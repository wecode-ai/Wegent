// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  isSearching?: boolean
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus = true,
  isSearching = false,
}: SearchInputProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [localValue, setLocalValue] = useState(value)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Auto focus on mount
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoFocus])

  // Sync local value with prop
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // Handle input change with debounce
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      setLocalValue(newValue)

      // Clear existing timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      // Set new debounce timer (500ms)
      debounceTimerRef.current = setTimeout(() => {
        onChange(newValue)
      }, 500)
    },
    [onChange]
  )

  // Clear input
  const handleClear = useCallback(() => {
    setLocalValue('')
    onChange('')
    inputRef.current?.focus()
  }, [onChange])

  // Handle Enter key for immediate search
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        // Clear debounce timer and search immediately
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
        }
        onChange(localValue)
      }
    },
    [localValue, onChange]
  )

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  return (
    <div className="relative flex-1">
      <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 h-5 w-5 text-text-muted" />
      <input
        ref={inputRef}
        type="text"
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || t('search.placeholder')}
        className="w-full h-12 pl-12 pr-12 text-base bg-surface border border-border rounded-xl text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
        aria-label={t('search.title')}
      />
      {localValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-4 top-1/2 transform -translate-y-1/2 p-1 rounded-full hover:bg-muted transition-colors"
          aria-label={t('tasks.clear_search')}
        >
          <X className="h-4 w-4 text-text-muted" />
        </button>
      )}
      {isSearching && (
        <div className="absolute right-12 top-1/2 transform -translate-y-1/2">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  )
}
