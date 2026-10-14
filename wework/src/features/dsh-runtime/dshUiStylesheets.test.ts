import { afterEach, expect, it } from 'vitest'
import { loadDshUiStylesheets } from './dshUiStylesheets'

afterEach(() => document.head.querySelectorAll('link').forEach(link => link.remove()))

it('waits for dependency CSS before completing module load and shares the same stylesheet', async () => {
  const url = 'http://localhost/assets/composer-test.css'
  let ready = false
  const first = loadDshUiStylesheets({ __weworkStylesheets: [url] }).then(() => {
    ready = true
  })
  const second = loadDshUiStylesheets({ __weworkStylesheets: [url] })
  await Promise.resolve()
  expect(ready).toBe(false)
  const links = document.head.querySelectorAll('link')
  expect(links).toHaveLength(1)
  expect(links[0].href).toBe(url)
  links[0].dispatchEvent(new Event('load'))
  await Promise.all([first, second])
  expect(ready).toBe(true)
})

it('rejects stylesheet failures instead of rendering unstyled module content', async () => {
  const loaded = loadDshUiStylesheets({
    __weworkStylesheets: ['http://localhost/assets/failed-test.css'],
  })
  const rejection = expect(loaded).rejects.toThrow('DSH UI stylesheet failed to load')
  document.head.querySelector('link')!.dispatchEvent(new Event('error'))
  await rejection
})
