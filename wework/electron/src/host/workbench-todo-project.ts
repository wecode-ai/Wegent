import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { WORKBENCH_DSH_VERSION } from '../runtime/workbench-dsh-runtime.js'
import { createTodoHtml } from './workbench-todo.js'
import { scaffoldLightweightWorkbench } from './smart-app-scaffold.js'

/** Creates editable DSH source only; installation and consent remain Host actions. */
export async function createTodoProject(dataDirectory: string, locale = 'zh-CN'): Promise<string> {
  const name = `todo-${randomUUID().slice(0, 8)}`
  const path = join(dataDirectory, 'harness-apps', 'drafts', name)
  await scaffoldLightweightWorkbench({
    path,
    name,
    displayName: 'TODO',
    description: locale.startsWith('zh')
      ? '在本机保存待办事项，并通过系统通知定时提醒。'
      : 'Persistent local tasks with scheduled system reminders.',
    dshVersion: WORKBENCH_DSH_VERSION,
    html: createTodoHtml(locale),
    nativeCapabilities: ['notifications'],
    window: { width: 380, height: 520, alwaysOnTop: false },
  })
  return path
}
