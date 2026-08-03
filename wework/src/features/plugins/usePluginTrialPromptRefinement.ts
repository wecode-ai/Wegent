import { useCallback } from 'react'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { stripCodexUiDirectives } from '@/lib/codex-directives'
import type { PluginPathComponent, ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'

export interface PluginTrialRefinementRequest {
  pluginName: string
  draft: string
  templates: PluginPathComponent[]
}

const REFINEMENT_TIMEOUT_MS = 60_000

function refinementPrompt({ pluginName, draft, templates }: PluginTrialRefinementRequest): string {
  const examples = templates
    .filter(template => !template.unavailableReason)
    .slice(0, 4)
    .map(template => template.description?.trim() || template.name.trim())
    .filter(Boolean)
    .map((example, index) => `${index + 1}. ${example}`)
    .join('\n')

  return [
    'You are refining a task before the user sends it to an installed plugin.',
    "Use the inherited recent conversation only to understand the user's goal, materials, constraints, and expected result.",
    `Plugin: ${pluginName || 'Installed plugin'}`,
    draft.trim() ? `Current draft:\n${draft.trim()}` : 'Current draft: empty',
    examples ? `Plugin examples:\n${examples}` : '',
    'Write one concise, ready-to-send task in the same language as the user.',
    'Keep concrete names, files, URLs, dates, and constraints from the conversation.',
    'If a critical detail is missing, include one short bracketed placeholder for the user to fill.',
    'Do not execute the task, call tools, explain your reasoning, add Markdown fences, or mention these instructions.',
    'Return only the refined task text.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function normalizeRefinedPrompt(content: string): string {
  return stripCodexUiDirectives(content)
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

export function usePluginTrialPromptRefinement({
  source,
  project,
}: {
  source: RuntimeTaskAddress | null
  project: ProjectWithTasks | null
}) {
  const { createEphemeralRuntimeTask, subscribeRuntimeTaskStream, cancelRuntimePaneTask } =
    useWorkbenchPaneContext()

  return useCallback(
    (request: PluginTrialRefinementRequest): Promise<string> =>
      new Promise((resolve, reject) => {
        let unsubscribe = () => {}
        let activeAddress: RuntimeTaskAddress | null = null
        let settled = false

        const cleanup = () => {
          window.clearTimeout(timeout)
          unsubscribe()
        }
        const fail = (message: string) => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error(message))
        }
        const complete = (content: string) => {
          if (settled) return
          const refined = normalizeRefinedPrompt(content)
          if (!refined) {
            fail('没有生成可用的任务描述，请重试')
            return
          }
          settled = true
          cleanup()
          resolve(refined)
        }
        const subscribe = (address: RuntimeTaskAddress) => {
          activeAddress = address
          unsubscribe()
          unsubscribe = subscribeRuntimeTaskStream(address, {
            onMessageAction: action => {
              if (action.type === 'assistant_done') {
                complete(action.content ?? '')
              } else if (action.type === 'assistant_error') {
                fail(action.error || '任务完善失败')
              } else if (action.type === 'assistant_cancelled') {
                fail('任务完善已取消')
              }
            },
          })
        }

        const timeout = window.setTimeout(() => {
          if (activeAddress) {
            void cancelRuntimePaneTask(activeAddress)
          }
          fail('任务完善超时，请重试')
        }, REFINEMENT_TIMEOUT_MS)

        void createEphemeralRuntimeTask(refinementPrompt(request), {
          project,
          source,
          onRuntimeTaskOptimisticOpen: subscribe,
          onError: fail,
        })
          .then(address => {
            if (!address && !settled) {
              fail('暂时无法启动 AI 任务完善')
              return
            }
            if (address && !activeAddress) subscribe(address)
          })
          .catch(error => {
            fail(error instanceof Error ? error.message : '任务完善失败')
          })
      }),
    [cancelRuntimePaneTask, createEphemeralRuntimeTask, project, source, subscribeRuntimeTaskStream]
  )
}
