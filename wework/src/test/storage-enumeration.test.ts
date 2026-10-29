import { expect, test } from 'vitest'

test('storage keys remain enumerable through the shared test storage', () => {
  localStorage.setItem('fixture:first', 'one')
  localStorage.setItem('fixture:second', 'two')
  expect(localStorage.length).toBe(2)
  expect(localStorage.key(0)).toBe('fixture:first')
  expect(Object.keys(localStorage)).toEqual(['fixture:first', 'fixture:second'])
  localStorage.removeItem('fixture:first')
  expect(Object.keys(localStorage)).toEqual(['fixture:second'])
  localStorage.clear()
  expect(Object.keys(localStorage)).toEqual([])
})
