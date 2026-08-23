import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { RuntimeSendRequest } from '@/types/api'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

export function buildWorkItemRuntimeContext(
  project: CloudProject,
  task?: CloudLoopItem,
  workflowNodeId?: string
): Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'> {
  return {
    cloudProjectId: String(project.id),
    ...(task
      ? {
          origin: {
            type: 'board_task' as const,
            cloudProjectId: String(project.id),
            loopItemId: String(task.id),
          },
        }
      : {}),
    additionalContext: {
      ...projectSpaceChatRuntimeContext(project, task),
      ...(task
        ? {
            issueEnvironment: {
              kind: 'application' as const,
              value: [
                '<issue_environment>',
                JSON.stringify({
                  project: {
                    id: String(project.id),
                    name: project.name,
                    description: project.description ?? '',
                  },
                  issue: {
                    id: String(task.id),
                    title: task.title,
                    description: task.description ?? '',
                    status: task.status,
                    priority: task.priority,
                    tags: task.tags ?? [],
                    assigneeUserId: task.assignee_user_id ?? null,
                    assigneeAgentId: task.assignee_agent_id || null,
                    dueDate: task.due_at ?? null,
                  },
                  orchestration: task.workflow
                    ? {
                        advancementPolicy: task.workflow.advancement_policy ?? 'manual',
                        stageMode:
                          task.workflow.stage_mode ?? (task.workflow.nodes.length ? 'dag' : 'none'),
                        currentStageId: workflowNodeId ?? null,
                        stages: task.workflow.nodes.map(node => ({
                          id: node.id,
                          name: node.name,
                          prompt: node.prompt ?? '',
                          status: node.status,
                          dependsOn: node.depends_on,
                          dependencyContext: node.dependency_context ?? {},
                          required: node.required,
                        })),
                      }
                    : null,
                }),
                '</issue_environment>',
                'Treat this Issue as immutable execution context. The user message is the concrete task instruction.',
              ].join('\n'),
            },
          }
        : {}),
    },
  }
}
