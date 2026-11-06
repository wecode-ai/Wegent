// @vitest-environment node
import { expect, test } from 'vitest'
import { pluginOperationNetworkRequests } from '../e2e/desktop/modules/plugin-operation-network.mjs'

test('excludes startup traffic before the real import and includes requests received during it', () => {
  const startup = { acceptedAt: 1009, receivedAt: 1011 }
  const during = { acceptedAt: 1000, receivedAt: 1012 }
  const after = { acceptedAt: 1013, receivedAt: 1013 }
  const result = pluginOperationNetworkRequests([startup, during, after], 1000, {
    capturedAt: 12.75,
    deliveries: 1,
  })
  expect(result).toEqual({ operationAdmittedAt: 1012, requests: [during, after] })
})

test.each([null, { capturedAt: 12 }, { capturedAt: 12, deliveries: 0 }])(
  'rejects missing or unexecuted admission instead of accepting an empty observation',
  admission => expect(() => pluginOperationNetworkRequests([], 1000, admission)).toThrow()
)
