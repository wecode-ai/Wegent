import { afterEach, expect, test, vi } from 'vitest'
import { CLOUD_PUBLIC_MODEL_NAME } from '../../e2e/desktop/modules/shared.mjs'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-model-catalog.scenario.mjs'

afterEach(() => vi.unstubAllGlobals())

function catalogFixture(failCreationAt?: number, failedDeleteId?: number) {
  const created: number[] = []
  const deleted: number[] = []
  const request = vi.fn(async (url: string, options?: RequestInit) => {
    const path = new URL(url).pathname
    if (options?.method === 'DELETE') {
      const id = Number(path.split('/').at(-1))
      deleted.push(id)
      return new Response(null, { status: id === failedDeleteId ? 500 : 204 })
    }
    if (path === '/api/users/me') return Response.json({ id: 1 })
    if (path === '/api/admin/public-models' && options?.method === 'POST') {
      if (created.length === failCreationAt)
        return Response.json({ detail: 'Fixture creation failed' }, { status: 500 })
      const id = created.length + 1
      created.push(id)
      return Response.json({ id })
    }
    if (path === '/api/admin/public-models')
      return Response.json({
        items: [
          {
            name: CLOUD_PUBLIC_MODEL_NAME,
            json: { spec: { modelConfig: { env: { model_id: 'upstream' } } } },
          },
        ],
      })
    expect(path).toBe('/api/admin/setup-complete')
    return Response.json({})
  })
  vi.stubGlobal('fetch', request)
  const scenario = createDesktopScenario({ uiTimeoutMs: 1000 })
  const environment = { backendUrl: 'http://catalog.test', authToken: 'fixture-auth' }
  return { scenario, environment, created, deleted, request }
}

test.each([0, 1, 2])('cleans every fixture after creation fails at index %i', async index => {
  const fixture = catalogFixture(index)
  await expect(fixture.scenario.prepareCloud(fixture.environment)).rejects.toThrow(
    'Fixture creation failed'
  )
  await fixture.scenario.cleanup()
  expect(fixture.created).toHaveLength(index)
  expect(fixture.deleted).toEqual(fixture.created)
})

test('cleans fixtures if startup fails after successful catalog setup', async () => {
  const fixture = catalogFixture()
  await fixture.scenario.prepareCloud(fixture.environment)
  await fixture.scenario.cleanup()
  expect(fixture.deleted).toEqual([1, 2, 3])
  for (const id of fixture.created) {
    expect(fixture.request).toHaveBeenCalledWith(
      `${fixture.environment.backendUrl}/api/admin/public-models/${id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${fixture.environment.authToken}` },
      }
    )
  }
  await fixture.scenario.cleanup()
  expect(fixture.deleted).toEqual([1, 2, 3])
})

test('reports deletion failures while still attempting all created fixtures', async () => {
  const fixture = catalogFixture(undefined, 2)
  await fixture.scenario.prepareCloud(fixture.environment)
  await expect(fixture.scenario.cleanup()).rejects.toMatchObject({
    message: 'Catalog fixture cleanup failed',
    errors: [
      expect.objectContaining({
        message: expect.stringContaining('Catalog fixture cleanup must return 204'),
        actual: 500,
        expected: 204,
      }),
    ],
  })
  expect(fixture.deleted).toEqual([1, 2, 3])
})
