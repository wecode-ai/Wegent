import type { CloudTodoWorkspaceProps } from './cloudTodoWorkspaceTypes'
import { useCloudTodoWorkspaceData } from './useCloudTodoWorkspaceData'
import { createCloudTodoProjectActions } from './cloudTodoProjectActions'
import { createCloudTodoBoardActions } from './cloudTodoBoardActions'
import { createCloudTodoTaskActions } from './cloudTodoTaskActions'
import { CloudTodoWorkspaceView } from './CloudTodoWorkspaceView'
export type { CloudTodoWorkspaceProps } from './cloudTodoWorkspaceTypes'
export function CloudTodoWorkspace(props: CloudTodoWorkspaceProps) {
  const data = useCloudTodoWorkspaceData(props)
  const project = createCloudTodoProjectActions(data)
  const board = createCloudTodoBoardActions(data)
  const task = createCloudTodoTaskActions({ ...data, ...project })
  return <CloudTodoWorkspaceView model={{ ...data, ...project, ...board, ...task }} />
}
