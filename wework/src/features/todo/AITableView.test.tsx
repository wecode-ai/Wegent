// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AITableApi, AITableField, AITableRecord } from '@/api/aitable'
import type { CloudProject } from '@/api/deliveries'
import { AITableView } from './AITableView'

function field(overrides: Partial<AITableField>): AITableField {
  return {
    id: 'fld1',
    name: '字段',
    type: 'text',
    config: {},
    raw: {},
    ...overrides,
  }
}

function record(id: string, cells: Record<string, unknown>): AITableRecord {
  return { id, cells, raw: {} }
}

const project = {
  id: '7',
  public_id: 'project-7',
  project_key: 'AIT',
  name: 'AI Table',
  description: '',
  project_store: 'backend',
  task_provider: 'dingtalk_aitable',
  provider_config: {},
  created_by_user_id: 1,
  access_role: 'Owner',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
} as CloudProject

function apiWith(fields: AITableField[], records: AITableRecord[]): AITableApi {
  return {
    configureProject: vi.fn(async () => undefined),
    describe: vi.fn(async () => ({ base: {}, tables: [], active_table: {}, fields })),
    listRecords: vi.fn(async () => ({ items: records, cursor: null, has_more: false })),
    createRecord: vi.fn(async (_p, cells) => record('new-rec', cells)),
    updateRecord: vi.fn(async (_p, id, cells) => record(id, cells)),
    deleteRecord: vi.fn(async () => undefined),
    createField: vi.fn(async (_p, data) =>
      field({ id: 'new-fld', name: data.name, type: data.type })
    ),
    updateField: vi.fn(async (_p, id, data) => field({ id, name: data.name ?? 'x' })),
    deleteField: vi.fn(async () => undefined),
  }
}

