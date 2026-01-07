// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { getTeamIconComponent } from '../../constants/team-icons'

type IconSize = 'xs' | 'sm' | 'md' | 'lg'

interface TeamIconDisplayProps {
  iconId: string | null | undefined
  size?: IconSize
  className?: string
}

const SIZE_MAP: Record<IconSize, string> = {
  xs: 'w-2.5 h-2.5',
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
}

/**
 * Component to display a team icon based on icon ID
 * Falls back to default icon (FaUsers) if iconId is not found
 */
export function TeamIconDisplay({ iconId, size = 'md', className = '' }: TeamIconDisplayProps) {
  const IconComponent = getTeamIconComponent(iconId)
  const sizeClass = SIZE_MAP[size]

  return <IconComponent className={`${sizeClass} ${className}`.trim()} />
}
