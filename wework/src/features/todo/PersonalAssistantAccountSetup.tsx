import { LOCAL_USER } from '@/api/local/localSession'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { Button } from '@/components/ui/button'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { hasSavedStandIn } from './standInInstanceSource'

async function loadSetup(
  services: WorkbenchServices,
  userId: number,
  name: string,
  signal: AbortSignal
) {
  const cloud = services.personalAssistantAccountApi!
  const account = await cloud.get(signal)
  if (account) return { account, local: undefined }
  signal.throwIfAborted()
  const api = services.standInApi
  if (!services.getLocalRuntimeSidebarIdentity || !api) {
    return { account: await cloud.initialize(name), local: undefined }
  }
  const device = await services.getLocalRuntimeSidebarIdentity()
  if (!device) throw new Error('Executor identity is unavailable')
  const [owned, local] = await Promise.all([
    api.personalGet(userId, device.deviceId),
    api.personalGet(LOCAL_USER.id, device.deviceId),
  ])
  signal.throwIfAborted()
  const legacy = hasSavedStandIn(owned) ? owned : hasSavedStandIn(local) ? local : undefined
  return legacy
    ? { account: null, local: legacy }
    : { account: await cloud.initialize(name), local: undefined }
}

export function PersonalAssistantAccountSetup({
  services,
  userId,
  active,
  children,
}: {
  services: WorkbenchServices
  userId: number
  active: boolean
  children(
    account: PersonalAssistantAccount | undefined,
    publish: (account: PersonalAssistantAccount) => void,
    readAccount: () => PersonalAssistantAccount | undefined
  ): ReactNode
}) {
  const { t } = useTranslation('common')
  const name = t('standIn.personal.default_role')
  const resource = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify([userId]),
        signal => loadSetup(services, userId, name, signal),
        {
          refreshOnSubscribe: true,
        }
      ),
    [services, userId, name]
  )
  const snapshot = useSyncExternalStore(
    active ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const [confirmation, setConfirmation] = useState(true)
  const [continueLocally, setContinueLocally] = useState(false)
  const [pending, setPending] = useState(false)
  const [migrationNotice, setMigrationNotice] = useState(false)
  const clearMigrationNotice = useCallback(() => setMigrationNotice(false), [])
  const [error, setError] = useState<unknown>()
  const inFlight = useRef(false)
  const publish = useCallback(
    (account: PersonalAssistantAccount) => resource.update(() => ({ account, local: undefined })),
    [resource]
  )
  const readAccount = useCallback(
    () => resource.getSnapshot().data?.account ?? undefined,
    [resource]
  )
  const data = snapshot.data
  if (data?.account) {
    return (
      <>
        {children(data.account, publish, readAccount)}
        <TransientNotice
          message={migrationNotice ? t('standIn.account.migration_complete') : null}
          onClear={clearMigrationNotice}
          tone="success"
          visible={active}
        />
      </>
    )
  }

  const initialize = async () => {
    if (!data || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    try {
      const source = data.local
      const local = source
        ? await services.standInApi!.personalGet(source.userId, source.executionDeviceId)
        : undefined
      const account = await services.personalAssistantAccountApi!.initialize(name, local)
      setMigrationNotice(Boolean(local))
      publish(account)
    } catch (cause) {
      setError(cause)
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  const failure = snapshot.error ?? error
  return (
    <>
      <section
        className={
          data?.local && !failure
            ? 'flex flex-wrap items-center gap-2 border-b border-border px-5 py-2'
            : 'space-y-3 p-5'
        }
        data-testid="personal-assistant-account-setup"
      >
        {failure ? (
          <>
            <p role="alert" className="text-sm text-error">
              {getStandInErrorMessage(failure, 'load_settings_failed')}
            </p>
            <Button
              data-testid="personal-assistant-account-retry"
              onClick={() => {
                setError(undefined)
                void resource.reload()
              }}
            >
              {t('standIn.reload')}
            </Button>
          </>
        ) : data ? (
          <>
            <span className="text-sm text-text-secondary">
              {t('standIn.account.local_profile')}
            </span>
            <Button
              size="sm"
              variant="outline"
              data-testid="personal-assistant-account-initialize"
              disabled={pending}
              onClick={() => setConfirmation(true)}
            >
              {t('standIn.account.migrate')}
            </Button>
          </>
        ) : (
          <p role="status" className="text-sm">
            {t('standIn.loading')}
          </p>
        )}
        <ConfirmDialog
          open={active && !!data?.local && confirmation && !failure}
          title={t('standIn.account.migrate')}
          description={t('standIn.account.migrate_description')}
          cancelLabel={t('standIn.account.later')}
          confirmLabel={t('standIn.account.migrate')}
          confirmTestId="personal-assistant-account-migrate-confirm"
          cancelTestId="personal-assistant-account-migrate-cancel"
          pending={pending}
          onClose={() => {
            setConfirmation(false)
            setContinueLocally(true)
          }}
          onConfirm={() => void initialize()}
        />
      </section>
      {!!data?.local && continueLocally && children(undefined, publish, readAccount)}
    </>
  )
}
