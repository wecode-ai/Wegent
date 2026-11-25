import { parseChatError, type ChatErrorInfo } from '@wegent/chat-core/chat-error'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { GitAccountConfigurationButton } from '../controls/GitAccountConfiguration'
import { Button as ControlButton } from '../markdown/Button'
import { useConversationTranslation } from './ConversationTranslation'

const primaryActionClass =
  'h-8 min-h-11 rounded-lg border border-text-primary bg-text-primary px-3 text-xs font-semibold text-background hover:bg-text-primary/90 md:min-h-8'
const secondaryActionClass =
  'h-8 min-h-11 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8'

export function AssistantErrorCard({
  error,
  errorType,
  errorInfo,
  rawError,
  message,
  onContinueInNewConversation,
  onRetry,
  onSwitchModel,
}: {
  error?: string
  errorInfo?: ChatErrorInfo
  errorType?: string
  rawError?: string
  message: WorkbenchMessage
  onContinueInNewConversation?: () => void
  onRetry?: (message: WorkbenchMessage) => void
  onSwitchModel?: (message: WorkbenchMessage) => void
}) {
  const { t, translate } = useConversationTranslation()
  const [isDetailExpanded, setIsDetailExpanded] = useState(false)
  const parsedError = parseChatError(rawError || error || '', errorType, errorInfo)
  const recommendsNewConversation =
    parsedError.type === 'invalid_message_history' || parsedError.type === 'invalid_role'
  const continueInNewConversation = recommendsNewConversation ? onContinueInNewConversation : undefined
  const displayError = parsedError.gitFailure
    ? `${parsedError.gitFailure.domain}: ${parsedError.gitFailure.message}`
    : rawError || error
  const hasErrorDetails = Boolean(displayError)
  const modelName =
    displayError?.match(/model_id:\s*([^"'}\s]+)/)?.[1] ??
    displayError?.match(/model(?:\s+|_id["':\s]+)([a-z0-9._:-]+)/i)?.[1]
  const title = t(parsedError.titleKey)
  const description = parsedError.gitFailure
    ? t(parsedError.descriptionKey, { domain: parsedError.gitFailure.domain })
    : parsedError.type === 'model_protocol_error' && modelName
      ? t('assistant_error.types.model_protocol_error.description_with_model', {
          model: modelName,
        })
      : parsedError.timeoutSeconds
        ? t(parsedError.descriptionKey, { seconds: parsedError.timeoutSeconds })
        : !hasErrorDetails && parsedError.type === 'generic_error'
          ? t('assistant_error.types.generic_error.description_without_details')
          : t(parsedError.descriptionKey)

  const prioritizeRetry = recommendsNewConversation && Boolean(onRetry)
  const switchModelAction = onSwitchModel && !parsedError.gitFailure && (
    <ControlButton
      key="switch-model"
      variant={prioritizeRetry ? 'outline' : 'primary'}
      size="sm"
      type="button"
      data-testid="assistant-error-switch-model-retry"
      onClick={() => onSwitchModel(message)}
      className={prioritizeRetry ? secondaryActionClass : primaryActionClass}
    >
      {t('assistant_error.actions.switch_model_retry')}
    </ControlButton>
  )
  const retryAction = onRetry && (
    <ControlButton
      key="retry"
      variant={prioritizeRetry ? 'primary' : 'outline'}
      size="sm"
      type="button"
      data-testid="assistant-error-retry"
      onClick={() => onRetry(message)}
      className={prioritizeRetry ? primaryActionClass : secondaryActionClass}
    >
      {t(
        parsedError.retryPolicy === 'after_change' && !recommendsNewConversation
          ? 'assistant_error.actions.retry_after_change'
          : 'assistant_error.actions.retry'
      )}
    </ControlButton>
  )

  return (
    <div
      data-testid="assistant-error-card"
      className="mt-2 flex w-[min(546px,100%)] max-w-full items-start gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 py-3 text-text-primary"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-base text-red-500 shadow-[inset_0_0_0_1px_rgb(var(--color-border))]">
        <AlertTriangle className="h-3 w-3" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          data-testid="assistant-error-title"
          className="text-sm font-semibold leading-5 text-text-primary"
        >
          {title}
        </p>
        <p
          data-testid="assistant-error-description"
          className="mt-0.5 break-words text-xs leading-[18px] text-text-secondary"
        >
          {continueInNewConversation
            ? t('assistant_error.types.invalid_message_history.description_with_action')
            : description}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <GitAccountConfigurationButton
            failure={parsedError.gitFailure}
            translate={translate}
            testId="assistant-error-configure-git"
          />
          {prioritizeRetry ? [retryAction, switchModelAction] : [switchModelAction, retryAction]}
          {continueInNewConversation && (
            <ControlButton
              variant="outline"
              size="sm"
              type="button"
              data-testid="assistant-error-continue-in-new-conversation"
              onClick={continueInNewConversation}
              className={secondaryActionClass}
            >
              {t('assistant_error.actions.continue_in_new_conversation')}
            </ControlButton>
          )}
          {hasErrorDetails && (
            <ControlButton
              variant="outline"
              size="sm"
              type="button"
              data-testid="assistant-error-details-toggle"
              aria-expanded={isDetailExpanded}
              onClick={() => setIsDetailExpanded(value => !value)}
              className="inline-flex h-8 min-h-11 items-center gap-1 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
            >
              <ChevronDown
                className={[
                  'h-3.5 w-3.5 transition-transform',
                  isDetailExpanded ? 'rotate-180' : '',
                ].join(' ')}
              />
              {t('assistant_error.details')}
            </ControlButton>
          )}
        </div>
        {hasErrorDetails && isDetailExpanded && (
          <pre
            data-testid="assistant-error-details"
            className={[
              'mt-2 max-w-full rounded-md bg-base px-2.5 py-1.5 font-mono text-xs leading-4 text-text-muted',
              'max-h-32 overflow-auto whitespace-pre-wrap break-words',
            ].join(' ')}
          >
            {displayError}
          </pre>
        )}
      </div>
    </div>
  )
}
