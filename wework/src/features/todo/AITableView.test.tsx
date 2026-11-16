// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { AITableApi, AITableField, AITableRecord } from '@/api/aitable'
import type { CloudProject } from '@/api/deliveries'
import { AITableView } from './AITableView'

vi.mock('ag-grid-react', () => {
  return {
    AgGridReact: ({
      columnDefs = [],
      context,
      rowData = [],
    }: {
      columnDefs?: Array<{
        cellRenderer?: ComponentType<Record<string, unknown>>
        context?: unknown
        headerComponentParams?: {
          innerHeaderComponent?: ComponentType<Record<string, unknown>>
        }
        headerName?: string
      }>
      context?: unknown
      rowData?: AITableRecord[]
    }) => (
      <div data-testid="aitable-grid-content">
        {columnDefs.map((column, index) => {
          const Header = column.headerComponentParams?.innerHeaderComponent
          return Header ? (
            <Header
              key={`header-${column.headerName ?? index}`}
              column={{ getColDef: () => column }}
              context={context}
              displayName={column.headerName ?? ''}
            />
          ) : null
        })}
        {rowData.flatMap(record =>
          columnDefs.map((column, index) => {
            const Cell = column.cellRenderer
            return Cell ? (
              <Cell
                key={`${record.id}-${column.headerName ?? index}`}
                colDef={column}
                context={context}
                data={record}
              />
            ) : null
          })
        )}
      </div>
    ),
  }
})

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
