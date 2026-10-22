// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { cn } from '@/lib/utils'

interface ModelCapabilityDescriptionProps {
  capability?: string | null
  className?: string
}

export function ModelCapabilityDescription({
  capability,
  className,
}: ModelCapabilityDescriptionProps) {
  const description = capability?.trim()
  if (!description) return null

  return (
    <span className={cn('block whitespace-normal break-words text-xs text-text-muted', className)}>
      {description}
    </span>
  )
}
