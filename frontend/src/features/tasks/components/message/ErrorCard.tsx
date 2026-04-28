// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ErrorCard — User-friendly error display for failed AI messages.
 *
 * Features:
 * - Friendly error summary (i18n)
 * - Collapsible raw error details
 * - Copy diagnostic JSON for developer
 * - Error-type-specific recommended solutions (model switch, new conversation, retry)
 * - Interaction state management (interacted cards collapse and gray out)
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  RefreshCw,
  Check,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import type { UnifiedModel } from '@/apis/models'
import type { Team } from '@/types/api'
import { parseError, getErrorDisplayMessage, type ErrorType } from '@/utils/errorParser'
import {
  buildErrorCardInteractionId,
  markErrorInteracted,
  isErrorInteracted,
  cleanupStaleEntries,
} from '@/utils/errorCardState'
import { useErrorRecommendations } from '@/features/tasks/hooks/useErrorRecommendations'

import type { Message } from './MessageBubble'

export interface ErrorCardProps {
  error: string
  errorType?: string
  subtaskId?: number
  taskId?: number
  timestamp: number
  message: Message
  selectedTeam?: Team | null
  isLastErrorMessage: boolean
  onRetry?: (message: Message) => boolean | void | Promise<boolean | void>
  onRetryWithModel?: (
    message: Message,
    model: UnifiedModel
  ) => boolean | void | Promise<boolean | void>
}

function isRetryActionSuccessful(result: boolean | void): boolean {
  return result !== false
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'

    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()

    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      document.body.removeChild(textarea)
    }
  }
}

// Error types that should show "new conversation" button
const NEW_CONVERSATION_ERROR_TYPES = new Set<ErrorType>([
  'context_length_exceeded',
  'container_oom',
  'container_error',
])

export function ErrorCard({
  error,
  errorType,
  subtaskId,
  taskId,
  timestamp,
  message,
  isLastErrorMessage,
  onRetry,
  onRetryWithModel,
}: ErrorCardProps) {
  const { t } = useTranslation('chat')
  const { user } = useUser()
  const { getRecommendedModels, isLoading: areRecommendationsLoading } = useErrorRecommendations()

  const parsedError = useMemo(() => parseError(error, errorType), [error, errorType])
  const interactionId = useMemo(() => {
    if (!subtaskId) {
      return null
    }

    return buildErrorCardInteractionId(subtaskId, timestamp)
  }, [subtaskId, timestamp])

  const getStoredInteractionState = useCallback(() => {
    if (!isLastErrorMessage) {
      return true
    }
    if (!interactionId) {
      return false
    }

    cleanupStaleEntries()
    return isErrorInteracted(interactionId)
  }, [interactionId, isLastErrorMessage])

  // Determine initial state: non-last always collapsed, last checks localStorage
  const [isInteracted, setIsInteracted] = useState(getStoredInteractionState)

  useEffect(() => {
    setIsInteracted(getStoredInteractionState())
  }, [getStoredInteractionState])

  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)

  const friendlyMessage = useMemo(
    () => getErrorDisplayMessage(error, (key: string) => t(key), errorType),
    [error, errorType, t]
  )

  const recommendationErrorType = errorType?.trim() || parsedError.type

  const recommendedModels = useMemo(
    () => getRecommendedModels(recommendationErrorType),
    [recommendationErrorType, getRecommendedModels]
  )

  const showNewConversation = NEW_CONVERSATION_ERROR_TYPES.has(parsedError.type)
  const showRetry = !!onRetry && !areRecommendationsLoading

  const hintKey = useMemo(() => {
    switch (parsedError.type) {
      case 'context_length_exceeded':
        return t('errors.context_length_hint')
      case 'quota_exceeded':
        return t('errors.quota_hint')
      case 'rate_limit':
        return t('errors.rate_limit_hint')
      case 'content_filter':
        return t('errors.content_filter_hint')
      case 'provider_error':
        return t('errors.provider_error_hint')
      case 'image_too_large':
        return t('errors.image_too_large_hint')
      case 'model_protocol_error':
        return t('errors.model_protocol_error_hint')
      case 'invalid_role':
        return t('errors.invalid_role_hint')
      case 'permission_denied':
        return t('errors.permission_denied_hint')
      default:
        return null
    }
  }, [parsedError.type, t])

  const collapseCard = useCallback(
    (action: string, persist: boolean = false) => {
      if (persist && interactionId) {
        markErrorInteracted(interactionId, action)
      }
      setIsInteracted(true)
    },
    [interactionId]
  )

  const handleRetryWithModel = useCallback(
    async (model: UnifiedModel) => {
      try {
        const result = await onRetryWithModel?.(message, model)
        if (isRetryActionSuccessful(result)) {
          collapseCard('switch_model')
        }
      } catch (retryError) {
        console.error('[ErrorCard] Retry with model failed:', retryError)
      }
    },
    [collapseCard, onRetryWithModel, message]
  )

  const handleNewConversation = useCallback(() => {
    collapseCard('new_conversation', true)
    window.open('/chat', '_blank')
  }, [collapseCard])

  const handleRetry = useCallback(() => {
    void (async () => {
      try {
        const result = await onRetry?.(message)
        if (isRetryActionSuccessful(result)) {
          collapseCard('retry')
        }
      } catch (retryError) {
        console.error('[ErrorCard] Retry failed:', retryError)
      }
    })()
  }, [collapseCard, onRetry, message])

  const isCollapsed = isInteracted

  if (isCollapsed) {
    return (
      <ErrorCardCollapsed
        friendlyMessage={friendlyMessage}
        resolvedLabel={t('errors.card_resolved')}
        onExpand={() => setIsInteracted(false)}
      />
    )
  }

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/20 p-4 space-y-3"
      data-testid="error-card"
    >
      <ErrorCardSummary message={friendlyMessage} />
      <ErrorCardDetails
        error={error}
        expanded={detailsExpanded}
        onToggle={() => setDetailsExpanded(v => !v)}
        label={t('errors.error_details')}
      />
      <ErrorCardCopyDeveloper
        error={error}
        errorType={errorType ?? parsedError.type}
        subtaskId={subtaskId}
        taskId={taskId}
        timestamp={timestamp}
        userId={user?.id}
        userName={user?.user_name}
        label={t('errors.copy_diagnostic')}
        successLabel={t('errors.copy_diagnostic_success')}
        copySuccess={copySuccess}
        onCopySuccess={setCopySuccess}
      />
      {(hintKey || recommendedModels.length > 0 || showNewConversation || showRetry) && (
        <ErrorCardSolutions
          hint={hintKey}
          recommendedModels={recommendedModels}
          showNewConversation={showNewConversation}
          showRetry={showRetry}
          onRetryWithModel={handleRetryWithModel}
          onNewConversation={handleNewConversation}
          onRetry={handleRetry}
          t={t}
        />
      )}
    </div>
  )
}

