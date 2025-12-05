// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import {
  MessageSquare,
  Code,
  Users,
  Bot,
  Zap,
  Sparkles,
  Brain,
  Lightbulb,
  Terminal,
  GitBranch,
  Database,
  Cloud,
  Shield,
  Heart,
  Star,
  Rocket,
  Target,
  Compass,
  Map,
  Book,
  LucideIcon,
} from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

// Available icons for selection
const AVAILABLE_ICONS: { name: string; icon: LucideIcon }[] = [
  { name: 'MessageSquare', icon: MessageSquare },
  { name: 'Code', icon: Code },
  { name: 'Users', icon: Users },
  { name: 'Bot', icon: Bot },
  { name: 'Zap', icon: Zap },
  { name: 'Sparkles', icon: Sparkles },
  { name: 'Brain', icon: Brain },
  { name: 'Lightbulb', icon: Lightbulb },
  { name: 'Terminal', icon: Terminal },
  { name: 'GitBranch', icon: GitBranch },
  { name: 'Database', icon: Database },
  { name: 'Cloud', icon: Cloud },
  { name: 'Shield', icon: Shield },
  { name: 'Heart', icon: Heart },
  { name: 'Star', icon: Star },
  { name: 'Rocket', icon: Rocket },
  { name: 'Target', icon: Target },
  { name: 'Compass', icon: Compass },
  { name: 'Map', icon: Map },
  { name: 'Book', icon: Book },
]

// Icon name to component mapping
const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  AVAILABLE_ICONS.map(({ name, icon }) => [name, icon])
)

interface IconPickerProps {
  value: string
  onChange: (icon: string) => void
}

export default function IconPicker({ value, onChange }: IconPickerProps) {
  const [open, setOpen] = useState(false)
  const CurrentIcon = ICON_MAP[value] || Users

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="p-2 rounded-md border border-border hover:border-primary/50 transition-colors bg-surface">
          <CurrentIcon className="w-5 h-5 text-primary" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="grid grid-cols-5 gap-1">
          {AVAILABLE_ICONS.map(({ name, icon: Icon }) => (
            <button
              key={name}
              onClick={() => {
                onChange(name)
                setOpen(false)
              }}
              className={`p-2 rounded-md transition-colors ${
                value === name
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-hover text-text-muted hover:text-text-primary'
              }`}
              title={name}
            >
              <Icon className="w-5 h-5" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
