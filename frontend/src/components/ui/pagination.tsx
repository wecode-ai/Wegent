// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'

interface PaginationProps {
  /** Current page number (1-based) */
  page: number
  /** Total number of pages */
  totalPages: number
  /** Total number of items */
  totalCount: number
  /** Items per page */
  pageSize: number
  /** Available page size options */
  pageSizeOptions?: number[]
  /** Whether page size selector is shown */
  showPageSizeSelector?: boolean
  /** Callback when page changes */
  onGoToPage: (page: number) => void
  /** Callback when page size changes */
  onPageSizeChange?: (pageSize: number) => void
  /** Loading state */
  disabled?: boolean
}

/**
 * Generate page numbers to display with ellipsis.
 * Shows: first page, last page, current page ± 1, with ellipsis for gaps.
 *
 * Examples:
 *   totalPages=5, page=3  → [1, 2, 3, 4, 5]
 *   totalPages=10, page=1 → [1, 2, 3, '...', 10]
 *   totalPages=10, page=5 → [1, '...', 4, 5, 6, '...', 10]
 *   totalPages=10, page=10 → [1, '...', 8, 9, 10]
 */
function generatePageNumbers(
  currentPage: number,
  totalPages: number
): (number | 'ellipsis-start' | 'ellipsis-end')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }

  const pages: (number | 'ellipsis-start' | 'ellipsis-end')[] = [1]

  if (currentPage > 3) {
    pages.push('ellipsis-start')
  }

  const start = Math.max(2, currentPage - 1)
  const end = Math.min(totalPages - 1, currentPage + 1)

  for (let i = start; i <= end; i++) {
    pages.push(i)
  }

  if (currentPage < totalPages - 2) {
    pages.push('ellipsis-end')
  }

  pages.push(totalPages)

  return pages
}

export function Pagination({
  page,
  totalPages,
  totalCount,
  pageSize,
  pageSizeOptions = [50, 100, 500],
  showPageSizeSelector = true,
  onGoToPage,
  onPageSizeChange,
  disabled = false,
}: PaginationProps) {
  const { t } = useTranslation('knowledge')

  // Hide pagination when there's only one page or no items
  if (totalPages <= 1 && totalCount <= pageSize) return null

  const pageNumbers = generatePageNumbers(page, totalPages)
  const hasPrev = page > 1
  const hasNext = page < totalPages

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-border">
      {/* Left: total count */}
      <div className="text-xs text-text-muted">
        {t('document.pagination.totalCount', { count: totalCount })}
      </div>

      {/* Center: page navigation */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onGoToPage(page - 1)}
          disabled={!hasPrev || disabled}
          data-testid="pagination-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {pageNumbers.map(pageNum => {
          if (pageNum === 'ellipsis-start' || pageNum === 'ellipsis-end') {
            return (
              <span
                key={pageNum}
                className="flex h-8 w-8 items-center justify-center text-text-muted"
              >
                <MoreHorizontal className="h-4 w-4" />
              </span>
            )
          }

          const isActive = pageNum === page
          return (
            <Button
              key={pageNum}
              variant={isActive ? 'primary' : 'ghost'}
              size="sm"
              className="h-8 w-8 p-0 text-xs"
              onClick={() => onGoToPage(pageNum)}
              disabled={disabled}
              data-testid={`pagination-page-${pageNum}`}
            >
              {pageNum}
            </Button>
          )
        })}

        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => onGoToPage(page + 1)}
          disabled={!hasNext || disabled}
          data-testid="pagination-next"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Right: page size selector */}
      {showPageSizeSelector && onPageSizeChange && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{t('document.pagination.pageSize')}</span>
          <Select
            value={String(pageSize)}
            onValueChange={value => onPageSizeChange(Number(value))}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 w-[72px] text-xs" data-testid="pagination-page-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map(size => (
                <SelectItem key={size} value={String(size)} className="text-xs">
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
