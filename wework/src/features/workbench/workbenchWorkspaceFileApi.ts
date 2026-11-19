import type { ExecutorClient } from '@/api/executorAccess'

/** File panes share the executor's scoped file commands without rebuilding their ownership. */
export function workbenchWorkspaceFileApi(executor: ExecutorClient) {
  return {
    listWorkspaceEntries: executor.files.listWorkspaceEntries,
    searchWorkspaceEntries: executor.files.searchWorkspaceEntries,
    readWorkspaceTextFile: executor.files.readWorkspaceTextFile,
    writeWorkspaceTextFile: executor.files.writeWorkspaceTextFile,
    readWorkspaceFileChunk: executor.files.readWorkspaceFileChunk,
  }
}
