import { createCloudTodoBoardActions } from './cloudTodoBoardActions'
import { createCloudTodoProjectActions } from './cloudTodoProjectActions'
import { createCloudTodoTaskActions } from './cloudTodoTaskActions'
import type { CloudTodoWorkspaceProps } from './cloudTodoWorkspaceTypes'
import { CloudTodoWorkspaceView } from './CloudTodoWorkspaceView'
import { useCloudTodoWorkspaceData } from './useCloudTodoWorkspaceData'
export type { CloudTodoWorkspaceProps } from './cloudTodoWorkspaceTypes'
export function CloudTodoWorkspace(props: CloudTodoWorkspaceProps) {
  const data = useCloudTodoWorkspaceData(props)
  const project = createCloudTodoProjectActions(data)
  const board = createCloudTodoBoardActions(data)
  const task = createCloudTodoTaskActions({ ...data, ...project })
  return <CloudTodoWorkspaceView model={{ ...data, ...project, ...board, ...task }} />
}
