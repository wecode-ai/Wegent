// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Info } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import {
  DEFAULT_FLAT_CHUNK_CONFIG,
  DEFAULT_HIERARCHICAL_CHUNK_CONFIG,
  DEFAULT_SEMANTIC_CHUNK_CONFIG,
  normalizeSplitterConfigForDisplay,
  type ChunkStrategy,
  type FormatEnhancement,
  type SplitterConfig,
} from '@/types/knowledge'

// Re-export SplitterConfig for backward compatibility
export type { SplitterConfig }

interface SplitterSettingsSectionProps {
  config: Partial<SplitterConfig>
  onChange: (config: Partial<SplitterConfig>) => void
  readOnly?: boolean
}

function encodeSeparatorForDisplay(value: string | undefined): string {
  return (value ?? '').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
}

function decodeSeparatorFromDisplay(value: string): string {
  return value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

function SettingLabel({
  htmlFor,
  children,
  help,
}: {
  htmlFor: string
  children: string
  help: string
}) {
  return (
    <div className="flex items-center gap-1">
      <Label htmlFor={htmlFor}>{children}</Label>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-11 w-11 items-center justify-center text-text-muted hover:text-text-primary"
              aria-label={help}
              data-testid={`splitter-help-${htmlFor}`}
            >
              <Info className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-left leading-relaxed">{help}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

export function SplitterSettingsSection({
  config,
  onChange,
  readOnly = false,
}: SplitterSettingsSectionProps) {
  const { t } = useTranslation()

  const normalizedConfig = normalizeSplitterConfigForDisplay(config)
  const chunkStrategy = normalizedConfig.chunk_strategy
  const formatEnhancement =
    normalizedConfig.format_enhancement ?? (chunkStrategy === 'flat' ? 'file_aware' : 'none')
  const fileAwareEnabled = formatEnhancement === 'file_aware'
  const titleEnhancementEnabled =
    fileAwareEnabled && (normalizedConfig.markdown_enhancement?.enabled ?? true)
  const hierarchicalConfig = {
    ...DEFAULT_HIERARCHICAL_CHUNK_CONFIG,
    ...normalizedConfig.hierarchical_config,
  }
  const flatConfig = {
    ...DEFAULT_FLAT_CHUNK_CONFIG,
    ...normalizedConfig.flat_config,
  }
  const semanticConfig = {
    ...DEFAULT_SEMANTIC_CHUNK_CONFIG,
    ...normalizedConfig.semantic_config,
  }

  const updateConfig = (next: Partial<SplitterConfig>) => {
    onChange(next)
  }

  const buildStrategyConfig = (
    strategy: ChunkStrategy,
    overrides?: {
      formatEnhancement?: FormatEnhancement
      titleEnhancementEnabled?: boolean
    }
  ) => {
    const nextFormatEnhancement = overrides?.formatEnhancement ?? formatEnhancement
    const nextTitleEnhancementEnabled =
      overrides?.titleEnhancementEnabled ?? titleEnhancementEnabled
    const baseConfig = {
      chunk_strategy: strategy,
      format_enhancement: nextFormatEnhancement,
      markdown_enhancement: {
        enabled: nextFormatEnhancement === 'file_aware' ? nextTitleEnhancementEnabled : false,
      },
    }

    if (strategy === 'hierarchical') {
      return {
        ...baseConfig,
        hierarchical_config: {
          ...DEFAULT_HIERARCHICAL_CHUNK_CONFIG,
          ...normalizedConfig.hierarchical_config,
        },
      }
    }

    if (strategy === 'semantic') {
      return {
        ...baseConfig,
        semantic_config: {
          ...DEFAULT_SEMANTIC_CHUNK_CONFIG,
          ...normalizedConfig.semantic_config,
        },
      }
    }

    return {
      ...baseConfig,
      flat_config: {
        ...DEFAULT_FLAT_CHUNK_CONFIG,
        ...normalizedConfig.flat_config,
      },
    }
  }

  const handleStrategyChange = (value: string) => {
    updateConfig(buildStrategyConfig(value as ChunkStrategy))
  }

  const handleFileAwareChange = (checked: boolean) => {
    updateConfig(
      buildStrategyConfig(chunkStrategy, {
        formatEnhancement: checked ? 'file_aware' : 'none',
        titleEnhancementEnabled: checked ? titleEnhancementEnabled : false,
      })
    )
  }

  const handleTitleEnhancementChange = (checked: boolean) => {
    updateConfig(
      buildStrategyConfig(chunkStrategy, {
        titleEnhancementEnabled: checked,
      })
    )
  }

  const handleFlatChunkSizeChange = (value: number) => {
    const newValue = Math.max(128, Math.min(8192, value))
    const currentChunkOverlap =
      flatConfig.chunk_overlap ?? DEFAULT_FLAT_CHUNK_CONFIG.chunk_overlap ?? 50
    updateConfig({
      ...buildStrategyConfig('flat'),
      flat_config: {
        ...flatConfig,
        chunk_size: newValue,
        chunk_overlap: Math.min(currentChunkOverlap, newValue - 1),
      },
    })
  }

  const handleFlatChunkOverlapChange = (value: number) => {
    const chunkSize = flatConfig.chunk_size ?? DEFAULT_FLAT_CHUNK_CONFIG.chunk_size ?? 1024
    const newValue = Math.max(0, Math.min(chunkSize - 1, value))
    updateConfig({
      ...buildStrategyConfig('flat'),
      flat_config: {
        ...flatConfig,
        chunk_overlap: newValue,
      },
    })
  }

  const handleSeparatorChange = (value: string) => {
    updateConfig({
      ...buildStrategyConfig('flat'),
      flat_config: {
        ...flatConfig,
        separator: value,
      },
    })
  }

  const handleParentSeparatorChange = (value: string) => {
    updateConfig({
      ...buildStrategyConfig('hierarchical'),
      hierarchical_config: {
        ...hierarchicalConfig,
        parent_separator: value,
      },
    })
  }

  const handleChildSeparatorChange = (value: string) => {
    updateConfig({
      ...buildStrategyConfig('hierarchical'),
      hierarchical_config: {
        ...hierarchicalConfig,
        child_separator: value,
      },
    })
  }

  const handleParentChunkSizeChange = (value: number) => {
    const newValue = Math.max(256, Math.min(16384, value))
    updateConfig({
      ...buildStrategyConfig('hierarchical'),
      hierarchical_config: {
        ...hierarchicalConfig,
        parent_chunk_size: newValue,
      },
    })
  }

  const handleChildChunkSizeChange = (value: number) => {
    const newValue = Math.max(128, Math.min(8192, value))
    updateConfig({
      ...buildStrategyConfig('hierarchical'),
      hierarchical_config: {
        ...hierarchicalConfig,
        child_chunk_size: newValue,
        child_chunk_overlap: Math.min(
          hierarchicalConfig.child_chunk_overlap ??
            DEFAULT_HIERARCHICAL_CHUNK_CONFIG.child_chunk_overlap ??
            64,
          newValue - 1
        ),
      },
    })
  }

  const handleChildChunkOverlapChange = (value: number) => {
    const childChunkSize =
      hierarchicalConfig.child_chunk_size ??
      DEFAULT_HIERARCHICAL_CHUNK_CONFIG.child_chunk_size ??
      512
    const newValue = Math.max(0, Math.min(childChunkSize - 1, value))
    updateConfig({
      ...buildStrategyConfig('hierarchical'),
      hierarchical_config: {
        ...hierarchicalConfig,
        child_chunk_overlap: newValue,
      },
    })
  }

  const handleBufferSizeChange = (value: number) => {
    const newValue = Math.max(1, Math.min(10, value))
    updateConfig({
      ...buildStrategyConfig('semantic'),
      semantic_config: {
        ...semanticConfig,
        buffer_size: newValue,
      },
    })
  }

  const handleBreakpointThresholdChange = (value: number) => {
    const newValue = Math.max(50, Math.min(100, value))
    updateConfig({
      ...buildStrategyConfig('semantic'),
      semantic_config: {
        ...semanticConfig,
        breakpoint_percentile_threshold: newValue,
      },
    })
  }

  const chunkStrategyItems = [
    {
      value: 'flat',
      label: t('knowledge:document.splitter.flat'),
      content: (
        <div>
          <p>{t('knowledge:document.splitter.flat')}</p>
          <p className="text-xs text-text-muted">
            {t('knowledge:document.splitter.flatDescription')}
          </p>
        </div>
      ),
    },
    {
      value: 'hierarchical',
      label: t('knowledge:document.splitter.hierarchical'),
      content: (
        <div>
          <p>{t('knowledge:document.splitter.hierarchical')}</p>
          <p className="text-xs text-text-muted">
            {t('knowledge:document.splitter.hierarchicalDescription')}
          </p>
        </div>
      ),
    },
    {
      value: 'semantic',
      label: t('knowledge:document.splitter.semantic'),
      content: (
        <div>
          <p>{t('knowledge:document.splitter.semantic')}</p>
          <p className="text-xs text-text-muted">
            {t('knowledge:document.splitter.semanticDescription')}
          </p>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SettingLabel htmlFor="splitter-type" help={t('knowledge:document.splitter.typeHelp')}>
          {t('knowledge:document.splitter.type')}
        </SettingLabel>
        <SearchableSelect
          value={chunkStrategy}
          onValueChange={handleStrategyChange}
          disabled={readOnly}
          items={chunkStrategyItems}
        />
        <p className="text-xs text-text-muted">
          {t(`knowledge:document.splitter.${chunkStrategy}Description`)}
        </p>
      </div>

      {chunkStrategy === 'flat' && (
        <>
          <div className="space-y-2">
            <SettingLabel
              htmlFor="chunk-size"
              help={t('knowledge:document.splitter.chunkSizeHelp')}
            >
              {t('knowledge:document.splitter.chunkSize')}
            </SettingLabel>
            <div className="flex items-center gap-2">
              <Input
                id="chunk-size"
                type="number"
                min={128}
                max={8192}
                value={flatConfig.chunk_size ?? DEFAULT_FLAT_CHUNK_CONFIG.chunk_size}
                onChange={e => handleFlatChunkSizeChange(parseInt(e.target.value) || 1024)}
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

          <div className="space-y-2">
            <SettingLabel
              htmlFor="chunk-overlap"
              help={t('knowledge:document.splitter.chunkOverlapHelp')}
            >
              {t('knowledge:document.splitter.chunkOverlap')}
            </SettingLabel>
            <div className="flex items-center gap-2">
              <Input
                id="chunk-overlap"
                type="number"
                min={0}
                max={(flatConfig.chunk_size ?? DEFAULT_FLAT_CHUNK_CONFIG.chunk_size ?? 1024) - 1}
                value={flatConfig.chunk_overlap ?? DEFAULT_FLAT_CHUNK_CONFIG.chunk_overlap}
                onChange={e => handleFlatChunkOverlapChange(parseInt(e.target.value) || 0)}
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
          </div>

          <div className="space-y-2">
            <SettingLabel htmlFor="separator" help={t('knowledge:document.splitter.separatorHelp')}>
              {t('knowledge:document.splitter.separator')}
            </SettingLabel>
            <Input
              id="separator"
              value={encodeSeparatorForDisplay(
                flatConfig.separator ?? DEFAULT_FLAT_CHUNK_CONFIG.separator
              )}
              onChange={e => handleSeparatorChange(decodeSeparatorFromDisplay(e.target.value))}
              disabled={readOnly}
              data-testid="flat-separator-input"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.separatorHint')}
            </p>
          </div>
        </>
      )}

      {chunkStrategy === 'hierarchical' && (
        <>
          <div className="space-y-2">
            <SettingLabel
              htmlFor="parent-chunk-size"
              help={t('knowledge:document.splitter.parentChunkSizeHelp')}
            >
              {t('knowledge:document.splitter.parentChunkSize')}
            </SettingLabel>
            <div className="flex items-center gap-2">
              <Input
                id="parent-chunk-size"
                type="number"
                min={256}
                max={16384}
                value={
                  hierarchicalConfig.parent_chunk_size ??
                  DEFAULT_HIERARCHICAL_CHUNK_CONFIG.parent_chunk_size
                }
                onChange={e => handleParentChunkSizeChange(parseInt(e.target.value) || 256)}
                disabled={readOnly}
                className="flex-1"
              />
              <span className="text-sm text-text-secondary whitespace-nowrap">
                {t('knowledge:document.splitter.characters')}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <SettingLabel
              htmlFor="child-chunk-size"
              help={t('knowledge:document.splitter.childChunkSizeHelp')}
            >
              {t('knowledge:document.splitter.childChunkSize')}
            </SettingLabel>
            <div className="flex items-center gap-2">
              <Input
                id="child-chunk-size"
                type="number"
                min={128}
                max={8192}
                value={
                  hierarchicalConfig.child_chunk_size ??
                  DEFAULT_HIERARCHICAL_CHUNK_CONFIG.child_chunk_size
                }
                onChange={e => handleChildChunkSizeChange(parseInt(e.target.value) || 128)}
                disabled={readOnly}
                className="flex-1"
              />
              <span className="text-sm text-text-secondary whitespace-nowrap">
                {t('knowledge:document.splitter.characters')}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <SettingLabel
              htmlFor="child-chunk-overlap"
              help={t('knowledge:document.splitter.childChunkOverlapHelp')}
            >
              {t('knowledge:document.splitter.childChunkOverlap')}
            </SettingLabel>
            <div className="flex items-center gap-2">
              <Input
                id="child-chunk-overlap"
                type="number"
                min={0}
                max={
                  (hierarchicalConfig.child_chunk_size ??
                    DEFAULT_HIERARCHICAL_CHUNK_CONFIG.child_chunk_size ??
                    512) - 1
                }
                value={
                  hierarchicalConfig.child_chunk_overlap ??
                  DEFAULT_HIERARCHICAL_CHUNK_CONFIG.child_chunk_overlap
                }
                onChange={e => handleChildChunkOverlapChange(parseInt(e.target.value) || 0)}
                disabled={readOnly}
                className="flex-1"
              />
              <span className="text-sm text-text-secondary whitespace-nowrap">
                {t('knowledge:document.splitter.characters')}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <SettingLabel
              htmlFor="parent-separator"
              help={t('knowledge:document.splitter.parentSeparatorHelp')}
            >
              {t('knowledge:document.splitter.parentSeparator')}
            </SettingLabel>
            <Input
              id="parent-separator"
              value={encodeSeparatorForDisplay(
                hierarchicalConfig.parent_separator ??
                  DEFAULT_HIERARCHICAL_CHUNK_CONFIG.parent_separator
              )}
              onChange={e =>
                handleParentSeparatorChange(decodeSeparatorFromDisplay(e.target.value))
              }
              disabled={readOnly}
              data-testid="parent-separator-input"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.parentSeparatorHint')}
            </p>
          </div>

          <div className="space-y-2">
            <SettingLabel
              htmlFor="child-separator"
              help={t('knowledge:document.splitter.childSeparatorHelp')}
            >
              {t('knowledge:document.splitter.childSeparator')}
            </SettingLabel>
            <Input
              id="child-separator"
              value={encodeSeparatorForDisplay(
                hierarchicalConfig.child_separator ??
                  DEFAULT_HIERARCHICAL_CHUNK_CONFIG.child_separator
              )}
              onChange={e => handleChildSeparatorChange(decodeSeparatorFromDisplay(e.target.value))}
              disabled={readOnly}
              data-testid="child-separator-input"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.childSeparatorHint')}
            </p>
          </div>
        </>
      )}

      {chunkStrategy === 'semantic' && (
        <>
          <div className="space-y-2">
            <SettingLabel
              htmlFor="buffer-size"
              help={t('knowledge:document.splitter.bufferSizeHelp')}
            >
              {t('knowledge:document.splitter.bufferSize')}
            </SettingLabel>
            <div className="flex items-center gap-2">
              <Input
                id="buffer-size"
                type="number"
                min={1}
                max={10}
                value={semanticConfig.buffer_size ?? DEFAULT_SEMANTIC_CHUNK_CONFIG.buffer_size}
                onChange={e => handleBufferSizeChange(parseInt(e.target.value) || 1)}
                disabled={readOnly}
                className="flex-1"
              />
            </div>
            <p className="text-xs text-text-muted">
              {t('knowledge:document.splitter.bufferSizeHint')}
            </p>
          </div>

          <div className="space-y-2">
            <SettingLabel
              htmlFor="breakpoint-threshold"
              help={t('knowledge:document.splitter.breakpointThresholdHelp')}
            >
              {t('knowledge:document.splitter.breakpointThreshold')}
            </SettingLabel>
            <div className="flex items-center gap-2">
              <Input
                id="breakpoint-threshold"
                type="number"
                min={50}
                max={100}
                value={
                  semanticConfig.breakpoint_percentile_threshold ??
                  DEFAULT_SEMANTIC_CHUNK_CONFIG.breakpoint_percentile_threshold
                }
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

      <div className="flex items-center gap-1">
        <Checkbox
          id="file-aware"
          checked={fileAwareEnabled}
          onCheckedChange={checked => handleFileAwareChange(Boolean(checked))}
          disabled={readOnly}
          data-testid="file-aware-checkbox"
        />
        <SettingLabel htmlFor="file-aware" help={t('knowledge:document.splitter.fileAwareHelp')}>
          {t('knowledge:document.splitter.fileAware')}
        </SettingLabel>
      </div>

      <div className="flex items-center gap-1">
        <Checkbox
          id="title-enhancement"
          checked={titleEnhancementEnabled}
          onCheckedChange={checked => handleTitleEnhancementChange(Boolean(checked))}
          disabled={readOnly || !fileAwareEnabled}
          data-testid="title-enhancement-checkbox"
        />
        <SettingLabel
          htmlFor="title-enhancement"
          help={t('knowledge:document.splitter.titleEnhancementHelp')}
        >
          {t('knowledge:document.splitter.titleEnhancement')}
        </SettingLabel>
      </div>
    </div>
  )
}
