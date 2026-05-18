// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react'
import client from '@/apis/client'
import type { Department } from '@wecode/types/department'

/**
 * The hook intentionally does NOT call useTranslation — it returns a stable
 * error-kind tag so that consumers control all i18n in one place. Calling
 * useTranslation both here and in the consumer component triggered a
 * "t is not defined" runtime error under Turbopack's HMR, likely due to
 * how it serialises hook signatures across two co-rendered functions.
 */
export type DepartmentSearchErrorKind = 'request_failed'

interface UseDepartmentSearchResult {
  departments: Department[]
  searching: boolean
  errorKind: DepartmentSearchErrorKind | null
  searchQuery: string
  setSearchQuery: (q: string) => void
  showDropdown: boolean
  setShowDropdown: (show: boolean) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  dropdownRef: React.RefObject<HTMLDivElement | null>
}

export function useDepartmentSearch(): UseDepartmentSearchResult {
  const [departments, setDepartments] = useState<Department[]>([])
  const [searching, setSearching] = useState(false)
  const [errorKind, setErrorKind] = useState<DepartmentSearchErrorKind | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setDepartments([])
      setErrorKind(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      setErrorKind(null)
      client
        .get<{ departments: Department[] }>(
          `/internal/departments/search?q=${encodeURIComponent(searchQuery)}`
        )
        .then(result => {
          if (cancelled) return
          setDepartments(result.departments || [])
          setShowDropdown(true)
        })
        .catch(() => {
          if (cancelled) return
          setDepartments([])
          setErrorKind('request_failed')
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [searchQuery])

  return {
    departments,
    searching,
    errorKind,
    searchQuery,
    setSearchQuery,
    showDropdown,
    setShowDropdown,
    inputRef,
    dropdownRef,
  }
}
