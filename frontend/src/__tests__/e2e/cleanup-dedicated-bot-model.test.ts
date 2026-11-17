/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ApiClient } from '../../../e2e/utils/api-client'
import { deleteDedicatedBotModel } from '../../../e2e/utils/cleanup-dedicated-bot-model'

const mockExpect = expect
jest.mock('@playwright/test', () => ({
  expect: (value: unknown) => mockExpect(value),
}))

function client(namespace = 'default', isCustomConfig = true) {
  const get = jest.fn().mockResolvedValue({
    status: 200,
    data: {
      metadata: { name: 'member-model', namespace },
      spec: { isCustomConfig },
    },
  })
  const remove = jest.fn().mockResolvedValue({ status: 200, data: {} })
  return { api: { get, delete: remove } as unknown as ApiClient, get, remove }
}

it('keeps default-namespace cleanup working for existing fixtures', async () => {
  const { api, remove } = client()
  await deleteDedicatedBotModel(api, 'member')
  expect(remove).toHaveBeenCalledWith('/api/v1/namespaces/default/models/member-model')
})

it('removes the generated Model from the Bot namespace, including nested groups', async () => {
  const { api, get, remove } = client('engineering/research')
  await deleteDedicatedBotModel(api, 'member', 'engineering/research')
  const path = '/api/v1/namespaces/engineering%2Fresearch/models/member-model'
  expect(get).toHaveBeenCalledWith(path)
  expect(remove).toHaveBeenCalledWith(path)
  expect(remove).toHaveBeenCalledTimes(1)
})

it.each([
  { namespace: 'default', custom: true },
  { namespace: 'engineering', custom: false },
])('rejects another namespace or a shared Model before deletion: %j', async metadata => {
  const { api, remove } = client(metadata.namespace, metadata.custom)
  await expect(deleteDedicatedBotModel(api, 'member', 'engineering')).rejects.toThrow()
  expect(remove).not.toHaveBeenCalled()
})

it('leaves a predefined Model alone when the generated Model was already removed', async () => {
  const { api, get, remove } = client()
  get.mockResolvedValue({ status: 404, data: null })
  await deleteDedicatedBotModel(api, 'member')
  expect(remove).not.toHaveBeenCalled()
})

it('reports failed Model cleanup instead of proceeding as though it succeeded', async () => {
  const { api, remove } = client('engineering')
  remove.mockResolvedValue({ status: 403, data: { detail: 'Forbidden' } })
  await expect(deleteDedicatedBotModel(api, 'member', 'engineering')).rejects.toThrow()
  expect(remove).toHaveBeenCalledTimes(1)
})

it('accepts a Model already removed between lookup and deletion', async () => {
  const { api, remove } = client('engineering')
  remove.mockResolvedValue({ status: 404, data: { detail: 'Not found' } })
  await expect(deleteDedicatedBotModel(api, 'member', 'engineering')).resolves.toBeUndefined()
  expect(remove).toHaveBeenCalledTimes(1)
})