describe('AITableView', () => {
  it('renders dynamic fields and records from the live schema', async () => {
    const api = apiWith(
      [field({ id: 'fld_title', name: '需求名称', type: 'text' })],
      [record('rec1', { fld_title: '登录优化' })]
    )
    render(<AITableView api={api} project={project} />)

    expect(await screen.findByText('需求名称')).toBeInTheDocument()
    expect(screen.getByText('登录优化')).toBeInTheDocument()
    expect(screen.getByTestId('aitable-grid')).toHaveClass('h-full')
  })

  it('hides DingTalk view tabs and renders a single table', async () => {
    const api = apiWith([field({ id: 'fld_title', name: '需求名称' })], [])
    vi.mocked(api.describe).mockResolvedValue({
      base: {},
      tables: [],
      active_table: {},
      fields: [field({ id: 'fld_title', name: '需求名称' })],
      views: [{ viewId: 'view-grid', viewName: '全部记录', viewType: 'grid' }],
    })
    render(<AITableView api={api} project={project} />)

    expect(await screen.findByText('需求名称')).toBeInTheDocument()
    expect(screen.queryByText('全部记录')).not.toBeInTheDocument()
    expect(screen.queryByTestId('aitable-create-kanban-view')).not.toBeInTheDocument()
  })

  it('applies the selected DingTalk View query while always rendering a table', async () => {
    const api = apiWith(
      [
        field({ id: 'fld_title', name: '需求名称' }),
        field({ id: 'fld_owner', name: '负责人', type: 'user' }),
        field({ id: 'fld_hidden', name: '内部备注' }),
      ],
      []
    )
    vi.mocked(api.describe).mockResolvedValue({
      base: {},
      tables: [],
      active_table: {},
      fields: [
        field({ id: 'fld_title', name: '需求名称' }),
        field({ id: 'fld_owner', name: '负责人', type: 'user' }),
        field({ id: 'fld_hidden', name: '内部备注' }),
      ],
      views: [
        { viewId: 'view-grid', viewName: '全部记录', viewType: 'Grid' },
        {
          viewId: 'view-kanban',
          viewName: '负责人看板',
          viewType: 'Kanban',
          columns: ['fld_title', 'fld_owner', 'fld_hidden'],
          custom: {
            groupBase: { baseFieldId: 'fld_owner' },
            hiddenFields: { fld_hidden: true },
          },
        },
      ],
    })
    vi.mocked(api.listRecords).mockResolvedValue({
      items: [
        record('rec1', {
          fld_title: '修复登录',
          fld_owner: [{ name: '陈波' }],
          fld_hidden: '不应显示',
        }),
      ],
      cursor: null,
      has_more: false,
    })

    render(
      <AITableView
        api={api}
        project={{
          ...project,
          provider_config: { ...project.provider_config, view_id: 'view-kanban' },
        }}
      />
    )

    expect(await screen.findByText('修复登录')).toBeInTheDocument()
    expect(screen.queryByTestId('aitable-kanban')).not.toBeInTheDocument()
    expect(screen.getByText('陈波')).toBeInTheDocument()
    expect(screen.getByText('修复登录')).toBeInTheDocument()
    expect(screen.queryByText('内部备注')).not.toBeInTheDocument()
    expect(screen.queryByText('不应显示')).not.toBeInTheDocument()
    expect(api.listRecords).toHaveBeenCalledWith('7', {
      limit: 100,
      viewId: 'view-kanban',
    })
  })

  it('keeps formula, user, and unknown field types read-only', async () => {
    const api = apiWith(
      [
        field({ id: 'fld_formula', name: '公式', type: 'formula' }),
        field({ id: 'fld_owner', name: '负责人', type: 'user' }),
        field({ id: 'fld_custom', name: '未知类型', type: 'brandNewType' }),
      ],
      [
        record('rec1', {
          fld_formula: '=A1+B1',
          fld_owner: { uid: 'user-1', name: '陈波' },
          fld_custom: '原始值',
        }),
      ]
    )
    render(<AITableView api={api} project={project} />)

    await screen.findByText('公式')
    // Read-only cells render as plain spans, never as editable buttons/inputs.
    expect(screen.queryByTestId('aitable-cell-edit-rec1-fld_formula')).not.toBeInTheDocument()
    expect(screen.queryByTestId('aitable-cell-edit-rec1-fld_owner')).not.toBeInTheDocument()
    expect(screen.queryByTestId('aitable-cell-edit-rec1-fld_custom')).not.toBeInTheDocument()
    expect(screen.getByText('原始值')).toBeInTheDocument()
  })

  it('normalizes DingTalk millisecond dates for inline editing', async () => {
    const api = apiWith(
      [field({ id: 'fld_due', name: '截止日期', type: 'date' })],
      [record('rec1', { fld_due: Date.UTC(2026, 6, 31) })]
    )
    render(<AITableView api={api} project={project} />)

    fireEvent.click(await screen.findByTestId('aitable-cell-edit-rec1-fld_due'))

    expect(screen.getByTestId('aitable-cell-input-rec1-fld_due')).toHaveValue('2026-07-31')
  })

  it('commits only the edited cell back to the record', async () => {
    const api = apiWith(
      [field({ id: 'fld_title', name: '需求名称', type: 'text' })],
      [record('rec1', { fld_title: '旧值' })]
    )
    render(<AITableView api={api} project={project} />)

    fireEvent.click(await screen.findByTestId('aitable-cell-edit-rec1-fld_title'))
    const input = screen.getByTestId('aitable-cell-input-rec1-fld_title')
    fireEvent.change(input, { target: { value: '新值' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(api.updateRecord).toHaveBeenCalledWith('7', 'rec1', { fld_title: '新值' })
    )
  })

  it('creates a field and refreshes the schema', async () => {
    const api = apiWith([field({ id: 'fld_title', name: '需求名称', type: 'text' })], [])
    render(<AITableView api={api} project={project} />)

    await screen.findByText('需求名称')
    fireEvent.change(screen.getByTestId('aitable-field-name'), { target: { value: '负责人' } })
    fireEvent.change(screen.getByTestId('aitable-field-type'), { target: { value: 'user' } })
    fireEvent.click(screen.getByTestId('aitable-add-field'))

    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith('7', { name: '负责人', type: 'user' })
    )
  })

  it('hides field management for viewers below Developer', async () => {
    const viewer = { ...project, access_role: 'RestrictedAnalyst' as const }
    const api = apiWith(
      [field({ id: 'fld_title', name: '需求名称', type: 'text' })],
      [record('rec1', { fld_title: '只读记录' })]
    )
    render(<AITableView api={api} project={viewer} />)

    await screen.findByText('需求名称')
    expect(screen.queryByTestId('aitable-add-field')).not.toBeInTheDocument()
    expect(screen.queryByTestId('aitable-field-delete-fld_title')).not.toBeInTheDocument()
    expect(screen.queryByTestId('aitable-add-record')).not.toBeInTheDocument()
    expect(screen.queryByTestId('aitable-record-delete-rec1')).not.toBeInTheDocument()
  })

  it('loads subsequent record pages from the returned cursor', async () => {
    const api = apiWith([field({ id: 'fld_title', name: '需求名称' })], [])
    vi.mocked(api.listRecords)
      .mockResolvedValueOnce({
        items: [record('rec1', { fld_title: '第一页' })],
        cursor: 'next',
        has_more: true,
      })
      .mockResolvedValueOnce({
        items: [record('rec2', { fld_title: '第二页' })],
        cursor: null,
        has_more: false,
      })
    render(<AITableView api={api} project={project} />)

    await screen.findByText('第一页')
    fireEvent.click(screen.getByTestId('aitable-load-more'))

    expect(await screen.findByText('第二页')).toBeInTheDocument()
    expect(api.listRecords).toHaveBeenLastCalledWith('7', {
      query: undefined,
      limit: 100,
      cursor: 'next',
    })
    expect(screen.queryByTestId('aitable-load-more')).not.toBeInTheDocument()
  })

  it('shows record mutation failures without removing local data', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    const api = apiWith(
      [field({ id: 'fld_title', name: '需求名称' })],
      [record('rec1', { fld_title: '保留记录' })]
    )
    vi.mocked(api.deleteRecord).mockRejectedValueOnce(new Error('钉钉拒绝删除'))
    render(<AITableView api={api} project={project} />)

    await screen.findByText('保留记录')
    fireEvent.click(screen.getByTestId('aitable-record-delete-rec1'))

    expect(await screen.findByText('钉钉拒绝删除')).toBeInTheDocument()
    expect(screen.getByText('保留记录')).toBeInTheDocument()
  })
})
