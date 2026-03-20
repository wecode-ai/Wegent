// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Loader2, Info, Layers, Bot } from 'lucide-react'
import {
  EvaluationModelSelector,
  EvaluationMultiModelSelector,
  type MultiModelEntry,
} from '@wecode/components/evaluation/common/EvaluationModelSelector'
import { getAuthorGradingConfig } from '@wecode/api/evaluation-author'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface MultiStageRetryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  topicId: number | null
  onConfirm: (data: {
    gradingMode: 'single' | 'multi'
    modelId?: string
    forceOverride?: boolean
    scorerModels?: { model_id: string; force_override: boolean }[]
    aggregatorModel?: { model_id: string; force_override: boolean }
  }) => void | Promise<void>
  title?: string
  description?: string
  confirmText?: string
  cancelText?: string
  loading?: boolean
}

const GRADING_MODES = {
  SINGLE: 'single',
  MULTI: 'multi',
}

/**
 * Multi-Stage Retry Dialog for grading tasks.
 * Supports both single-model and multi-model (scorer + aggregator) retry.
 */
export function MultiStageRetryDialog({
  open,
  onOpenChange,
  topicId,
  onConfirm,
  title,
  description,
  confirmText,
  cancelText,
  loading = false,
}: MultiStageRetryDialogProps) {
  const { t } = useTranslation('evaluation')

  // Grading mode
  const [gradingMode, setGradingMode] = useState<'single' | 'multi'>('single')

  // Single model state
  const [singleModel, setSingleModel] = useState('')
  const [singleForceOverride, setSingleForceOverride] = useState(false)

  // Multi-model state
  const [scorerModels, setScorerModels] = useState<MultiModelEntry[]>([])
  const [aggregatorModel, setAggregatorModel] = useState('')
  const [aggregatorForceOverride, setAggregatorForceOverride] = useState(true)

  // Default config from topic
  const [defaultConfig, setDefaultConfig] = useState<{
    mode?: string
    singleModel?: string
    scorerModels?: string[]
    aggregatorModel?: string
  } | null>(null)

  // Reset and load config when dialog opens
  useEffect(() => {
    if (!open) return

    // Reset state
    setGradingMode('single')
    setSingleModel('')
    setSingleForceOverride(false)
    setScorerModels([])
    setAggregatorModel('')
    setAggregatorForceOverride(true)
    setDefaultConfig(null)

    if (!topicId) return

    // Load default config from topic
    const loadConfig = async () => {
      try {
        const config = await getAuthorGradingConfig(topicId)
        const mode = (config.grading_mode as 'single' | 'multi') || 'single'
        setGradingMode(mode)
        setDefaultConfig({
          mode,
          singleModel: config.model_id,
          scorerModels: config.scorer_models?.map(m => m.model_id) || [],
          aggregatorModel: config.aggregator_model?.model_id,
        })

        // Pre-fill with config values
        if (mode === 'single') {
          setSingleModel(config.model_id || '')
          setSingleForceOverride(config.force_override_bot_model || false)
        } else {
          // Multi-model
          if (config.scorer_models && config.scorer_models.length > 0) {
            setScorerModels(
              config.scorer_models.map((m, index) => ({
                id: `scorer-${index}-${Date.now()}`,
                modelId: m.model_id,
                forceOverride: m.force_override,
              }))
            )
          }
          if (config.aggregator_model) {
            setAggregatorModel(config.aggregator_model.model_id)
            setAggregatorForceOverride(config.aggregator_model.force_override)
          }
        }
      } catch (_error) {
        // Silently fail - user can manually configure
      }
    }

    loadConfig()
  }, [open, topicId])

  const handleConfirm = () => {
    if (gradingMode === 'single') {
      onConfirm({
        gradingMode: 'single',
        modelId: singleModel || undefined,
        forceOverride: singleForceOverride,
      })
    } else {
      onConfirm({
        gradingMode: 'multi',
        scorerModels:
          scorerModels.length > 0
            ? scorerModels.map(m => ({
                model_id: m.modelId,
                force_override: m.forceOverride,
              }))
            : undefined,
        aggregatorModel: aggregatorModel
          ? {
              model_id: aggregatorModel,
              force_override: aggregatorForceOverride,
            }
          : undefined,
      })
    }
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title || t('grading.retry_config') || '重试评分配置'}</DialogTitle>
          <DialogDescription>
            {description || t('grading.retry_config_description') || '选择评分模式并配置模型'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Grading Mode Selection */}
          <div className="space-y-2">
            <Label>{t('grading.grading_mode') || '评分模式'}</Label>
            <Select
              value={gradingMode}
              onValueChange={value => setGradingMode(value as 'single' | 'multi')}
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GRADING_MODES.SINGLE}>
                  {t('grading.single_mode') || '单模型评分'}
                </SelectItem>
                <SelectItem value={GRADING_MODES.MULTI}>
                  {t('grading.multi_mode') || '多模型评分'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Default Config Info */}
          {defaultConfig && (
            <div className="rounded-lg bg-surface border border-border p-3">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                <div className="text-sm space-y-1">
                  <p className="text-text-secondary">
                    {t('grading.default_config') || '专题默认配置'}:
                  </p>
                  {defaultConfig.mode === 'single' && defaultConfig.singleModel && (
                    <p className="font-medium text-text-primary">
                      {t('grading.single_model') || '单模型'}: {defaultConfig.singleModel}
                    </p>
                  )}
                  {defaultConfig.mode === 'multi' && (
                    <>
                      <p className="font-medium text-text-primary">
                        {t('grading.scorer_models') || '评分模型'}:{' '}
                        {defaultConfig.scorerModels?.length || 0} 个
                      </p>
                      {defaultConfig.aggregatorModel && (
                        <p className="font-medium text-text-primary">
                          {t('grading.aggregator_model') || '聚合模型'}:{' '}
                          {defaultConfig.aggregatorModel}
                        </p>
                      )}
                    </>
                  )}
                  <p className="text-text-muted text-xs mt-1">
                    {t('grading.use_default_or_custom') || '可使用默认配置或自定义覆盖'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Single Model Configuration */}
          {gradingMode === 'single' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                <Label className="font-medium">{t('grading.model_config') || '模型配置'}</Label>
              </div>
              <EvaluationModelSelector
                value={singleModel}
                onChange={(modelId, force) => {
                  setSingleModel(modelId)
                  setSingleForceOverride(force)
                }}
                forceOverride={singleForceOverride}
                disabled={loading}
                placeholder={t('grading.select_model') || '选择模型'}
              />
            </div>
          )}

          {/* Multi-Model Configuration */}
          {gradingMode === 'multi' && (
            <div className="space-y-4">
              {/* Stage 1: Scorer Models */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-blue-500" />
                  <Label className="font-medium">
                    {t('grading.stage1_scorer') || '阶段 1：评分模型'}
                  </Label>
                </div>
                <EvaluationMultiModelSelector
                  value={scorerModels}
                  onChange={setScorerModels}
                  disabled={loading}
                  maxModels={10}
                  minModels={0}
                />
              </div>

              {/* Stage 2: Aggregator Model */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-purple-500" />
                  <Label className="font-medium">
                    {t('grading.stage2_aggregator') || '阶段 2：聚合模型'}
                  </Label>
                </div>
                <EvaluationModelSelector
                  value={aggregatorModel}
                  onChange={(modelId, force) => {
                    setAggregatorModel(modelId)
                    setAggregatorForceOverride(force)
                  }}
                  forceOverride={aggregatorForceOverride}
                  disabled={loading}
                  placeholder={t('grading.select_aggregator_model') || '选择聚合模型'}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            {cancelText || t('common:actions.cancel', '取消')}
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('grading.retrying', '重试中...')}
              </>
            ) : (
              confirmText || t('grading.retry', '重试')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
