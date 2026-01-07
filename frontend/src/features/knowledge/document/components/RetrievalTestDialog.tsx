// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { Search, FileText, Target, ChevronDown, ChevronUp, Settings2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/useTranslation'
import { apiClient } from '@/apis/client'
import { retrieverApis, type RetrievalMethodType } from '@/apis/retrievers'
import type { KnowledgeBase } from '@/types/knowledge'

interface RetrievalResult {
  content: string
  score: number
  title: string
  metadata?: Record<string, unknown>
}

interface RetrieveResponse {
  records: RetrievalResult[]
}

interface RetrievalTestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBase
}

// Test config stored in frontend only
interface TestConfig {
  retrieval_mode: RetrievalMethodType
  score_threshold: number
  top_k: number
}

export function RetrievalTestDialog({
  open,
  onOpenChange,
  knowledgeBase,
}: RetrievalTestDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<RetrievalResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  // Retrieval methods supported by the retriever
  const [supportedMethods, setSupportedMethods] = useState<RetrievalMethodType[]>([])
  const [loadingMethods, setLoadingMethods] = useState(false)

  // Test config - frontend only, overrides database config
  const [testConfig, setTestConfig] = useState<TestConfig>({
    retrieval_mode: 'vector',
    score_threshold: 0.7,
    top_k: 5,
  })

  const maxQueryLength = 200

  // Check if retrieval config is available
  const hasRetrievalConfig =
    knowledgeBase.retrieval_config?.retriever_name &&
    knowledgeBase.retrieval_config?.embedding_config?.model_name

  // Load supported retrieval methods based on retriever's storage type
  useEffect(() => {
    const loadSupportedMethods = async () => {
      if (!open || !hasRetrievalConfig) return

      const retrieverName = knowledgeBase.retrieval_config?.retriever_name
      const retrieverNamespace = knowledgeBase.retrieval_config?.retriever_namespace || 'default'

      if (!retrieverName) return

      setLoadingMethods(true)
      try {
        // Get retriever details to find storage type
        const retriever = await retrieverApis.getRetriever(retrieverName, retrieverNamespace)
        const storageType = retriever.spec.storageConfig.type

        // Get supported methods for this storage type
        const methodsResponse = await retrieverApis.getStorageTypeRetrievalMethods(storageType)
        setSupportedMethods(methodsResponse.retrieval_methods || ['vector'])

        // Initialize test config from knowledge base config
        const config = knowledgeBase.retrieval_config!
        setTestConfig({
          retrieval_mode: config.retrieval_mode ?? 'vector',
          score_threshold: config.score_threshold ?? 0.7,
          top_k: config.top_k ?? 5,
        })
      } catch (err) {
        console.error('Failed to load retrieval methods:', err)
        // Fallback to vector only
        setSupportedMethods(['vector'])
      } finally {
        setLoadingMethods(false)
      }
    }

    loadSupportedMethods()
  }, [open, hasRetrievalConfig, knowledgeBase.retrieval_config])

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !hasRetrievalConfig) return

    setLoading(true)
    setError(null)
    setHasSearched(true)

    try {
      const config = knowledgeBase.retrieval_config!

      // Build request using test config (overrides database config)
      const request = {
        query: query.trim(),
        knowledge_id: String(knowledgeBase.id),
        retriever_ref: {
          name: config.retriever_name,
          namespace: config.retriever_namespace,
        },
        embedding_model_ref: {
          model_name: config.embedding_config.model_name,
          model_namespace: config.embedding_config.model_namespace,
        },
        // Use test config values instead of database config
        top_k: testConfig.top_k,
        score_threshold: testConfig.score_threshold,
        retrieval_mode: testConfig.retrieval_mode,
        // Include hybrid weights if hybrid mode is selected
        ...(testConfig.retrieval_mode === 'hybrid' &&
          config.hybrid_weights && {
            hybrid_weights: {
              vector_weight: config.hybrid_weights.vector_weight,
              keyword_weight: config.hybrid_weights.keyword_weight,
            },
          }),
      }

      const response = await apiClient.post<RetrieveResponse>('/rag/retrieve', request)
      setResults(response.records || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('knowledge:document.retrievalTest.error'))
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [query, knowledgeBase, hasRetrievalConfig, testConfig, t])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSearch()
    }
  }

  const handleClose = () => {
    setQuery('')
    setResults([])
    setError(null)
    setHasSearched(false)
    setExpandedIndex(null)
    onOpenChange(false)
  }

  const toggleExpand = (index: number) => {
    setExpandedIndex(expandedIndex === index ? null : index)
  }

  // Get retrieval mode display text
  const getRetrievalModeText = (mode: RetrievalMethodType) => {
    switch (mode) {
      case 'hybrid':
        return t('knowledge:document.retrieval.hybrid')
      case 'keyword':
        return t('knowledge:document.retrieval.keyword')
      default:
        return t('knowledge:document.retrieval.vector')
    }
  }

  // Check if config differs from database
  const hasConfigChanges = useMemo(() => {
    const dbConfig = knowledgeBase.retrieval_config
    if (!dbConfig) return false

    return (
      testConfig.retrieval_mode !== (dbConfig.retrieval_mode ?? 'vector') ||
      testConfig.score_threshold !== (dbConfig.score_threshold ?? 0.7) ||
      testConfig.top_k !== (dbConfig.top_k ?? 5)
    )
  }, [testConfig, knowledgeBase.retrieval_config])

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="w-5 h-5 text-primary" />
            {t('knowledge:document.retrievalTest.title')}
          </DialogTitle>
          <DialogDescription>{t('knowledge:document.retrievalTest.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">
          {/* Left side - Query input */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Query input area */}
            <div className="relative border border-border rounded-lg focus-within:ring-1 focus-within:ring-primary">
              {/* Header with label and config popover */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface/50">
                <span className="text-sm text-text-secondary">
                  {t('knowledge:document.retrievalTest.sourceText')}
                </span>

                {/* Config Popover */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 gap-1.5 text-xs text-text-muted hover:text-text-primary"
                      disabled={loadingMethods}
                    >
                      {loadingMethods ? (
                        <Spinner className="w-3 h-3" />
                      ) : (
                        <>
                          <Search className="w-3 h-3" />
                          <span>{getRetrievalModeText(testConfig.retrieval_mode)}</span>
                          {hasConfigChanges && (
                            <Badge variant="warning" className="h-4 px-1 text-[10px]">
                              {t('knowledge:document.retrievalTest.modified')}
                            </Badge>
                          )}
                          <Settings2 className="w-3 h-3 ml-0.5" />
                        </>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-4" align="end">
                    <div className="space-y-4">
                      <div className="text-sm font-medium text-text-primary">
                        {t('knowledge:document.retrievalTest.configTitle')}
                      </div>

                      {/* Retrieval Mode */}
                      <div className="space-y-2">
                        <Label className="text-xs text-text-secondary">
                          {t('knowledge:document.retrieval.retrievalMode')}
                        </Label>
                        <Select
                          value={testConfig.retrieval_mode}
                          onValueChange={(value: RetrievalMethodType) =>
                            setTestConfig(prev => ({ ...prev, retrieval_mode: value }))
                          }
                        >
                          <SelectTrigger className="h-8 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {supportedMethods.map(method => (
                              <SelectItem key={method} value={method}>
                                {getRetrievalModeText(method)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Score Threshold */}
                      <div className="space-y-2">
                        <Label className="text-xs text-text-secondary">
                          {t('knowledge:document.retrieval.scoreThreshold')}
                        </Label>
                        <Input
                          type="number"
                          min={0}
                          max={1}
                          step={0.1}
                          value={testConfig.score_threshold}
                          onChange={e => {
                            const value = parseFloat(e.target.value)
                            if (!isNaN(value) && value >= 0 && value <= 1) {
                              setTestConfig(prev => ({ ...prev, score_threshold: value }))
                            }
                          }}
                          className="h-8 text-sm"
                        />
                        <p className="text-[10px] text-text-muted">
                          {t('knowledge:document.retrieval.scoreThresholdHint')}
                        </p>
                      </div>

                      {/* Top K */}
                      <div className="space-y-2">
                        <Label className="text-xs text-text-secondary">
                          {t('knowledge:document.retrieval.topK')}
                        </Label>
                        <Input
                          type="number"
                          min={1}
                          max={20}
                          step={1}
                          value={testConfig.top_k}
                          onChange={e => {
                            const value = parseInt(e.target.value, 10)
                            if (!isNaN(value) && value >= 1 && value <= 20) {
                              setTestConfig(prev => ({ ...prev, top_k: value }))
                            }
                          }}
                          className="h-8 text-sm"
                        />
                        <p className="text-[10px] text-text-muted">
                          {t('knowledge:document.retrieval.topKHint')}
                        </p>
                      </div>

                      {/* Config hint */}
                      <p className="text-[10px] text-text-muted border-t border-border pt-3">
                        {t('knowledge:document.retrievalTest.configHint')}
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              {/* Textarea */}
              <Textarea
                value={query}
                onChange={e => setQuery(e.target.value.slice(0, maxQueryLength))}
                onKeyDown={handleKeyDown}
                placeholder={t('knowledge:document.retrievalTest.placeholder')}
                className="border-0 focus-visible:ring-0 resize-none min-h-[200px]"
                disabled={!hasRetrievalConfig}
              />

              {/* Footer with character count and search button */}
              <div className="flex items-center justify-between px-3 py-2 border-t border-border">
                <span className="text-xs text-text-muted">
                  {query.length} / {maxQueryLength}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSearch}
                  disabled={!query.trim() || loading || !hasRetrievalConfig}
                >
                  {loading ? (
                    <Spinner className="w-4 h-4" />
                  ) : (
                    t('knowledge:document.retrievalTest.search')
                  )}
                </Button>
              </div>
            </div>

            {/* No config warning */}
            {!hasRetrievalConfig && (
              <div className="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg text-sm text-warning">
                {t('knowledge:document.retrievalTest.noConfig')}
              </div>
            )}
          </div>

          {/* Right side - Results */}
          <div className="flex-1 flex flex-col min-w-0 bg-surface/50 rounded-lg border border-border">
            {/* Results header */}
            <div className="px-4 py-3 border-b border-border">
              <span className="text-sm font-medium text-text-primary">
                {t('knowledge:document.retrievalTest.results')}
                {hasSearched && results.length > 0 && (
                  <span className="ml-2 text-text-muted font-normal">({results.length})</span>
                )}
              </span>
            </div>

            {/* Results content */}
            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="flex items-center justify-center h-full">
                  <Spinner />
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center h-full text-error">
                  <p className="text-sm">{error}</p>
                </div>
              ) : !hasSearched ? (
                <div className="flex flex-col items-center justify-center h-full text-text-muted">
                  <Target className="w-12 h-12 mb-3 opacity-30" />
                  <p className="text-sm">{t('knowledge:document.retrievalTest.emptyHint')}</p>
                </div>
              ) : results.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-text-muted">
                  <FileText className="w-12 h-12 mb-3 opacity-30" />
                  <p className="text-sm">{t('knowledge:document.retrievalTest.noResults')}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {results.map((result, index) => {
                    const isExpanded = expandedIndex === index
                    return (
                      <div
                        key={index}
                        className={`bg-base border rounded-lg transition-all ${
                          isExpanded
                            ? 'border-primary/50 shadow-sm'
                            : 'border-border hover:border-primary/30'
                        }`}
                      >
                        {/* Result header with title and score - clickable */}
                        <button
                          type="button"
                          onClick={() => toggleExpand(index)}
                          className="w-full p-3 flex items-center justify-between text-left"
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <FileText className="w-4 h-4 text-text-muted flex-shrink-0" />
                            <span className="text-sm font-medium text-text-primary truncate">
                              {result.title}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <Badge variant="secondary">{(result.score * 100).toFixed(1)}%</Badge>
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4 text-text-muted" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-text-muted" />
                            )}
                          </div>
                        </button>

                        {/* Result content - collapsible */}
                        <div className={`px-3 pb-3 ${isExpanded ? '' : 'hidden'}`}>
                          <div className="pt-2 border-t border-border">
                            <p className="text-sm text-text-secondary whitespace-pre-wrap">
                              {result.content}
                            </p>
                          </div>
                        </div>

                        {/* Preview content when collapsed */}
                        {!isExpanded && (
                          <div className="px-3 pb-3">
                            <p className="text-sm text-text-secondary line-clamp-2 whitespace-pre-wrap">
                              {result.content}
                            </p>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
