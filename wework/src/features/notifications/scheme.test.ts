import { describe, expect, it } from 'vitest'
import { parseWeworkScheme, weworkDestinationRoute } from './scheme'

describe('Wework scheme routing', () => {
  it('preserves external Issue identifiers and targets backend storage', () => {
    const destination = parseWeworkScheme('wework://boards/12/issues/gitlab%3A12%2Fissue%233')!
    expect(destination).toEqual({ kind: 'board', projectId: '12', itemId: 'gitlab:12/issue#3' })
    const route = new URL(weworkDestinationRoute(destination), 'https://local')
    expect(route.pathname).toBe('/todo')
    expect(route.searchParams.get('projectStore')).toBe('backend')
    expect(route.searchParams.get('itemId')).toBe('gitlab:12/issue#3')
  })
  it.each(['wework://boards', 'wework://boards/'])('opens the board homepage: %s', url => {
    expect(parseWeworkScheme(url)).toEqual({ kind: 'boards' })
    expect(weworkDestinationRoute(parseWeworkScheme(url)!)).toBe('/todo')
  })
  it('supports boards and device-owned tasks', () => {
    expect(parseWeworkScheme('wework://boards/12')).toEqual({ kind: 'board', projectId: '12' })
    expect(weworkDestinationRoute(parseWeworkScheme('wework://tasks/local-device/task-1')!)).toBe(
      '/runtime-tasks?deviceId=local-device&taskId=task-1'
    )
  })
  it('carries the comment a notification points at into the board route', () => {
    const destination = parseWeworkScheme('wework://boards/12/issues/WEG-12/comments/c-1')!
    expect(destination).toEqual({
      kind: 'board',
      projectId: '12',
      itemId: 'WEG-12',
      commentId: 'c-1',
    })
    const route = new URL(weworkDestinationRoute(destination), 'https://local')
    expect(route.pathname).toBe('/todo')
    expect(route.searchParams.get('itemId')).toBe('WEG-12')
    expect(route.searchParams.get('commentId')).toBe('c-1')
  })
  it.each([
    'https://boards/12',
    'wework://boards/0',
    'wework://boards/12/issues/',
    'wework://boards/12/issues/WEG-12/comments',
    'wework://boards/12/comments/c-1',
    'wework://boards/12/issues/WEG-12/notes/c-1',
    'wework://boards/12/issues/%00',
    'wework://boards/12/issues/%FF',
    'wework://user@boards/12',
    'wework://boards/12?redirect=https://evil.test',
    'wework://shell/run',
    'wework://boards/12/../13',
  ])('rejects invalid or privileged navigation: %s', url => {
    expect(parseWeworkScheme(url)).toBeNull()
  })
})
