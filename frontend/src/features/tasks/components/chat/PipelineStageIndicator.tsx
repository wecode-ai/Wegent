// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useEffect, useState, useMemo } from 'react'
import { CheckCircle2, Circle, Loader2, Clock, XCircle, PlayCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { taskApis, PipelineStageInfo } from '@/apis/tasks'
import { cn } from '@/lib/utils'

interface PipelineStageIndicatorProps {
  taskId: number | null
  taskStatus: string | null
  collaborationModel?: string
  /** Callback when stage info changes - allows parent to access pipeline state */
  onStageInfoChange?: (stageInfo: PipelineStageInfo | null) => void
}

/**
 * Extended stage type that includes the "start" node
 */
interface DisplayStage {
  index: number
  name: string
  require_confirmation: boolean
  status: 'pending' | 'running' | 'completed' | 'failed' | 'pending_confirmation' | 'start'
  isStartNode?: boolean
}

/**
 * Pipeline Stage Indicator Component
 *
 * Displays the current stage progress for pipeline mode teams.
 * Shows stage names, progress, and confirmation status.
 * Includes a "Start" node at the beginning to show the full pipeline flow.
 */
const PipelineStageIndicator = memo(function PipelineStageIndicator({
  taskId,
  taskStatus,
  collaborationModel,
  onStageInfoChange,
}: PipelineStageIndicatorProps) {
  const { t } = useTranslation('chat')
  const [stageInfo, setStageInfo] = useState<PipelineStageInfo | null>(null)
  const [_loading, setLoading] = useState(false)

  // Fetch pipeline stage info when task changes or status updates
  useEffect(() => {
    if (!taskId || collaborationModel !== 'pipeline') {
      setStageInfo(null)
      onStageInfoChange?.(null)
      return
    }

    const fetchStageInfo = async () => {
      setLoading(true)
      try {
        const info = await taskApis.getPipelineStageInfo(taskId)
        setStageInfo(info)
        onStageInfoChange?.(info)
      } catch (error) {
        console.error('Failed to fetch pipeline stage info:', error)
        setStageInfo(null)
        onStageInfoChange?.(null)
      } finally {
        setLoading(false)
      }
    }

    fetchStageInfo()
  }, [taskId, taskStatus, collaborationModel, onStageInfoChange])

  // Build display stages with "Start" node prepended
  const displayStages = useMemo((): DisplayStage[] => {
    if (!stageInfo) return []

    // Create the "Start" node - always completed once pipeline has started
    const startNode: DisplayStage = {
      index: -1, // Special index for start node
      name: t('pipeline.start_node'),
      require_confirmation: false,
      status: 'start', // Special status for start node (always shows as completed)
      isStartNode: true,
    }

    // Map original stages with adjusted indices for display
    const botStages: DisplayStage[] = stageInfo.stages.map(stage => ({
      ...stage,
      isStartNode: false,
    }))

    return [startNode, ...botStages]
  }, [stageInfo, t])

  // Don't render if not a pipeline task or no stage info
  if (!stageInfo || stageInfo.total_stages <= 1) {
    return null
  }

  const getStageIcon = (stage: DisplayStage, isCurrentStage: boolean) => {
    // Start node always shows as completed (green checkmark)
    if (stage.isStartNode) {
      return <PlayCircle className="h-4 w-4 text-green-500" />
    }

    switch (stage.status) {
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />
      case 'running':
        return <Loader2 className="h-4 w-4 text-primary animate-spin" />
      case 'pending_confirmation':
        return <Clock className="h-4 w-4 text-amber-500" />
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />
      case 'pending':
      default:
        return (
          <Circle className={cn('h-4 w-4', isCurrentStage ? 'text-primary' : 'text-text-muted')} />
        )
    }
  }

  const getStatusLabel = (stage: DisplayStage) => {
    if (stage.isStartNode) {
      return t('pipeline.stage_started')
    }

    switch (stage.status) {
      case 'completed':
        return t('pipeline.stage_completed')
      case 'running':
        return t('pipeline.stage_running')
      case 'pending_confirmation':
        return t('pipeline.stage_awaiting_confirmation')
      case 'failed':
        return t('pipeline.stage_failed')
      case 'pending':
      default:
        return t('pipeline.stage_pending')
    }
  }

  /**
   * Get connector line style based on the next (target) stage's status.
   * The connector color follows the status of the stage it's pointing to.
   *
   * @param displayIndex - The index of the current stage (connector is on its right side)
   * @returns Object with className
   */
  const getConnectorStyle = (displayIndex: number): { className: string } => {
    const targetStage = displayStages[displayIndex + 1]
    if (!targetStage) {
      return { className: 'bg-border' }
    }

    switch (targetStage.status) {
      case 'start':
        return { className: 'bg-green-500' }
      case 'completed':
        return { className: 'bg-green-500' }
      case 'running':
        return { className: 'bg-primary' }
      case 'pending_confirmation':
        return { className: 'bg-amber-500' }
      case 'failed':
        return { className: 'bg-red-500' }
      case 'pending':
      default:
        return { className: 'bg-border' }
    }
  }

  // Get text color based on stage status
  const getStageTextColor = (stage: DisplayStage, isCurrentStage: boolean) => {
    if (stage.isStartNode) {
      return 'text-green-600 dark:text-green-400'
    }
    switch (stage.status) {
      case 'completed':
        return 'text-green-600 dark:text-green-400'
      case 'running':
        return 'text-primary font-medium'
      case 'pending_confirmation':
        return 'text-amber-600 dark:text-amber-400'
      case 'failed':
        return 'text-red-600 dark:text-red-400'
      case 'pending':
      default:
        return isCurrentStage ? 'text-primary' : 'text-text-muted'
    }
  }

  return (
    <div className="px-4 py-2 bg-surface/50 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-secondary">
          {t('pipeline.progress_label')} ({stageInfo.current_stage + 1}/{stageInfo.total_stages})
        </span>
      </div>

      {/* Stage Progress Bar - includes Start node + all bot stages */}
      <div className="flex items-center w-full">
        {displayStages.map((stage, displayIndex) => {
          // For current stage check, we need to account for the start node offset
          // displayIndex 0 is start node, displayIndex 1 is stage 0, etc.
          const isCurrentStage = !stage.isStartNode && stage.index === stageInfo.current_stage
          const isLastStage = displayIndex === displayStages.length - 1
          const isPendingConfirmation = stage.status === 'pending_confirmation'
          const connectorStyle = !isLastStage ? getConnectorStyle(displayIndex) : null

          return (
            <div
              key={stage.isStartNode ? 'start' : stage.index}
              className={cn(
                'flex items-center',
                // Last stage doesn't need flex-1, just the icon
                isLastStage ? 'flex-shrink-0' : 'flex-1'
              )}
            >
              {/* Stage Node with Icon and Label */}
              <div
                className={cn(
                  'flex flex-col items-center relative group flex-shrink-0',
                  isCurrentStage && 'scale-105'
                )}
              >
                {/* Awaiting Confirmation Label - shown above the node */}
                {isPendingConfirmation && (
                  <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap mb-1">
                    {t('pipeline.awaiting_confirmation')}
                  </span>
                )}

                {/* Icon */}
                {getStageIcon(stage, isCurrentStage)}

                {/* Stage Name Label */}
                <span
                  className={cn(
                    'text-[10px] mt-1 whitespace-nowrap',
                    getStageTextColor(stage, isCurrentStage)
                  )}
                >
                  {stage.name}
                </span>

                {/* Tooltip for additional info */}
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10">
                  <div className="bg-fill-tert text-text-primary text-xs px-2 py-1 rounded whitespace-nowrap shadow-lg">
                    <div className="font-medium">{stage.name}</div>
                    <div className="text-text-muted">{getStatusLabel(stage)}</div>
                    {stage.require_confirmation && !stage.isStartNode && (
                      <div className="text-amber-500 text-[10px] mt-0.5">
                        {t('pipeline.requires_confirmation')}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Connector Line (not after last stage) */}
              {connectorStyle && (
                <div
                  className={cn(
                    'flex-1 h-0.5 mx-1 min-w-[20px] transition-colors duration-300',
                    isPendingConfirmation ? 'self-center' : 'self-start mt-2',
                    connectorStyle.className
                  )}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default PipelineStageIndicator
