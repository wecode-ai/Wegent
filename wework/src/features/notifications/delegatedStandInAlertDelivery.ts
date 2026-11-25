import { buildCollaborationExpScheme } from '@/features/collaboration-exp/integration/deepLinks'
import { createDingTalkMessageCenterApi } from '@/features/todo/dingTalkMessageCenterApi'
import type { MessageCenterRecord } from '@/api/standInMessageCenter'
import { messageCenterCategory } from '@/features/todo/message-center/messageCenterModel'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import type { TaskSource } from './NotificationTaskSourceContext'

const POLL_INTERVAL_MS = 15_000
const DELIVERED_LIMIT = 300

type Observation = {
  source: TaskSource | null
  userId: number | null
  systemEnabled: boolean
  describe(record: MessageCenterRecord): { title: string; body: string }
}

function storageKey(accountKey: string) {
  return `wework.delegated-stand-in-alerts:${accountKey}`
}

function baselineKey(accountKey: string) {
  return `${storageKey(accountKey)}:baseline`
}

function readDelivered(accountKey: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(accountKey)) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

function writeDelivered(accountKey: string, delivered: readonly string[]) {
  try {
    localStorage.setItem(storageKey(accountKey), JSON.stringify(delivered.slice(-DELIVERED_LIMIT)))
  } catch {
    // A blocked local store must not suppress delivery for the current process.
  }
}

function needsDecision(record: MessageCenterRecord) {
  return messageCenterCategory(record) === 'needs_user' && !record.takenOver
}

/** Alerts for delegated messages that stopped before any runtime conversation existed. */
export function createDelegatedStandInAlertDelivery(accountKey: string) {
  let observation: Observation | undefined
  let observing = false
  let running: symbol | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let delivered = readDelivered(accountKey)
  let baselineReady = localStorage.getItem(baselineKey(accountKey)) === '1'

  const remember = (key: string) => {
    if (delivered.includes(key)) return
    delivered = [...delivered, key].slice(-DELIVERED_LIMIT)
    writeDelivered(accountKey, delivered)
  }

  const reconcile = async () => {
    const current = observation
    const api = current?.source?.services?.standInApi
    const readIdentity = current?.source?.services?.getLocalRuntimeSidebarIdentity
    const userId = current?.userId
    if (
      !observing ||
      running ||
      !current?.systemEnabled ||
      getDesktopWindowLabel() !== 'main' ||
      !api ||
      !readIdentity ||
      userId == null
    )
      return
    const owner = Symbol()
    running = owner
    try {
      const local = await readIdentity()
      if (!local || !observing || observation !== current) return
      const settings = await api.personalGet(userId, local.deviceId)
      if (settings.executionDeviceId !== local.deviceId) return
      const snapshot = await createDingTalkMessageCenterApi(api).read({
        userId,
        deviceId: local.deviceId,
      })
      if (!observing || observation !== current || !snapshot.identity) return
      const decisions = snapshot.records.filter(needsDecision)
      if (!baselineReady) {
        delivered = [
          ...new Set(
            decisions.map(record =>
              JSON.stringify([snapshot.identity!.id, record.id, record.reason ?? ''])
            )
          ),
        ].slice(-DELIVERED_LIMIT)
        writeDelivered(accountKey, delivered)
        localStorage.setItem(baselineKey(accountKey), '1')
        baselineReady = true
        return
      }
      for (const record of decisions) {
        const key = JSON.stringify([snapshot.identity.id, record.id, record.reason ?? ''])
        if (delivered.includes(key)) continue
        const copy = current.describe(record)
        const sent = await sendSystemNotification({
          ...copy,
          url: buildCollaborationExpScheme('', {
            deviceId: local.deviceId,
            userId: String(userId),
          }),
        })
        if (!sent) break
        remember(key)
      }
    } catch (error) {
      console.warn('[Stand-in] Delegated message alert check failed', error)
    } finally {
      if (running === owner) running = undefined
    }
  }

  return {
    observe(next: Observation) {
      observation = next
      observing = true
      if (!timer) {
        timer = setInterval(() => void reconcile(), POLL_INTERVAL_MS)
      }
      void reconcile()
    },
    suspend() {
      observing = false
    },
    release() {
      observing = false
      observation = undefined
      running = undefined
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
