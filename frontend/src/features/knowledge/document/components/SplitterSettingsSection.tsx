// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { useTranslation } from '@/hooks/useTranslation'
import { useLlmModels } from '../hooks/useLlmModels'
import type { UnifiedModel } from '@/apis/models'
import type {
  SplitterConfig,
  SplitterType,
  SentenceSplitterConfig,
  SemanticSplitterConfig,
  StructuralSemanticSplitterConfig,
} from '@/types/knowledge'

// Re-export SplitterConfig for backward compatibility
export type { SplitterConfig }

interface SplitterSettingsSectionProps {
  config: Partial<SplitterConfig>
  onChange: (config: Partial<SplitterConfig>) => void
  readOnly?: boolean
  fileExtension?: string // Used to determine if structural_semantic is available
}

// Extensions that support structural semantic splitting
const STRUCTURAL_SEMANTIC_EXTENSIONS = ['.pdf', '.docx', '.doc', '.md', '.txt']

// Check if file extension supports structural semantic splitting
function isStructuralSemanticSupported(fileExtension?: string): boolean {
  if (!fileExtension) return true // Allow if no extension (e.g., new upload without file)
  const ext = fileExtension.toLowerCase()
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`
  return STRUCTURAL_SEMANTIC_EXTENSIONS.includes(normalizedExt)
}

// Helper to get source type label
const getSourceTypeLabel = (type: string, t: (key: string) => string) => {
  const typeKey = type as 'user' | 'public' | 'group'
  return t(`knowledge:document.retrieval.sourceType.${typeKey}`)
}

export function SplitterSettingsSection({
  config,
  onChange,
  readOnly = false,
  fileExtension,
}: SplitterSettingsSectionProps) {
  const { t } = useTranslation()
  const { models: llmModels, loading: loadingModels } = useLlmModels()
  const [overlapError, setOverlapError] = useState('')

  const splitterType = (config.type as SplitterType) || 'structural_semantic'

  // Sentence splitter config
  const sentenceConfig = config as Partial<SentenceSplitterConfig>
  const chunkSize = config.type === 'sentence' ? (sentenceConfig.chunk_size ?? 1024) : 1024
  const chunkOverlap = config.type === 'sentence' ? (sentenceConfig.chunk_overlap ?? 50) : 50
  const separator = config.type === 'sentence' ? (sentenceConfig.separator ?? '\n\n') : '\n\n'

  // Semantic splitter config
  const semanticConfig = config as Partial<SemanticSplitterConfig>
  const bufferSize = config.type === 'semantic' ? (semanticConfig.buffer_size ?? 1) : 1
  const breakpointThreshold =
    config.type === 'semantic' ? (semanticConfig.breakpoint_percentile_threshold ?? 95) : 95

  // Structural semantic splitter config
  const structuralConfig = config as Partial<StructuralSemanticSplitterConfig>

  // Check if structural semantic is supported for current file
  const structuralSemanticAvailable = isStructuralSemanticSupported(fileExtension)

  useEffect(() => {
    if (splitterType === 'sentence' && chunkOverlap >= chunkSize) {
      setOverlapError(t('knowledge:document.splitter.overlapError'))
    } else {
      setOverlapError('')
    }
  }, [chunkSize, chunkOverlap, splitterType, t])

  const handleTypeChange = useCallback(
    (newType: string) => {
      if (newType === 'structural_semantic') {
        // Auto-select first LLM model if available
        const firstModel = llmModels[0]
        onChange({
          type: 'structural_semantic',
          max_chunk_tokens: 600,
          overlap_tokens: 80,
          llm_model_ref: firstModel
            ? { name: firstModel.name, namespace: firstModel.namespace || 'default' }
            : { name: '', namespace: 'default' },
        } as Partial<StructuralSemanticSplitterConfig>)
      } else if (newType === 'sentence') {
        onChange({
          type: 'sentence',
          separator: '\n\n',
          chunk_size: 1024,
          chunk_overlap: 50,
        })
      } else if (newType === 'semantic') {
        onChange({
          type: 'semantic',
          buffer_size: 1,
          breakpoint_percentile_threshold: 95,
        })
      }
    },
    [onChange, llmModels]
  )

  const handleLlmModelChange = useCallback(
    (value: string) => {
      const model = llmModels.find(m => `${m.namespace || 'default'}::${m.name}` === value)
      if (model) {
        onChange({
          ...config,
          type: 'structural_semantic',
          llm_model_ref: {
            name: model.name,
            namespace: model.namespace || 'default',
          },
        } as Partial<StructuralSemanticSplitterConfig>)
      }
    },
    [config, onChange, llmModels]
  )

  const handleChunkSizeChange = (value: number) => {
    const newValue = Math.max(128, Math.min(8192, value))
    onChange({ ...config, type: 'sentence', chunk_size: newValue })
  }

  const handleChunkOverlapChange = (value: number) => {
    const newValue = Math.max(0, Math.min(chunkSize - 1, value))
    onChange({ ...config, type: 'sentence', chunk_overlap: newValue })
  }

  const handleBufferSizeChange = (value: number) => {
    const newValue = Math.max(1, Math.min(10, value))
    onChange({ ...config, type: 'semantic', buffer_size: newValue })
  }

  const handleBreakpointThresholdChange = (value: number) => {
    const newValue = Math.max(50, Math.min(100, value))
    onChange({ ...config, type: 'semantic', breakpoint_percentile_threshold: newValue })
  }

  // Build splitter type items based on availability
  const splitterTypeItems = [
    ...(structuralSemanticAvailable
      ? [{ value: 'structural_semantic', label: t('knowledge:document.splitter.structuralSemantic') }]
      : []),
    { value: 'semantic', label: t('knowledge:document.splitter.semantic') },
    { value: 'sentence', label: t('knowledge:document.splitter.sentence') },
  ]

  // Format model label with source type
  const formatModelLabel = (model: UnifiedModel) => {
    const displayName = model.displayName || model.name
    const sourceLabel = getSourceTypeLabel(model.type, t)
    return `[${sourceLabel}] ${displayName}`
  }

  // Get current LLM model key
  const currentLlmModelKey =
    structuralConfig?.llm_model_ref?.name && structuralConfig?.llm_model_ref?.namespace
      ? `${structuralConfig.llm_model_ref.namespace}::${structuralConfig.llm_model_ref.name}`
      : ''

  return (
    <div className="space-y-4">
      {/* Chunking Type */}
      <div className="space-y-2">
        <Label htmlFor="splitter-type">{t('knowledge:document.splitter.type')}</Label>
        <SearchableSelect
          value={splitterType}
          onValueChange={handleTypeChange}
          disabled={readOnly}
          items={splitterTypeItems}
        />
        {/* Show hint for unsupported structural_semantic */}
        {!structuralSemanticAvailable && (
          <p className="text-xs text-text-muted">
            {t('knowledge:document.splitter.structuralSemanticUnsupported')}
          </p>
        )}
      </div>

      {/* Structural Semantic Splitter Settings */}
      {splitterType === 'structural_semantic' && (
        <div className="space-y-4">
          {/* LLM Model Selection */}
          <div className="space-y-2">
            <Label>{t('knowledge:document.splitter.llmModel')}</Label>
            {loadingModels ? (
              <div className="text-sm text-text-secondary">{t('common:actions.loading')}</div>
            ) : llmModels.length === 0 ? (
              <p className="text-sm text-warning">{t('knowledge:document.splitter.noLlmModel')}</p>
            ) : (
              <>
                <SearchableSelect
                  value={currentLlmModelKey}
                  onValueChange={handleLlmModelChange}
                  placeholder={t('knowledge:document.splitter.selectLlmModel')}
                  searchPlaceholder={t('knowledge:document.retrieval.searchPlaceholder')}
                  disabled={readOnly}
                  items={llmModels.map(model => ({
                    value: `${model.namespace || 'default'}::${model.name}`,
                    label: formatModelLabel(model),
                  }))}
                />
                <p className="text-xs text-text-muted">
                  {t('knowledge:document.splitter.llmModelHint')}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Sentence Splitter Settings */}
      {splitterType === 'sentence' && (
        <>
          {/* Separator */}
          <div className="space-y-2">
            <Label htmlFor="separator">{t('knowledge:document.splitter.separator')}</Label>
            <Input
              id="separator"
              type="text"
              value={separator}
              onChange={e => onChange({ ...config, type: 'sentence', separator: e.target.value })}
              disabled={readOnly}
              placeholder="\n\n"
            />
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.separatorHint')}
            </p>
          </div>

          {/* Chunk Size */}
          <div className="space-y-2">
            <Label htmlFor="chunk-size">{t('knowledge:document.splitter.chunkSize')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="chunk-size"
                type="number"
                min={128}
                max={8192}
                value={chunkSize}
                onChange={e => handleChunkSizeChange(parseInt(e.target.value) || 128)}
                disabled={readOnly}
                className="flex-1"
              />
              <span className="text-sm text-text-secondary whitespace-nowrap">
                {t('knowledge:document.splitter.characters')}
              </span>
            </div>
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.chunkSizeHint')}
            </p>
          </div>

          {/* Chunk Overlap */}
          <div className="space-y-2">
            <Label htmlFor="chunk-overlap">{t('knowledge:document.splitter.chunkOverlap')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="chunk-overlap"
                type="number"
                min={0}
                max={chunkSize - 1}
                value={chunkOverlap}
                onChange={e => handleChunkOverlapChange(parseInt(e.target.value) || 0)}
                disabled={readOnly}
                className="flex-1"
              />
              <span className="text-sm text-text-secondary whitespace-nowrap">
                {t('knowledge:document.splitter.characters')}
              </span>
            </div>
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.chunkOverlapHint')}
            </p>
            {overlapError && <p className="text-sm text-error">{overlapError}</p>}
          </div>
        </>
      )}

      {/* Semantic Splitter Settings */}
      {splitterType === 'semantic' && (
        <>
          {/* Buffer Size */}
          <div className="space-y-2">
            <Label htmlFor="buffer-size">{t('knowledge:document.splitter.bufferSize')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="buffer-size"
                type="number"
                min={1}
                max={10}
                value={bufferSize}
                onChange={e => handleBufferSizeChange(parseInt(e.target.value) || 1)}
                disabled={readOnly}
                className="flex-1"
              />
            </div>
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.bufferSizeHint')}
            </p>
          </div>

          {/* Breakpoint Percentile Threshold */}
          <div className="space-y-2">
            <Label htmlFor="breakpoint-threshold">
              {t('knowledge:document.splitter.breakpointThreshold')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="breakpoint-threshold"
                type="number"
                min={50}
                max={100}
                value={breakpointThreshold}
                onChange={e => handleBreakpointThresholdChange(parseInt(e.target.value) || 95)}
                disabled={readOnly}
                className="flex-1"
              />
              <span className="text-sm text-text-secondary whitespace-nowrap">%</span>
            </div>
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.breakpointThresholdHint')}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
