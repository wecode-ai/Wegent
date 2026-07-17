// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface UsageDatePickerProps {
  value: string
  onChange: (value: string) => void
  testId: string
  min?: string
  max?: string
}

export function UsageDatePicker({ value, onChange, testId, min, max }: UsageDatePickerProps) {
  const [open, setOpen] = useState(false)
  const selected = value ? parseISO(value) : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid={testId}
          variant="outline"
          className="w-full justify-between bg-base px-3 font-normal text-text-primary"
        >
          <span className="tabular-nums">{selected ? format(selected, 'yyyy-MM-dd') : '—'}</span>
          <CalendarDays className="h-4 w-4 text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          disabled={[
            ...(min ? [{ before: parseISO(min) }] : []),
            ...(max ? [{ after: parseISO(max) }] : []),
          ]}
          onSelect={date => {
            if (!date) return
            onChange(format(date, 'yyyy-MM-dd'))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
