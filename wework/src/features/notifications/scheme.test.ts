// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  parseWeworkScheme,
  weworkAppScheme,
  weworkDestinationRoute,
  weworkIssueScheme,
  weworkSmartAppScheme,
  weworkTaskScheme,
  weworkInteractionScheme,
} from './scheme'

describe('Wework scheme routing', () => {
  it('round trips the exact question identity, including turn scope and reserved characters', () => {
    const requestKey = 'scope:turn/1#item:question?keep'
    const address = { deviceId: 'device:1', taskId: 'review/#1' }
    const destination = parseWeworkScheme(weworkInteractionScheme(address, requestKey))!
    expect(destination).toEqual({ kind: 'interaction', ...address, requestKey })
    const route = new URL(weworkDestinationRoute(destination), 'https://local')
    expect(route.pathname).toBe('/pending-interactions')
    expect(JSON.parse(route.searchParams.get('interaction')!)).toEqual([
      address.deviceId,
      address.taskId,
      requestKey,
    ])
  })
  it('keeps local project storage in the destination and navigation route', () => {
    const url = weworkIssueScheme('local-project-1', 'OFF-1', 'local')
    const destination = parseWeworkScheme(url)!
    expect(destination).toEqual({
      kind: 'board',
      projectStore: 'local',
      projectId: 'local-project-1',
      itemId: 'OFF-1',
    })
    expect(weworkDestinationRoute(destination)).toBe(
      '/todo?projectStore=local&projectId=local-project-1&itemId=OFF-1'
    )
  })

  it('encodes notification targets without changing their identifiers', () => {
    expect(
      parseWeworkScheme(weworkTaskScheme({ deviceId: 'device:1', taskId: 'task/# 1' }))
    ).toEqual({ kind: 'task', deviceId: 'device:1', taskId: 'task/# 1' })
    expect(parseWeworkScheme(weworkIssueScheme('12', 'gitlab:12/issue#3'))).toEqual({
      kind: 'board',
      projectId: '12',
      itemId: 'gitlab:12/issue#3',
    })
  })
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
  it('round trips DSH app and Smart app destinations', () => {
    expect(parseWeworkScheme(weworkAppScheme('wegent/app'))).toEqual({
      kind: 'app',
      appId: 'wegent/app',
    })
    expect(weworkDestinationRoute(parseWeworkScheme(weworkAppScheme('wegent'))!)).toBe(
      '/app/wegent'
    )

    const smartApp = parseWeworkScheme(weworkSmartAppScheme(42))!
    expect(smartApp).toEqual({ kind: 'smart-app', smartAppId: 42 })
    expect(parseWeworkScheme('wework://smart-apps/%34%32')).toEqual({
      kind: 'smart-app',
      smartAppId: 42,
    })
    const route = new URL(weworkDestinationRoute(smartApp), 'https://local')
    expect(route.pathname).toBe('/sites')
    expect(route.searchParams.get('app_type')).toBe('smart_app')
    expect(route.searchParams.get('smartAppId')).toBe('42')
  })

  it.each([
    ['stand-in-chat-7-primary', '@primary'],
    ['stand-in-chat-7-role-review', 'review'],
  ])('opens the identity chat for %s notification clicks', (taskId, profileId) => {
    const destination = parseWeworkScheme(`wework://tasks/device/${taskId}`)!
    const route = new URL(weworkDestinationRoute(destination), 'https://local')
    expect(route.pathname).toBe('/stand-in')
    expect(route.searchParams.get('profileId')).toBe(profileId)
    expect(route.searchParams.get('deviceId')).toBe('device')
  })
  it('rejects invalid DSH app and Smart app destinations', () => {
    expect(parseWeworkScheme('wework://apps')).toBeNull()
    expect(parseWeworkScheme('wework://apps/')).toBeNull()
    expect(parseWeworkScheme('wework://apps/a/b')).toBeNull()
    expect(parseWeworkScheme('wework://smart-apps/0')).toBeNull()
    expect(parseWeworkScheme('wework://smart-apps/-1')).toBeNull()
    expect(parseWeworkScheme('wework://smart-apps/1.5')).toBeNull()
    expect(() => weworkSmartAppScheme(0)).toThrow()
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
  it('encodes the navigation request key using the same parameter read by the workbench', () => {
    const destination = parseWeworkScheme('wework://boards/12/issues/WEG-12/comments/c-1')!
    const route = new URL(weworkDestinationRoute(destination, 'second open/#'), 'https://local')

    expect(route.searchParams.get('focusRequest')).toBe('second open/#')
    expect(route.searchParams.get('commentId')).toBe('c-1')
  })
  it.each([
    'https://boards/12',
    'WEWORK://apps/wegent',
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
