import { act, render } from '@testing-library/react'
import { vi } from 'vitest'

/** Settle modules requested by this render without preloading or advancing fixture clocks. */
export async function renderLazy(...args: Parameters<typeof render>) {
  const view = render(...args)
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return view
}
