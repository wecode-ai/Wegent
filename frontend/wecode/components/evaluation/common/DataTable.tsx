// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export interface Column<T> {
  key: string
  title: string
  render: (item: T) => React.ReactNode
  className?: string
}

export interface DataTableProps<T, K extends string | number = string | number> {
  columns: Column<T>[]
  data: T[]
  total: number
  page: number
  pageSize: number
  loading?: boolean
  emptyMessage?: string
  emptyIcon?: React.ReactNode
  emptyAction?: React.ReactNode
  onPageChange: (page: number) => void
  previousText?: string
  nextText?: string
  pageText?: string
  rowKey: (item: T) => K
  // Selection props
  selectable?: boolean
  selectedIds?: Set<K>
  onSelectionChange?: (selectedIds: Set<K>) => void
  selectAllText?: string
  // Search props
  searchable?: boolean
  searchPlaceholder?: string
  onSearch?: (query: string) => void
  // Card styling
  cardClassName?: string
}

export function DataTable<T, K extends string | number = string | number>({
  columns,
  data,
  total,
  page,
  pageSize,
  loading = false,
  emptyMessage,
  emptyIcon,
  emptyAction,
  onPageChange,
  previousText = 'Previous',
  nextText = 'Next',
  pageText = 'Page',
  rowKey,
  selectable = false,
  selectedIds = new Set<K>(),
  onSelectionChange,
  selectAllText = 'Select all',
  searchable = false,
  searchPlaceholder = 'Search...',
  onSearch,
  cardClassName = '',
}: DataTableProps<T, K>) {
  const totalPages = Math.ceil(total / pageSize)
  const hasPagination = total > pageSize
  const [searchQuery, setSearchQuery] = useState('')

  const handleSelectItem = (item: T, checked: boolean) => {
    if (!onSelectionChange) return
    const key = rowKey(item)
    const newSelected = new Set<K>(selectedIds)
    if (checked) {
      newSelected.add(key)
    } else {
      newSelected.delete(key)
    }
    onSelectionChange(newSelected)
  }

  const handleSelectAll = (checked: boolean) => {
    if (!onSelectionChange) return
    if (checked) {
      const allIds = data.map(item => rowKey(item))
      onSelectionChange(new Set<K>(allIds))
    } else {
      onSelectionChange(new Set<K>())
    }
  }

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setSearchQuery(value)
    onSearch?.(value)
  }

  const isAllSelected = data.length > 0 && data.every(item => selectedIds.has(rowKey(item)))
  const isPartialSelected = data.some(item => selectedIds.has(rowKey(item))) && !isAllSelected

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        {emptyIcon}
        <p className="text-text-secondary">{emptyMessage}</p>
        {emptyAction && <div className="mt-4">{emptyAction}</div>}
      </div>
    )
  }

  return (
    <div
      className={`bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden p-6 ${cardClassName}`}
    >
      {/* Search input */}
      {searchable && (
        <div className="mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              type="text"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={handleSearchChange}
              className="pl-10 w-full max-w-sm"
            />
          </div>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            {selectable && (
              <TableHead className="w-12">
                <Checkbox
                  checked={isAllSelected}
                  data-state={isPartialSelected ? 'indeterminate' : undefined}
                  onCheckedChange={handleSelectAll}
                  aria-label={selectAllText}
                />
              </TableHead>
            )}
            {columns.map(column => (
              <TableHead key={column.key} className={column.className}>
                {column.title}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map(item => {
            const key = rowKey(item)
            const isSelected = selectedIds.has(key)
            return (
              <TableRow key={key} data-selected={isSelected} className="hover:bg-gray-50">
                {selectable && (
                  <TableCell className="w-12">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={checked => handleSelectItem(item, checked as boolean)}
                      aria-label={`Select item ${key}`}
                    />
                  </TableCell>
                )}
                {columns.map(column => (
                  <TableCell key={column.key} className={column.className}>
                    {column.render(item)}
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      {hasPagination && (
        <div className="flex items-center justify-center gap-3 pt-4 mt-4 border-t border-gray-100">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => onPageChange(page - 1)}
            className="px-4"
          >
            {previousText}
          </Button>
          <span className="flex items-center px-3 text-sm text-gray-500 font-medium">
            {pageText} {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="px-4"
          >
            {nextText}
          </Button>
        </div>
      )}
    </div>
  )
}
