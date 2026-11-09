import { useState } from 'react'
import type { StandInHandlingPolicy } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInReplyAuthorization({
  name,
  policy,
  disabled,
  testId,
  onChange,
}: {
  name: string
  policy: StandInHandlingPolicy
  disabled: boolean
  testId: string
  onChange(policy: StandInHandlingPolicy): void
}) {
  const { t } = useTranslation('common')
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <SettingsRow
        className="px-0"
        label={t('standIn.authorization.confirm_each')}
        description={!policy.askBeforeAct ? t('standIn.authorization.continuous') : undefined}
        control={
          <SettingsSwitch
            data-testid={`${testId}-confirm-replies`}
            disabled={disabled}
            aria-label={t('standIn.authorization.for_source', { name })}
            checked={policy.askBeforeAct}
            onCheckedChange={confirm => {
              if (confirm) onChange({ ...policy, askBeforeAct: true })
              else setConfirming(true)
            }}
          />
        }
      />
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
