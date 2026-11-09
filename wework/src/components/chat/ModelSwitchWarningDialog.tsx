import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import type { useTranslation } from '@/hooks/useTranslation'
import type { ModelSwitchContinuation } from '@/features/workbench/modelSwitch'

export function ModelSwitchWarningDialog({
  t,
  targetModelLabel,
  continuation,
  onCancel,
  onConfirm,
}: {
  t: ReturnType<typeof useTranslation>['t']
  targetModelLabel: string
  continuation: ModelSwitchContinuation
  onCancel: () => void
  onConfirm: () => void
}) {
  const newConversation = continuation === 'new-conversation'
  const newSession = continuation === 'new-session'
  return createPortal(
    <div
      data-testid="model-switch-warning-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-switch-warning-dialog-title"
        aria-describedby="model-switch-warning-dialog-description"
        data-testid="model-switch-warning-dialog"
        className="w-full max-w-[400px] rounded-2xl border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.24)]"
      >
        <h2 id="model-switch-warning-dialog-title" className="heading-small text-text-primary">
          {newConversation
            ? t('workbench.model_switch_new_conversation_title', 'Continue in a new conversation?')
            : t('workbench.model_switch_warning_title', 'Switch model?')}
        </h2>
        <p
          id="model-switch-warning-dialog-description"
          className="mt-2 text-sm leading-5 text-text-secondary"
        >
          {continuation !== 'same-session'
            ? t(
                'workbench.model_switch_new_conversation_description',
                '{{model}} uses a different model provider, so it cannot continue this Codex thread directly.',
                { model: targetModelLabel }
              )
            : t(
                'workbench.model_switch_warning_description',
                'Switching to {{model}} may change how the existing context is understood. Tool support, response style, and task continuity may also differ.',
                { model: targetModelLabel }
              )}
        </p>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {newSession
            ? t('workbench.model_switch_new_session_effect')
            : newConversation
              ? t(
                  'workbench.model_switch_new_conversation_effect',
                  'Wework will open a new conversation, reference this conversation, and preserve the current draft.'
                )
              : t(
                  'workbench.model_switch_warning_effect',
                  'The new model will be used for the next message. If a response is in progress, it will continue with the current model.'
                )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="model-switch-warning-cancel-button"
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('workbench.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="model-switch-warning-confirm-button"
            onClick={onConfirm}
            className="h-8 rounded-lg bg-text-primary px-4 text-sm text-background hover:bg-text-primary/90"
          >
            {newConversation
              ? t('workbench.model_switch_new_conversation_confirm', 'Continue in new conversation')
              : t('workbench.model_switch_warning_confirm', 'Switch model')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
