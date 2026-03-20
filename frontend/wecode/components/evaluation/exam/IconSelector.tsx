// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Icon, type IconName } from './ExamIcons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronDown } from 'lucide-react'

interface IconSelectorProps {
  value: IconName
  onChange: (value: IconName) => void
  disabled?: boolean
}

const availableIcons: IconName[] = [
  'robot',
  'globe',
  'sparkle',
  'file',
  'pen',
  'workflow',
  'layers',
  'clock',
  'tool',
  'shield',
  'check',
  'checkCircle',
  'upload',
  'cloudUpload',
  'info',
  'alertTriangle',
  'link',
  'user',
  'eye',
]

export function IconSelector({ value, onChange, disabled }: IconSelectorProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          disabled={disabled}
        >
          <div className="flex items-center gap-2">
            <Icon name={value} size={18} className="text-[#DF2029]" />
            <span>{value}</span>
          </div>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-2">
        <div className="grid grid-cols-5 gap-2">
          {availableIcons.map(iconName => (
            <button
              key={iconName}
              onClick={() => {
                onChange(iconName)
                setOpen(false)
              }}
              className={`flex flex-col items-center justify-center p-2 rounded-lg transition-colors ${
                value === iconName
                  ? 'bg-red-50 text-[#DF2029] ring-2 ring-[#DF2029]'
                  : 'hover:bg-gray-100 text-gray-600'
              }`}
              title={iconName}
            >
              <Icon
                name={iconName}
                size={20}
                className={value === iconName ? 'text-[#DF2029]' : 'text-gray-500'}
              />
              <span className="text-[10px] mt-1 truncate w-full text-center">{iconName}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default IconSelector
