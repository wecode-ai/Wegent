import { useMemo, useSyncExternalStore } from 'react'
import type { MessageCenterScope, StandInMessageCenterApi } from '@/api/standInMessageCenter'
import { StandInMessageCenter } from './message-center/StandInMessageCenter'
import {
  createStandInMessageCenterSource,
  unavailableMessageCenterSnapshot,
} from './standInMessageCenterSource'

type Props = {
  api?: StandInMessageCenterApi
  scope: MessageCenterScope | null
  onOpenSettings: () => void
  onOpenComponents?: () => void
}

export function StandInMessageCenterHost({ api, scope, ...actions }: Props) {
  if (!api || !scope) {
    return (
      <StandInMessageCenter
        snapshot={unavailableMessageCenterSnapshot}
        loading={false}
        error={false}
        busy={false}
        actionError={false}
        onRefresh={() => {}}
        onCommand={async () => false}
        {...actions}
      />
    )
  }
  return (
    <MessageCenterSession
      key={JSON.stringify([scope.userId, scope.deviceId])}
      api={api}
      scope={scope}
      {...actions}
    />
  )
}

function MessageCenterSession({
  api,
  scope: { userId, deviceId },
  ...actions
}: Omit<Props, 'api' | 'scope'> & {
  api: StandInMessageCenterApi
  scope: MessageCenterScope
}) {
  const source = useMemo(
    () => createStandInMessageCenterSource(api, { userId, deviceId }),
    [api, userId, deviceId]
  )
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getServerSnapshot)
  return (
    <StandInMessageCenter
      {...state}
      onRefresh={source.refresh}
      onCommand={source.apply}
      {...actions}
    />
  )
}
