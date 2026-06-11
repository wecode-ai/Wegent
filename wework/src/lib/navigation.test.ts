import { describe, expect, test } from 'vitest'
import { buildTaskRoute, parseTaskRoute } from './navigation'

describe('navigation task routes', () => {
  test('builds standalone task routes with projectId zero preserved', () => {
    expect(buildTaskRoute({ taskId: 1895, projectId: 0 })).toBe(
      '/projects/0/tasks/1895'
    )
  })

  test('parses project task routes with projectId zero preserved', () => {
    expect(parseTaskRoute('/projects/0/tasks/1895')).toEqual({
      taskId: 1895,
      projectId: 0,
    })
  })

  test('parses legacy standalone query routes', () => {
    expect(parseTaskRoute('/tasks/1895', '?projectId=0')).toEqual({
      taskId: 1895,
      projectId: 0,
    })
  })

  test('parses legacy query task routes', () => {
    expect(parseTaskRoute('/', '?taskId=1895&projectId=0')).toEqual({
      taskId: 1895,
      projectId: 0,
    })
  })
})
