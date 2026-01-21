// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { CalendarIcon, ChevronDownIcon, Check } from 'lucide-react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface DateTimePickerProps {
  value?: Date
  onChange?: (date: Date | undefined) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

// Generate hour options (00-23)
const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'))

// Generate minute options (00-59)
const minutes = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0'))

export function DateTimePicker({
  value,
  onChange,
  placeholder = '选择日期和时间',
  disabled = false,
  className,
}: DateTimePickerProps) {
  const [open, setOpen] = React.useState(false)

  // Internal state for pending selection
  const [pendingDate, setPendingDate] = React.useState<Date | undefined>(value)
  const [pendingHour, setPendingHour] = React.useState<string>(
    value ? value.getHours().toString().padStart(2, '0') : '09'
  )
  const [pendingMinute, setPendingMinute] = React.useState<string>(
    value ? value.getMinutes().toString().padStart(2, '0') : '00'
  )

  // Sync internal state when value changes externally
  React.useEffect(() => {
    if (value) {
      setPendingDate(value)
      setPendingHour(value.getHours().toString().padStart(2, '0'))
      setPendingMinute(value.getMinutes().toString().padStart(2, '0'))
    }
  }, [value])

  // Reset pending state when popover opens
  React.useEffect(() => {
    if (open) {
      if (value) {
        setPendingDate(value)
        setPendingHour(value.getHours().toString().padStart(2, '0'))
        setPendingMinute(value.getMinutes().toString().padStart(2, '0'))
      } else {
        // Default to today at 09:00
        const today = new Date()
        today.setHours(9, 0, 0, 0)
        setPendingDate(today)
        setPendingHour('09')
        setPendingMinute('00')
      }
    }
  }, [open, value])

  // Handle date selection from calendar
  const handleDateSelect = (date: Date | undefined) => {
    if (!date) {
      setPendingDate(undefined)
      return
    }
    // Preserve the pending time when selecting a new date
    const newDate = new Date(date)
    newDate.setHours(parseInt(pendingHour), parseInt(pendingMinute), 0, 0)
    setPendingDate(newDate)
  }

  // Handle hour change
  const handleHourChange = (hour: string) => {
    setPendingHour(hour)
    if (pendingDate) {
      const newDate = new Date(pendingDate)
      newDate.setHours(parseInt(hour))
      setPendingDate(newDate)
    } else {
      const newDate = new Date()
      newDate.setHours(parseInt(hour), parseInt(pendingMinute), 0, 0)
      setPendingDate(newDate)
    }
  }

  // Handle minute change
  const handleMinuteChange = (minute: string) => {
    setPendingMinute(minute)
    if (pendingDate) {
      const newDate = new Date(pendingDate)
      newDate.setMinutes(parseInt(minute))
      setPendingDate(newDate)
    } else {
      const newDate = new Date()
      newDate.setHours(parseInt(pendingHour), parseInt(minute), 0, 0)
      setPendingDate(newDate)
    }
  }

  // Handle confirm
  const handleConfirm = () => {
    onChange?.(pendingDate)
    setOpen(false)
  }

  // Get display value for pending selection
  const pendingDisplayValue = pendingDate
    ? format(pendingDate, 'yyyy年MM月dd日 HH:mm', { locale: zhCN })
    : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            'w-full justify-start text-left font-normal',
            !value && 'text-text-muted',
            className
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {value ? (
            format(value, 'yyyy年MM月dd日 HH:mm', { locale: zhCN })
          ) : (
            <span>{placeholder}</span>
          )}
          <ChevronDownIcon className="ml-auto h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col">
          <div className="flex">
            {/* Calendar */}
            <Calendar mode="single" selected={pendingDate} onSelect={handleDateSelect} />
            {/* Time Picker */}
            <div className="flex flex-col border-l border-border p-3 space-y-3">
              <div className="text-sm font-medium text-text-secondary">时间</div>
              <div className="flex items-center gap-2">
                {/* Hour Select */}
                <Select value={pendingHour} onValueChange={handleHourChange}>
                  <SelectTrigger className="w-[70px]">
                    <SelectValue placeholder="时" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[200px]">
                    {hours.map(hour => (
                      <SelectItem key={hour} value={hour}>
                        {hour}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-text-muted">:</span>
                {/* Minute Select */}
                <Select value={pendingMinute} onValueChange={handleMinuteChange}>
                  <SelectTrigger className="w-[70px]">
                    <SelectValue placeholder="分" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[200px]">
                    {minutes.map(minute => (
                      <SelectItem key={minute} value={minute}>
                        {minute}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="text-xs text-text-muted">
                {pendingDate ? format(pendingDate, 'HH:mm') : '--:--'}
              </div>
            </div>
          </div>
          {/* Footer with confirm button */}
          <div className="flex items-center justify-between border-t border-border px-3 py-2 bg-surface/50">
            <div className="text-sm text-text-secondary truncate max-w-[200px]">
              {pendingDisplayValue || '请选择日期和时间'}
            </div>
            <Button size="sm" onClick={handleConfirm} disabled={!pendingDate}>
              <Check className="mr-1 h-4 w-4" />
              确认
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
