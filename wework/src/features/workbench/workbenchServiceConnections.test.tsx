import { Activity, StrictMode } from 'react'
import { render, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  retainWorkbenchServiceConnections,
  useWorkbenchServiceConnections,
} from './workbenchServiceConnections'
import type { WorkbenchServices } from './workbenchServices'

type Connections = Pick<WorkbenchServices, 'socketClient' | 'projectChatClient'>

function Owner({ services }: { services: Connections }) {
  useWorkbenchServiceConnections(services)
  return null
}

function fixture() {
  return {
    socketClient: {
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
    projectChatClient: { dispose: vi.fn() } as unknown as NonNullable<
      WorkbenchServices['projectChatClient']
    >,
  }
}

test('a hidden workspace keeps the window-owned Runtime connection alive', async () => {
  const services = fixture()
  const views = (mode: 'visible' | 'hidden') => (
    <>
      <Owner services={services} />
      <Activity mode={mode}>
        <Owner services={services} />
      </Activity>
    </>
  )
  const view = render(views('visible'))
  view.rerender(views('hidden'))
  await Promise.resolve()
  expect(services.socketClient.dispose).not.toHaveBeenCalled()
  expect(services.projectChatClient.dispose).not.toHaveBeenCalled()
  view.rerender(views('visible'))
  expect(services.socketClient.ensureConnected).toHaveBeenCalledTimes(1)
  view.unmount()
  await waitFor(() => expect(services.socketClient.dispose).toHaveBeenCalledTimes(1))
  expect(services.projectChatClient.dispose).toHaveBeenCalledTimes(1)
})

test('StrictMode effect replay does not destroy an already subscribed connection', async () => {
  const services = fixture()
  const view = render(
    <StrictMode>
      <Owner services={services} />
    </StrictMode>
  )
  await Promise.resolve()
  expect(services.socketClient.dispose).not.toHaveBeenCalled()
  expect(services.socketClient.ensureConnected).toHaveBeenCalledTimes(1)
  view.unmount()
  await waitFor(() => expect(services.socketClient.dispose).toHaveBeenCalledTimes(1))
})

test('different service graphs sharing one transport release it only after the final owner', async () => {
  const services = fixture()
  const first = retainWorkbenchServiceConnections(services)
  const second = retainWorkbenchServiceConnections({ ...services })
  first()
  first()
  await Promise.resolve()
  expect(services.socketClient.dispose).not.toHaveBeenCalled()
  second()
  await Promise.resolve()
  expect(services.socketClient.dispose).toHaveBeenCalledTimes(1)
  expect(services.projectChatClient.dispose).toHaveBeenCalledTimes(1)
})
