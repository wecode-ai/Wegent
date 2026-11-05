import { describe, expect, test } from 'vitest'
import { resolveWorkbenchOwnership, workbenchOwnershipKey } from './workbenchOwnership'

const localUser = { id: 1, user_name: 'local', email: '' }
const cloudUser = { id: 7, user_name: 'cloud', email: 'cloud@example.com' }
const connected = {
  isConnected: true,
  serviceKey: 'cloud-session',
  apiBaseUrl: 'https://cloud.example.com/api',
  user: cloudUser,
}

describe('workbench ownership boundary', () => {
  test('uses the authenticated cloud backend and user while cloud services are active', () => {
    expect(resolveWorkbenchOwnership(connected, localUser)).toEqual({
      user: cloudUser,
      key: JSON.stringify([connected.apiBaseUrl, cloudUser.id]),
    })
    expect(workbenchOwnershipKey(connected, cloudUser)).toBe(
      resolveWorkbenchOwnership(connected, localUser).key
    )
  })

  test('returns to the local owner when credentials expire despite retained reconnect metadata', () => {
    const expired = { ...connected, isConnected: false, serviceKey: 'expired' }
    const disconnected = { ...expired, apiBaseUrl: undefined, user: null }
    expect(resolveWorkbenchOwnership(expired, localUser)).toEqual({
      user: localUser,
      key: JSON.stringify(['', localUser.id]),
    })
    expect(resolveWorkbenchOwnership(expired, localUser)).toEqual(
      resolveWorkbenchOwnership(disconnected, localUser)
    )
  })

  test('uses the authenticated application user with a backend fallback provider', () => {
    expect(
      resolveWorkbenchOwnership(
        { ...connected, serviceKey: 'fallback:backend', user: { ...localUser, id: 0 } },
        localUser
      )
    ).toEqual({ user: localUser, key: JSON.stringify([connected.apiBaseUrl, localUser.id]) })
  })
})
