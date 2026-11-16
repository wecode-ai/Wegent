// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectManageHost } from '../project-manage/types'
import type { ProjectBoardViews } from './projectBoardViews'

export function collectProjectTags(
  project: { tags?: readonly string[]; board_views?: ProjectBoardViews | null },
  items: readonly { tags?: readonly string[] }[] = []
): string[] {
  const views = project.board_views?.schema_version === 1 ? project.board_views.views : []
  return [
    ...new Set([
      ...(project.tags ?? []),
      ...items.flatMap(item => item.tags ?? []),
      ...views.flatMap(view => [
        ...view.columns.filter(column => column.type === 'tag').map(column => column.value),
        ...(view.filter?.tags ?? []),
      ]),
    ]),
  ]
}

export function updateBoardViewTag(
  config: ProjectBoardViews | null | undefined,
  source: string,
  target: string | null,
  t: ProjectManageHost['translate']
): ProjectBoardViews | undefined {
  if (!config) return undefined
  if (config.schema_version !== 1)
    throw new Error(
      t('todo.board_view_future', '此项目的视图配置来自更新版本，请升级后查看和编辑。')
    )
  let changed = false
  const views = config.views.map(view => {
    if (
      !view.columns.some(column => column.type === 'tag' && column.value === source) &&
      !view.filter?.tags?.includes(source)
    )
      return view
    changed = true
    const columns = view.columns.flatMap(column => {
      if (column.type !== 'tag' || column.value !== source) return [column]
      return target === null ? [] : [{ ...column, value: target }]
    })
    if (!columns.length)
      throw new Error(
        t(
          'todo.board_view_last_tag_lane',
          '标签是视图“{{view}}”的唯一泳道，请先编辑该视图再删除标签。',
          { view: view.name }
        )
      )
    return {
      ...view,
      columns,
      ...(view.filter
        ? {
            filter: {
              ...view.filter,
              tags: (view.filter.tags ?? []).flatMap(tag =>
                tag === source ? (target === null ? [] : [target]) : [tag]
              ),
            },
          }
        : {}),
      ...(view.sorts
        ? {
            sorts: Object.fromEntries(
              Object.entries(view.sorts).filter(
                ([id]) =>
                  !view.columns.some(
                    column => column.id === id && !columns.includes(column) && target === null
                  )
              )
            ),
          }
        : {}),
    }
  })
  return changed ? { ...config, views } : undefined
}
