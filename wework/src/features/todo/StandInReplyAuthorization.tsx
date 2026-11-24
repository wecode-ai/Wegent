import type { StandInHandlingPolicy, StandInReplyTemplate } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { useState } from 'react'

const replyTemplates: StandInReplyTemplate[] = [
  'document_entry',
  'confirmed_time_place',
  'standard_process',
]

export function StandInReplyAuthorization({
  name,
  policy,
  disabled,
  supportsAutonomousReply = false,
  testId,
  onChange,
}: {
  name: string
  policy: StandInHandlingPolicy
  disabled: boolean
  supportsAutonomousReply?: boolean
  testId: string
  onChange(policy: StandInHandlingPolicy): void
}) {
  const { t } = useTranslation('common')
  const [confirming, setConfirming] = useState(false)
  const active = supportsAutonomousReply && policy.automatic && !policy.askBeforeAct
  const selectedTemplates = policy.replyTemplates ?? replyTemplates
  return (
    <>
      <SettingsRow
        className="px-0"
        label={t('standIn.authorization.confirm_each')}
        description={!policy.askBeforeAct ? t('standIn.authorization.continuous') : undefined}
        children={
          <SettingsSwitch
            data-testid={`${testId}-confirm-replies`}
            disabled={disabled}
            aria-label={t('standIn.authorization.for_source', { name })}
            checked={policy.askBeforeAct}
            onCheckedChange={confirm => {
              if (confirm) {
                onChange({
                  ...policy,
                  askBeforeAct: true,
                  ...(policy.autonomousReply ? { autonomousReply: false } : {}),
                })
              } else setConfirming(true)
            }}
          />
        }
      />
      {active && (
        <>
          <SettingsRow
            className="px-0"
            label={t('standIn.workspace.enable_autonomous_reply', { name })}
          >
            <SettingsSwitch
              data-testid={`${testId}-autonomous-reply`}
              aria-label={t('standIn.workspace.enable_autonomous_reply', { name })}
              disabled={disabled}
              checked={policy.autonomousReply === true}
              onCheckedChange={autonomousReply => onChange({ ...policy, autonomousReply })}
            />
          </SettingsRow>
          {policy.autonomousReply && (
            <fieldset className="space-y-1 border-0 text-sm" disabled={disabled}>
              <legend className="text-text-secondary">
                {t('standIn.workspace.reply_templates')}
              </legend>
              {replyTemplates.map(template => (
                <label key={template} className="flex min-h-11 items-center gap-2 md:min-h-8">
                  <Checkbox
                    data-testid={`${testId}-reply-template-${template}`}
                    aria-label={t(`standIn.workspace.reply_template_${template}`)}
                    checked={selectedTemplates.includes(template)}
                    disabled={disabled}
                    onCheckedChange={checked =>
                      onChange({
                        ...policy,
                        replyTemplates:
                          checked === true
                            ? [...selectedTemplates, template]
                            : selectedTemplates.filter(value => value !== template),
                      })
                    }
                  />
                  {t(`standIn.workspace.reply_template_${template}`)}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title={t('standIn.authorization.allow_title')}
        description={t('standIn.authorization.allow_description', { name })}
        cancelLabel={t('standIn.close')}
        confirmLabel={t('standIn.authorization.allow')}
        confirmTestId={`${testId}-allow-replies`}
        dialogTestId={`${testId}-authorization-dialog`}
        confirmDisabled={disabled}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          if (disabled) return
          onChange({ ...policy, askBeforeAct: false })
          setConfirming(false)
        }}
      />
    </>
  )
}
