import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { AITableApi } from '@/api/aitable'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { AITableTaskFields } from './AITableTaskFields'

const project = {
  id: 'project-1',
  task_provider: 'dingtalk_aitable',
} as CloudProject

const item = {
  id: 'aitable:PRJ:record-1',
  can_edit: true,
} as CloudLoopItem

describe('AITableTaskFields', () => {
  it('shows every field, expands long content, and writes editable values back', async () => {
    const longText = '第一行\n' + '很长的内容'.repeat(40)
    const updateRecord = vi.fn(async (_projectId, recordId, cells) => ({
      id: recordId,
      cells,
      raw: {},
    }))
    const api: AITableApi = {
      configureProject: vi.fn(),
      describe: vi.fn(async () => ({
        base: {},
        tables: [],
        active_table: {},
        fields: [
          { id: 'title', name: '需求名称', type: 'text', config: {}, raw: {} },
          { id: 'notes', name: '备注', type: 'text', config: {}, raw: {} },
          { id: 'formula', name: '延期情况', type: 'formula', config: {}, raw: {} },
        ],
      })),
      getRecord: vi.fn(async () => ({
        id: 'record-1',
        cells: { title: '旧标题', notes: longText, formula: '正常' },
        raw: {},
      })),
      listRecords: vi.fn(),
      createRecord: vi.fn(),
      updateRecord,
      deleteRecord: vi.fn(),
      createField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
    }

    render(<AITableTaskFields api={api} project={project} item={item} />)

    expect(await screen.findByText('需求名称')).toBeInTheDocument()
    expect(screen.getByText('延期情况')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('aitable-detail-expand-notes'))
    expect(screen.getByTestId('aitable-detail-value-notes')).not.toHaveClass('line-clamp-3')

    await userEvent.click(screen.getByTestId('aitable-detail-edit-button-title'))
    const editor = screen.getByTestId('aitable-detail-edit-title')
    await userEvent.clear(editor)
    await userEvent.type(editor, '新标题')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(updateRecord).toHaveBeenCalledWith('project-1', 'record-1', { title: '新标题' })
    )
    expect(screen.queryByTestId('aitable-detail-edit-button-formula')).not.toBeInTheDocument()
  })
})
