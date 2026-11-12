import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { RuntimeTaskAddress } from '@/types/api'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'

/** Local archives stop active execution without deleting private task history. */
export async function prepareIssueRuntimeArchive(
  api: SharedWorkspaceApi,
  issueId: string,
  runningByAddress: ReadonlyMap<string, boolean>,
  cancel?: (address: RuntimeTaskAddress) => Promise<void>
): Promise<void> {
  if (!cancel) return
  const bindings = await api.taskBindings.list(issueId)
  await Promise.all(
    bindings
      .filter(binding => runningByAddress.get(runtimeConversationKey(binding)))
      .map(binding => cancel({ deviceId: binding.deviceId, taskId: binding.taskId }))
  )
}
