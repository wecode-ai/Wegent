import { describe, expect, test } from 'vitest'

import { desktopControlExtension } from './desktop-control'

describe('desktop control fallback extension', () => {
  test('leaves product-specific actions unhandled', async () => {
    await expect(
      desktopControlExtension.execute({
        id: 'command-1',
        action: 'productSpecificAction',
        selector: '',
      })
    ).resolves.toEqual({ handled: false })
  })
})
