// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Copy, Check, Plus, Star, RefreshCw, Edit3, X, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FinalPromptData, Team, GitRepoInfo, GitBranch } from '@/types/api'
import MarkdownEditor from '@uiw/react-markdown-editor'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { taskApis } from '@/apis/tasks'
import { Textarea } from '@/components/ui/textarea'

interface FinalPromptMessageProps {
  data: FinalPromptData
  selectedTeam?: Team | null
  selectedRepo?: GitRepoInfo | null
  selectedBranch?: GitBranch | null
  // Pipeline mode props
  taskId?: number | null
  /**
   * Whether the current pipeline stage is pending confirmation.
   * This is the single source of truth from pipeline_stage_info.is_pending_confirmation.
   * When true, shows the "Confirm" button instead of "Create Task" button.
   */
  isPendingConfirmation?: boolean
  onStageConfirmed?: () => void
}

export default function FinalPromptMessage({
  data,
  selectedTeam,
  selectedRepo,
  selectedBranch,
  taskId = null,
  isPendingConfirmation = false,
  onStageConfirmed,
}: FinalPromptMessageProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()
  const { theme } = useTheme()
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState(data.final_prompt)
  const [isConfirming, setIsConfirming] = useState(false)
  // Track if confirmation was already submitted to prevent duplicate submissions
  const [hasConfirmed, setHasConfirmed] = useState(false)

  // Single source of truth: isPendingConfirmation from pipeline_stage_info.is_pending_confirmation
  const showPipelineActions = isPendingConfirmation

  const handleCopy = async () => {
    try {
      const textToCopy = isEditing ? editedPrompt : data.final_prompt
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        navigator.clipboard.writeText
      ) {
        await navigator.clipboard.writeText(textToCopy)
      } else {
        // Fallback
        const textarea = document.createElement('textarea')
        textarea.value = textToCopy
        textarea.style.cssText = 'position:fixed;opacity:0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      toast({
        title: t('clarification.prompt_copied'),
      })
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy prompt:', err)
      toast({
        variant: 'destructive',
        title: t('clarification.copy_failed'),
      })
    }
  }

  const handleCreateTask = () => {
    if (!selectedTeam || !selectedRepo || !selectedBranch) {
      toast({
        title: t('clarification.select_context'),
      })
      return
    }

    // Store prompt data in sessionStorage for the new task page
    const promptData = {
      prompt: isEditing ? editedPrompt : data.final_prompt,
      teamId: selectedTeam.id,
      repoId: selectedRepo.git_repo_id,
      branch: selectedBranch.name,
      timestamp: Date.now(),
    }

    sessionStorage.setItem('pendingTaskPrompt', JSON.stringify(promptData))

    // Navigate to new task page
    router.push('/code')

    toast({
      title: t('clarification.prompt_ready'),
    })
  }

  const handleContinueToNextStage = async () => {
    // Prevent duplicate submissions
    if (hasConfirmed) {
      return
    }

    if (!taskId) {
      toast({
        variant: 'destructive',
        title: t('pipeline.no_task_id'),
      })
      return
    }

    setIsConfirming(true)
    try {
      const response = await taskApis.confirmPipelineStage(taskId, {
        confirmed_prompt: isEditing ? editedPrompt : data.final_prompt,
        action: 'continue',
      })

      // Mark as confirmed to prevent duplicate submissions
      // This keeps the button disabled until the component unmounts or isPendingConfirmation becomes false
      setHasConfirmed(true)

      toast({
        title: t('pipeline.stage_confirmed'),
        description: response.next_stage_name
          ? t('pipeline.proceeding_to_stage', { stage: response.next_stage_name })
          : t('pipeline.pipeline_completed'),
      })

      onStageConfirmed?.()
    } catch (error) {
      console.error('Failed to confirm stage:', error)
      toast({
        variant: 'destructive',
        title: t('pipeline.confirm_failed'),
      })
    } finally {
      setIsConfirming(false)
    }
  }

  const handleStartEdit = () => {
    setEditedPrompt(data.final_prompt)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setEditedPrompt(data.final_prompt)
    setIsEditing(false)
  }

  const handleSaveEdit = () => {
    setIsEditing(false)
    // Keep edited prompt for submission
  }

  return (
    <div className="space-y-3 p-4 rounded-lg border-2 border-blue-500/50 bg-blue-500/10 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Star className="w-5 h-5 text-blue-400" />
          <h3 className="text-base font-semibold text-blue-400">
            {t('clarification.final_prompt_title')}
          </h3>
        </div>
        {showPipelineActions && !isEditing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleStartEdit}
            className="text-blue-400 hover:text-blue-300"
          >
            <Edit3 className="w-4 h-4 mr-1" />
            {t('pipeline.edit_prompt')}
          </Button>
        )}
      </div>

      {/* Prompt Content */}
      <div className="bg-surface/30 rounded p-3 border border-blue-500/20">
        {isEditing ? (
          <div className="space-y-2">
            <Textarea
              value={editedPrompt}
              onChange={e => setEditedPrompt(e.target.value)}
              className="min-h-[200px] bg-transparent border-none resize-y text-sm"
              placeholder={t('pipeline.edit_prompt_placeholder')}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
                <X className="w-4 h-4 mr-1" />
                {t('common:cancel')}
              </Button>
              <Button variant="secondary" size="sm" onClick={handleSaveEdit}>
                <Save className="w-4 h-4 mr-1" />
                {t('pipeline.save_changes')}
              </Button>
            </div>
          </div>
        ) : (
          <MarkdownEditor.Markdown
            source={data.final_prompt}
            style={{ background: 'transparent' }}
            wrapperElement={{ 'data-color-mode': theme }}
            components={{
              a: ({ href, children, ...props }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                  {children}
                </a>
              ),
            }}
          />
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-3 pt-2 flex-wrap">
        <Button variant="ghost" onClick={handleCopy} className={copied ? 'text-green-500' : ''}>
          {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
          {copied ? t('clarification.copied') : t('clarification.copy_prompt')}
        </Button>

        {showPipelineActions ? (
          <Button
            variant="default"
            onClick={handleContinueToNextStage}
            disabled={isConfirming || hasConfirmed}
            className="bg-primary hover:bg-primary/90"
          >
            {isConfirming || hasConfirmed ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Check className="w-4 h-4 mr-2" />
            )}
            {hasConfirmed ? t('pipeline.stage_confirming') : t('pipeline.confirm_stage')}
          </Button>
        ) : (
          <Button variant="secondary" onClick={handleCreateTask}>
            <Plus className="w-4 h-4 mr-2" />
            {t('clarification.create_task')}
          </Button>
        )}
      </div>

      {/* Hint */}
      <div className="text-xs text-text-tertiary italic">
        {showPipelineActions
          ? t('pipeline.confirmation_hint')
          : t('clarification.final_prompt_hint')}
      </div>
    </div>
  )
}
