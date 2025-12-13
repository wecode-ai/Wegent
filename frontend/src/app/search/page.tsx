// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  SearchInput,
  TypeTabs,
  SearchFilters,
  SearchResults,
  EmptyState,
  useSearch,
} from '@/features/search'

function SearchPageContent() {
  const { t } = useTranslation()
  const router = useRouter()
  const {
    query,
    types,
    sort,
    dateRange,
    results,
    isLoading,
    error,
    setQuery,
    setTypes,
    setSort,
    setDateRange,
  } = useSearch()

  return (
    <div className="min-h-screen bg-base">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-base border-b border-border">
        <div className="max-w-4xl mx-auto px-4 py-4">
          {/* Back button and title row */}
          <div className="flex items-center gap-3 mb-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.back()}
              className="shrink-0"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-semibold text-text-primary">
              {t('search.title')}
            </h1>
          </div>

          {/* Search input */}
          <div className="mb-4">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t('search.placeholder')}
              isSearching={isLoading}
            />
          </div>

          {/* Type tabs */}
          <div className="mb-3">
            <TypeTabs
              selected={types}
              onChange={setTypes}
              facets={results?.facets}
            />
          </div>

          {/* Filters */}
          <SearchFilters
            sort={sort}
            dateRange={dateRange}
            onSortChange={setSort}
            onDateRangeChange={setDateRange}
          />
        </div>
      </div>

      {/* Results */}
      <div className="max-w-4xl mx-auto px-4 py-6">
        {error && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg mb-4">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {!query && !isLoading ? (
          <EmptyState hasQuery={false} />
        ) : results && results.items.length === 0 && !isLoading ? (
          <EmptyState hasQuery={true} query={query} />
        ) : (
          <SearchResults
            items={results?.items || []}
            keyword={query}
            isLoading={isLoading}
            total={results?.total}
          />
        )}

        {/* Pagination hint */}
        {results && results.items.length > 0 && results.total > results.items.length && (
          <div className="mt-6 text-center">
            <p className="text-sm text-text-muted">
              {t('search.showing_of', {
                showing: results.items.length,
                total: results.total,
              })}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-base flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <SearchPageContent />
    </Suspense>
  )
}