// --- Sub-components ---

function ErrorCardCollapsed({
  friendlyMessage,
  resolvedLabel,
  onExpand,
}: {
  friendlyMessage: string
  resolvedLabel: string
  onExpand: () => void
}) {
  return (
    <button
      onClick={onExpand}
      className="w-full flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/30 p-3 opacity-50 hover:opacity-70 transition-opacity cursor-pointer text-left"
      data-testid="error-card-collapsed"
    >
      <AlertTriangle className="h-4 w-4 text-gray-400 flex-shrink-0" />
      <span className="text-sm text-gray-500 dark:text-gray-400 truncate flex-1">
        {friendlyMessage}
      </span>
      <span className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">
        {resolvedLabel}
      </span>
    </button>
  )
}

function ErrorCardSummary({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2">
      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
      <p className="text-sm font-medium text-amber-800 dark:text-amber-200">{message}</p>
    </div>
  )
}

function ErrorCardDetails({
  error,
  expanded,
  onToggle,
  label,
}: {
  error: string
  expanded: boolean
  onToggle: () => void
  label: string
}) {
  return (
    <div className="pl-7">
      <button
        onClick={onToggle}
        className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 transition-colors cursor-pointer"
        data-testid="error-card-toggle-details"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {expanded && (
        <pre className="mt-2 p-2 rounded bg-amber-100/50 dark:bg-amber-900/20 text-xs text-amber-700 dark:text-amber-300 whitespace-pre-wrap break-all max-h-40 overflow-auto">
          {error}
        </pre>
      )}
    </div>
  )
}

function ErrorCardCopyDeveloper({
  error,
  errorType,
  subtaskId,
  taskId,
  timestamp,
  userId,
  userName,
  label,
  successLabel,
  copySuccess,
  onCopySuccess,
}: {
  error: string
  errorType: string
  subtaskId?: number
  taskId?: number
  timestamp: number
  userId?: number
  userName?: string
  label: string
  successLabel: string
  copySuccess: boolean
  onCopySuccess: (v: boolean) => void
}) {
  const handleCopy = useCallback(async () => {
    const diagnosticInfo = {
      userId: userId ?? null,
      username: userName || 'unknown',
      taskId: taskId ?? null,
      subtaskId: subtaskId ?? null,
      timestamp: new Date(timestamp).toISOString(),
      errorType,
      errorMessage: error,
    }
    const copied = await copyTextWithFallback(JSON.stringify(diagnosticInfo, null, 2))
    if (copied) {
      onCopySuccess(true)
      setTimeout(() => onCopySuccess(false), 2000)
    }
  }, [error, errorType, subtaskId, taskId, timestamp, userId, userName, onCopySuccess])

  return (
    <div className="pl-7">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className="h-8 px-2 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30"
        data-testid="error-card-copy-developer"
      >
        {copySuccess ? (
          <Check className="h-3.5 w-3.5 mr-1" />
        ) : (
          <ClipboardCopy className="h-3.5 w-3.5 mr-1" />
        )}
        {copySuccess ? successLabel : label}
      </Button>
    </div>
  )
}

function ErrorCardSolutions({
  hint,
  recommendedModels,
  showNewConversation,
  showRetry,
  onRetryWithModel,
  onNewConversation,
  onRetry,
  t,
}: {
  hint: string | null
  recommendedModels: UnifiedModel[]
  showNewConversation: boolean
  showRetry: boolean
  onRetryWithModel: (model: UnifiedModel) => void
  onNewConversation: () => void
  onRetry: () => void
  t: (key: string, opts?: Record<string, string>) => string
}) {
  return (
    <div className="pl-7 space-y-2">
      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
        {t('errors.solutions_title')}
      </p>
      {hint && <p className="text-xs text-amber-600 dark:text-amber-400">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        {recommendedModels.map(model => (
          <Button
            key={model.name}
            variant="outline"
            size="sm"
            onClick={() => onRetryWithModel(model)}
            className="h-9 min-w-[44px] text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            data-testid={`error-card-model-recommend-${model.name}`}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            {t('errors.switch_model_retry', { model: model.displayName || model.name })}
          </Button>
        ))}
        {showNewConversation && (
          <Button
            variant="outline"
            size="sm"
            onClick={onNewConversation}
            className="h-9 min-w-[44px] text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            data-testid="error-card-new-conversation"
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            {t('errors.new_conversation')}
          </Button>
        )}
        {showRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="h-9 min-w-[44px] text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            data-testid="error-card-retry"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            {t('errors.retry_with_current_model')}
          </Button>
        )}
      </div>
    </div>
  )
}
