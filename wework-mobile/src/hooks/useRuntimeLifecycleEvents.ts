import { useEffect, type RefObject } from 'react'
import { modelSelectionFromRuntimeHandle } from '../../../packages/chat-core/src/runtime-model-selection'
import {
  isRunningRuntimeEvent,
  isTerminalRuntimeEvent,
  runtimeTaskKey,
  type RuntimeTaskLifecycleProjection,
} from '@/domain/runtimeTaskLifecycle'
import { withRuntimeTaskModelSelection } from '@/domain/work'
import type { RuntimeStream } from '@/services/runtimeStream'
import { showErrorAlert } from '@/services/errorAlerts'
import type {
  RuntimeTaskAddress,
  RuntimeTranscriptResponse,
  RuntimeWorkListResponse,
} from '@/types/runtime'
import { recordMobileTaskOutcome } from '@/telemetry/taskOutcome'
import { sameRuntimeAddress } from './mobileRuntimeHelpers'

const noListRefresh = () => {}
// The transcript owner records read failures for its source-specific retry.
const readFailureRecorded = () => {}

interface RuntimeLifecycleEventsOptions {
  stream: RuntimeStream
  lifecycle: RuntimeTaskLifecycleProjection
  currentAddressRef: RefObject<RuntimeTaskAddress | null>
  workByDeviceRef: RefObject<Record<string, RuntimeWorkListResponse>>
  setCurrentAddress: (address: RuntimeTaskAddress) => void
  commitDeviceWork: (deviceId: string, work: RuntimeWorkListResponse) => Promise<void>
  publishTaskLifecycle: () => void
  reloadTranscript: (address: RuntimeTaskAddress) => Promise<RuntimeTranscriptResponse | null>
}

export function useRuntimeLifecycleEvents({
  stream,
  lifecycle,
  currentAddressRef,
  workByDeviceRef,
  setCurrentAddress,
  commitDeviceWork,
  publishTaskLifecycle,
  reloadTranscript,
}: RuntimeLifecycleEventsOptions) {
  useEffect(
    () =>
      stream.subscribeLifecycle((address, event) => {
        if (event.name === 'runtime.work.changed') {
          const data = event.payload.data as Record<string, unknown> | undefined
          const cleanup = data?.archiveCleanup as
            { workspacePath?: unknown; errors?: unknown } | undefined
          // Match PC onRuntimeWorkChanged: accepted background deletion can still fail.
          if (typeof cleanup?.workspacePath === 'string' && Array.isArray(cleanup.errors)) {
            const errors = cleanup.errors.filter(
              (error): error is string => typeof error === 'string'
            )
            if (errors.length)
              showErrorAlert(new Error(errors.join('; ')), { title: '已归档会话的文件清理失败' })
          }
        }
        const current = currentAddressRef.current
        const selection =
          modelSelectionFromRuntimeHandle(event.payload) ??
          modelSelectionFromRuntimeHandle(event.payload.task as Record<string, unknown> | undefined)
        const deviceWork = workByDeviceRef.current[address.deviceId]
        if (selection && deviceWork) {
          void commitDeviceWork(
            address.deviceId,
            withRuntimeTaskModelSelection(deviceWork, address, selection)
          )
        }
        if (selection && current && sameRuntimeAddress(current, address)) {
          const next = {
            ...current,
            runtimeHandle: { ...current.runtimeHandle, modelSelection: selection },
          }
          currentAddressRef.current = next
          setCurrentAddress(next)
        }
        if (isRunningRuntimeEvent(event.name) && lifecycle.executorStarted(address)) {
          publishTaskLifecycle()
        }
        if (isTerminalRuntimeEvent(event.name)) recordMobileTaskOutcome(address, event.name)
        if (
          isTerminalRuntimeEvent(event.name) &&
          current &&
          runtimeTaskKey(current) === runtimeTaskKey(address)
        ) {
          void reloadTranscript(address).catch(readFailureRecorded)
        }
      }, noListRefresh),
    [
      commitDeviceWork,
      currentAddressRef,
      lifecycle,
      publishTaskLifecycle,
      reloadTranscript,
      setCurrentAddress,
      stream,
      workByDeviceRef,
    ]
  )
}
