// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { formatTime } from './utils'

function parseTimeInput(val: string): number | null {
  const parts = val.split(':')
  if (parts.length >= 2) {
    const mins = parseInt(parts[0], 10)
    const secs = parseFloat(parts[1])
    if (!isNaN(mins) && !isNaN(secs)) return mins * 60 + secs
  }
  const num = parseFloat(val)
  if (!isNaN(num)) return num
  return null
}

interface TimeInputProps {
  value: number
  onCommit: (value: number) => void
  label: string
  disabled?: boolean
  step?: number
  onFocus?: () => void
}

export function TimeInput({
  value,
  onCommit,
  label,
  disabled = false,
  step = 0.1,
  onFocus,
}: TimeInputProps) {
  const [editingValue, setEditingValue] = useState<string | null>(null)

  useEffect(() => {
    setEditingValue(null)
  }, [value])

  const displayValue = editingValue ?? formatTime(value)

  const handleCommit = useCallback(
    (rawValue: string) => {
      const seconds = parseTimeInput(rawValue)
      if (seconds !== null) {
        onCommit(seconds)
      }
      setEditingValue(null)
    },
    [onCommit]
  )

  const adjust = useCallback(
    (delta: number) => {
      const base = editingValue !== null ? parseTimeInput(editingValue) : value
      if (base !== null) {
        const newValue = Math.max(0, base + delta)
        onCommit(newValue)
      }
      setEditingValue(null)
    },
    [editingValue, onCommit, value]
  )

  return (
    <div className="flex-1 flex items-center gap-1 h-[26px] rounded border border-[#E6E6E6] bg-white px-2">
      <span
        className="text-[13px] text-text-muted whitespace-nowrap"
        style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
      >
        {label}
      </span>
      <input
        type="text"
        value={displayValue}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setEditingValue(e.target.value)
        }}
        onBlur={() => {
          if (editingValue !== null) {
            handleCommit(editingValue)
          }
        }}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            adjust(step)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            adjust(-step)
          } else if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
        className="w-full bg-transparent text-center text-xs text-text-primary outline-none focus:ring-1 focus:ring-[#FF8200] rounded"
        disabled={disabled}
        onFocus={onFocus}
      />
      <div className="flex flex-col gap-1">
        <button
          type="button"
          className="flex items-center justify-center hover:opacity-70 transition-opacity disabled:opacity-30"
          onClick={() => adjust(step)}
          disabled={disabled}
          tabIndex={-1}
        >
          <svg width="6" height="4" viewBox="0 0 6 4" fill="none">
            <path d="M3 0L6 4H0L3 0Z" fill="#939393" />
          </svg>
        </button>
        <button
          type="button"
          className="flex items-center justify-center hover:opacity-70 transition-opacity disabled:opacity-30"
          onClick={() => adjust(-step)}
          disabled={disabled}
          tabIndex={-1}
        >
          <svg width="6" height="4" viewBox="0 0 6 4" fill="none">
            <path d="M3 4L0 0H6L3 4Z" fill="#939393" />
          </svg>
        </button>
      </div>
    </div>
  )
}
