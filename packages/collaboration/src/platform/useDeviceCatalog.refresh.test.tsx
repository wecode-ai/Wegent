// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironment } from '../types'
import { useDeviceCatalog } from './useDeviceCatalog'

it('supersedes a pending device read when the external refresh identity changes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let finish!: (items: CollaborationExecutionEnvironment[]) => void
  const local = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValue([{ id: 'new', kind: 'local_device', app_device_id: 'app' }])
  const api = {
    resources: { devices: { local } },
  } as unknown as SharedWorkspaceApi
  const root = createRoot(document.createElement('div'))
  let catalog!: ReturnType<typeof useDeviceCatalog>
  function Harness({ refreshKey }: { refreshKey: string }) {
    catalog = useDeviceCatalog(api, true, refreshKey)
    return null
  }
  try {
    await act(async () => root.render(<Harness refreshKey="first" />))
    expect(local).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<Harness refreshKey="second" />))
    expect(local).toHaveBeenCalledTimes(2)
    expect(catalog.items.map(item => item.id)).toEqual(['new'])
    await act(async () => finish([{ id: 'old' }] as CollaborationExecutionEnvironment[]))
    expect(catalog.items.map(item => item.id)).toEqual(['new'])
  } finally {
    await act(async () => root.unmount())
  }
})
