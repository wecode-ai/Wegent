import type { StandInDelegationTemplate, StandInIdentity } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { delegationTemplates, dingTalkDelegationModel } from './dingtalkDelegation'

export function DingTalkDelegationControls({
  account,
  saved,
  draft,
  disabled,
  dirty,
  onToggleTemplate,
  onEnable,
  onPause,
}: {
  account: ConnectionProviderDescriptor['availability']
  saved: StandInIdentity
  draft: StandInIdentity
  disabled: boolean
  dirty: boolean
  onToggleTemplate(template: StandInDelegationTemplate, enabled: boolean): void
  onEnable(): void
  onPause(action: 'pause' | 'resume'): void
}) {
  const { t } = useTranslation('common')
  const model = dingTalkDelegationModel(saved, draft, account)
  const paused = saved.delegation?.paused === true
  const templateField = (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{t('standIn.dingtalk_delegation.templates')}</legend>
      {delegationTemplates.map(template => (
        <label
          key={template}
          className="flex min-h-11 items-center justify-between gap-3 py-1 text-sm md:min-h-9"
        >
          <span className="min-w-0">
            <span className="block font-medium">{t(`standIn.dingtalk_delegation.${template}`)}</span>
            <span className="block text-xs text-text-secondary">
              {t(`standIn.dingtalk_delegation.${template}_description`)}
            </span>
          </span>
          <Checkbox
            data-testid={`stand-in-delegation-template-${template}`}
            checked={model.delegation.templates[template]}
            disabled={disabled}
            onCheckedChange={checked => onToggleTemplate(template, checked === true)}
          />
        </label>
      ))}
    </fieldset>
  )
  return (
    <section className="space-y-3 border-t border-border pt-3" data-testid="stand-in-delegation">
      <div>
        <h3 className="text-sm font-medium">
          {model.authorized
            ? t('standIn.dingtalk_delegation.version', { version: saved.delegation?.version })
            : t('standIn.dingtalk_delegation.title')}
        </h3>
        <p className="mt-1 break-words text-sm text-text-secondary">
          {account.accountId
            ? t('standIn.dingtalk_delegation.account', { name: account.accountName ?? account.profile })
            : t(
                account.status === 'ready'
                  ? 'standIn.dingtalk_delegation.account_unverified'
                  : 'standIn.dingtalk_delegation.account_unavailable'
              )}
          {account.organizationName && ` · ${account.organizationName}`}
        </p>
        <p className="mt-1 text-xs text-text-secondary">{t('standIn.dingtalk_delegation.scope_help')}</p>
      </div>
      {model.reconfirm && (
        <p role="status" className="text-sm">{t('standIn.dingtalk_delegation.source_reconfirm')}</p>
      )}
      {!model.selected.length && (
        <p className="text-sm text-text-secondary" data-testid="stand-in-delegation-no-sources">
          {t(model.authorized ? 'standIn.dingtalk_delegation.remove_all' : 'standIn.dingtalk_delegation.choose_sources')}
        </p>
      )}
      {draft.model?.runtime === 'claude_code' && (
        <p role="status" className="text-sm text-text-secondary">
          {t('standIn.dingtalk_delegation.model_unsupported')}
        </p>
      )}
      {templateField}
      {model.authorized && paused && (
        <p role="status" className="text-sm">{t('standIn.dingtalk_delegation.saving_paused')}</p>
      )}
      {model.narrows && <p className="text-sm">{t('standIn.dingtalk_delegation.narrows')}</p>}
      {model.widens && <p className="text-sm">{t('standIn.dingtalk_delegation.widens')}</p>}
      {model.authorized ? (
        <ControlButton
          variant="outline"
          type="button"
          data-testid="stand-in-delegation-toggle-pause"
          disabled={disabled || (paused && (dirty || !model.canEnable))}
          onClick={() => onPause(paused ? 'resume' : 'pause')}
          className="min-h-11 md:min-h-9"
        >
          {t(paused ? 'standIn.dingtalk_delegation.resume' : 'standIn.dingtalk_delegation.pause')}
        </ControlButton>
      ) : (
        <ControlButton
          variant="primary"
          type="button"
          data-testid="stand-in-delegation-enable"
          disabled={disabled || !model.canEnable}
          onClick={onEnable}
          className="min-h-11 md:min-h-9"
        >
          {t('standIn.dingtalk_delegation.enable')}
        </ControlButton>
      )}
    </section>
  )
}
