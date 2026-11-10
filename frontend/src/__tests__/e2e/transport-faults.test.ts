import type { Route } from '@playwright/test'
import { failRequestTransport } from '../../../e2e/utils/transport-faults'

describe('transport fault injection', () => {
  it('aborts the original request without opening a second failure-prone transport', async () => {
    const abort = jest.fn().mockResolvedValue(undefined)
    const fetch = jest.fn().mockRejectedValue(new Error('read ECONNRESET'))
    await failRequestTransport({ abort, fetch } as unknown as Route)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledWith('failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('propagates injection failures without retrying or hiding them', async () => {
    const abort = jest.fn().mockRejectedValue(new Error('route disposed'))
    await expect(failRequestTransport({ abort } as unknown as Route)).rejects.toThrow(
      'route disposed'
    )
    expect(abort).toHaveBeenCalledTimes(1)
  })
})
