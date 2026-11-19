import assert from 'node:assert/strict'
import test from 'node:test'
import { assertReadableSurface } from '../e2e/desktop/modules/ui-contrast.mjs'

const control = (text, sidebar, root) => ({
  async command(_action, selector, { value }) {
    return value === 'color' ? text : selector === 'sidebar' ? sidebar : root
  },
})

test('rejects the measured light and dark navigation category contrast', async () => {
  for (const colors of [
    ['rgb(138,143,152)', 'rgba(244,244,244,0.92)', 'rgb(255,255,255)'],
    ['rgb(128,128,128)', 'rgba(33,33,33,0.92)', 'rgb(24,24,24)'],
  ])
    await assert.rejects(
      assertReadableSurface(control(...colors), 'sidebar', 'category', ['body']),
      /4.5:1 contrast/
    )
})

test('composites text alpha instead of treating translucent white as opaque', async () => {
  await assert.rejects(
    assertReadableSurface(control('rgba(255,255,255,0.1)', 'rgb(24,24,24)'), 'sidebar'),
    /4.5:1 contrast/
  )
})

test('accepts secondary text on the actual translucent light sidebar', async () => {
  await assertReadableSurface(
    control('rgb(96,99,104)', 'rgba(244,244,244,0.92)', 'rgb(255,255,255)'),
    'sidebar',
    'category',
    ['body']
  )
})
