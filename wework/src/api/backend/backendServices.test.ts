import { afterEach, describe, expect, test, vi } from 'vitest'
import { createBackendWorkbenchServices } from './backendServices'

const baseOptions = {
  apiBaseUrl: 'https://backend.example.com/api',
  socketBaseUrl: 'https://backend.example.com',
  socketPath: '/socket.io',
  getToken: () => 'token',
}

describe('createBackendWorkbenchServices', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('does not submit feedback to the connected Backend by default', () => {
    const services = createBackendWorkbenchServices(baseOptions)

    expect(services.feedbackApi).toBeUndefined()
  })

  test('enables feedback only for the build-time feedback endpoint', () => {
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', 'https://feedback.example.com/v1/reports')

    const services = createBackendWorkbenchServices(baseOptions)

    expect(services.feedbackApi).toBeDefined()
  })
})
