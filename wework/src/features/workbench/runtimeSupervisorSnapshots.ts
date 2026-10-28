import type {
  RuntimeSupervisorState,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import { updateRuntimeWorkTask } from './workbenchRuntimeHelpers'

/** Preserve only events that arrived after a snapshot request began. */
export class RuntimeSupervisorSnapshots {
  private revision = 0
  private updates = new Map<
    string,
    {
      revision: number
      address: RuntimeTaskAddress
      supervisor: RuntimeSupervisorState | null
    }
  >()

  capture(): number {
    return this.revision
  }

  update(address: RuntimeTaskAddress, supervisor: RuntimeSupervisorState | null): void {
    this.updates.set(`${address.deviceId}:${address.taskId}`, {
      revision: ++this.revision,
      address,
      supervisor,
    })
  }

  preserve(work: RuntimeWorkListResponse, requestRevision: number): RuntimeWorkListResponse {
    let next = work
    for (const update of this.updates.values()) {
      if (update.revision > requestRevision) {
        next = updateRuntimeWorkTask(next, update.address, { supervisor: update.supervisor })
      }
    }
    return next
  }

  clear(): void {
    this.updates.clear()
  }
}
