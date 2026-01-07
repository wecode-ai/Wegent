// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { useTranslation } from '@/hooks/useTranslation'
import type { SplitterConfig, SplitterType } from '@/types/knowledge'

// Re-export SplitterConfig for backward compatibility
export type { SplitterConfig }

interface SplitterSettingsSectionProps {
  config: Partial<SplitterConfig>
  onChange: (config: Partial<SplitterConfig>) => void
  readOnly?: boolean
}

export function SplitterSettingsSection({
  config,
  onChange,
  readOnly = false,
}: SplitterSettingsSectionProps) {
  const { t } = useTranslation()
  const [overlapError, setOverlapError] = useState('')

  const splitterType = (config.type as SplitterType) || 'sentence'

  // Sentence splitter config
  const chunkSize = config.type === 'sentence' ? (config.chunk_size ?? 1024) : 1024
  const chunkOverlap = config.type === 'sentence' ? (config.chunk_overlap ?? 50) : 50
  const separator = config.type === 'sentence' ? (config.separator ?? '\n\n') : '\n\n'

  // Semantic splitter config
  const bufferSize = config.type === 'semantic' ? (config.buffer_size ?? 1) : 1
  const breakpointThreshold =
    config.type === 'semantic' ? (config.breakpoint_percentile_threshold ?? 95) : 95

  useEffect(() => {
    if (splitterType === 'sentence' && chunkOverlap >= chunkSize) {
      setOverlapError(t('knowledge:document.splitter.overlapError'))
    } else {
      setOverlapError('')
    }
  }, [chunkSize, chunkOverlap, splitterType, t])

  const handleTypeChange = (newType: string) => {
    if (newType === 'sentence') {
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
  }

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

  const splitterTypeItems = [
    { value: 'sentence', label: t('knowledge:document.splitter.sentence') },
    { value: 'semantic', label: t('knowledge:document.splitter.semantic') },
  ]

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
      </div>

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
