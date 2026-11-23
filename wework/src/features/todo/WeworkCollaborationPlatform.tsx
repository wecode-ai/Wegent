import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { useCollaborationMarkdownServices } from './useCollaborationMarkdownServices'
import { WeworkCollaborationPlatformContent } from './WeworkCollaborationPlatformContent'
import type { WeworkCollaborationPlatformProps } from './weworkCollaborationTypes'
import { createWeworkPlatformApi } from './weworkPlatformApi'
export type { WeworkCollaborationPlatformProps } from './weworkCollaborationTypes'
export { WeworkSharedProject } from './WeworkSharedProject'
// eslint-disable-next-line react-refresh/only-export-components
export { projectRuntimeStatusSignature } from './weworkCollaborationRuntime'
// eslint-disable-next-line react-refresh/only-export-components
export { toWeworkIssueTaskBinding } from './weworkCollaborationRuntime'
// eslint-disable-next-line react-refresh/only-export-components
export { collaborationTaskAddress } from './weworkCollaborationRuntime'
// eslint-disable-next-line react-refresh/only-export-components
export { createLocalWorkspaceApi, createWeworkPlatformApi }
export function WeworkCollaborationPlatform(props: WeworkCollaborationPlatformProps) {
  const markdownServices = useCollaborationMarkdownServices()
  return (
    <MarkdownServicesProvider value={markdownServices}>
      <WeworkCollaborationPlatformContent {...props} />
    </MarkdownServicesProvider>
  )
}
