import { describe, expect, it, vi } from 'vitest'
import { createLocalProjectAutomationApi } from './localProjectAutomations'

type Runtime = Parameters<typeof createLocalProjectAutomationApi>[1]

describe('local project automation cancellation', () => {
  it('stops delivered runtime work before returning the durable run state', async () => {
    const run = { id: 'run', automationId: 'rule', status: 'running' }
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        run,
        executions: [
          { status: 'cancel_requested', runtime_device_id: 'device', runtime_task_id: 'task' },
        ],
      })
      .mockResolvedValueOnce([{ ...run, status: 'cancelled' }])
    const cancelRuntimeTask = vi.fn(async () => ({}))
    const api = createLocalProjectAutomationApi(request, {
      cancelRuntimeTask,
    } as unknown as Runtime)
    expect(await api.cancelRun('project', 'run')).toEqual({ ...run, status: 'cancelled' })
    expect(cancelRuntimeTask).toHaveBeenCalledWith({ deviceId: 'device', taskId: 'task' })
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'projects.automation.cancel',
      'projects.automation.runs',
    ])
  })

  it('does not report success when runtime cancellation fails', async () => {
    const request = vi.fn().mockResolvedValue({
      run: { id: 'run', automationId: 'rule' },
      executions: [
        { status: 'cancel_requested', runtime_device_id: 'device', runtime_task_id: 'task' },
      ],
    })
    const cancelRuntimeTask = vi.fn().mockRejectedValue(new Error('Runtime unavailable'))
    const api = createLocalProjectAutomationApi(request, {
      cancelRuntimeTask,
    } as unknown as Runtime)
    await expect(api.cancelRun('project', 'run')).rejects.toThrow('Runtime unavailable')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not contact runtime for cancelled queue entries', async () => {
    const run = { id: 'run', automationId: 'rule', status: 'cancelled' }
    const request = vi
      .fn()
      .mockResolvedValueOnce({ run, executions: [{ status: 'cancelled' }] })
      .mockResolvedValueOnce([run])
    const cancelRuntimeTask = vi.fn()
    const api = createLocalProjectAutomationApi(request, {
      cancelRuntimeTask,
    } as unknown as Runtime)
    await expect(api.cancelRun('project', 'run')).resolves.toEqual(run)
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
  })
})
