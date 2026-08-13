import { describe, expect, it, vi } from 'vitest'

import { withAITableNotifications, type AITableApi, type AITableRecord } from './aitable'

const record: AITableRecord = {
  id: 'rec-1',
  cells: { title: '发布新版本' },
  raw: {},
}

function baseApi(): AITableApi {
  return {
    configureProject: vi.fn(async () => undefined),
    describe: vi.fn(async () => ({ base: {}, tables: [], active_table: {}, fields: [] })),
    listRecords: vi.fn(async () => ({ items: [], cursor: null, has_more: false })),
    getRecord: vi.fn(async () => record),
    createRecord: vi.fn(async () => record),
    updateRecord: vi.fn(async () => record),
    deleteRecord: vi.fn(async () => undefined),
    createField: vi.fn(),
    updateField: vi.fn(),
    deleteField: vi.fn(),
  }
}

describe('withAITableNotifications', () => {
  it('reports successful record mutations', async () => {
    const api = baseApi()
    const report = vi.fn(async () => undefined)
    const notifying = withAITableNotifications(api, report)

    await notifying.createRecord('11', { title: '发布新版本' })
    await notifying.updateRecord('11', record.id, { status: '完成' })
    await notifying.deleteRecord('11', record.id)

    expect(report).toHaveBeenCalledTimes(3)
    expect(report).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: '11',
        eventType: 'external_record_created',
        taskId: 'rec-1',
        title: '发布新版本',
      })
    )
    expect(report).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ eventType: 'external_record_updated' })
    )
    expect(report).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ eventType: 'external_record_deleted' })
    )
  })

  it('does not report a failed provider mutation', async () => {
    const api = baseApi()
    vi.mocked(api.updateRecord).mockRejectedValue(new Error('provider failed'))
    const report = vi.fn(async () => undefined)
    const notifying = withAITableNotifications(api, report)

    await expect(notifying.updateRecord('11', record.id, {})).rejects.toThrow('provider failed')
    expect(report).not.toHaveBeenCalled()
  })

  it('does not fail a committed mutation when notification reporting fails', async () => {
    const api = baseApi()
    const report = vi.fn().mockRejectedValue(new Error('backend unavailable'))
    const notifying = withAITableNotifications(api, report)

    await expect(notifying.createRecord('11', {})).resolves.toEqual(record)
  })
})
