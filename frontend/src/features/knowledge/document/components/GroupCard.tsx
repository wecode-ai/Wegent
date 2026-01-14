// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Users, ArrowRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import type { Group } from '@/types/group'

interface GroupCardProps {
  group: Group
  onClick: () => void
}

export function GroupCard({ group, onClick }: GroupCardProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <Card
      padding="sm"
      className="hover:bg-hover transition-colors cursor-pointer h-[140px] flex flex-col group focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={group.display_name || group.name}
    >
      {/* Header with icon and name */}
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Users className="w-5 h-5 text-primary" />
        </div>
        <h3 className="font-medium text-sm line-clamp-2 flex-1">
          {group.display_name || group.name}
        </h3>
      </div>

      {/* Description */}
      <div className="text-xs text-text-muted flex-1 min-h-0">
        {group.description && <p className="line-clamp-2">{group.description}</p>}
      </div>

      {/* Bottom section - member count */}
      <div className="flex items-center justify-between mt-auto pt-2 flex-shrink-0">
        <span className="text-xs text-text-muted flex items-center gap-1">
          <Users className="w-3 h-3" />
          {group.member_count || 0}
        </span>
        <ArrowRight className="w-4 h-4 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </Card>
  )
}
