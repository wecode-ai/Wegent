// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

interface SkeletonValueProps {
  value: ReactNode | null | undefined
  width?: string
  height?: string
  fallback?: ReactNode
}

/**
 * Component to show skeleton placeholder when value is not available
 */
export const SkeletonValue = memo(function SkeletonValue({
  value,
  width = '80px',
  height = '16px',
  fallback = null,
}: SkeletonValueProps) {
  if (value !== null && value !== undefined) {
    return <>{value}</>
  }

  if (fallback !== null) {
    return <>{fallback}</>
  }

  return <Skeleton className="inline-block align-middle" style={{ width, height }} />
})
