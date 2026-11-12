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
      ? '在本机保存和管理待办事项。'
      : 'Save and manage tasks locally.',
    dshVersion: WORKBENCH_DSH_VERSION,
    html: createTodoHtml(locale),
    window: { width: 380, height: 520, alwaysOnTop: false },
  })
  return path
}
