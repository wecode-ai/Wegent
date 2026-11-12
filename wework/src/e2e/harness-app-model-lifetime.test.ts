// @vitest-environment node

import { expect, test } from 'vitest'
import { assertCurrentHarnessAppSurface } from '../../e2e/desktop/modules/harness-app-models.mjs'

test('accepts the Host canonical URL for the same reopened runtime and document', () => {
  expect(() =>
    assertCurrentHarnessAppSurface(
      { contentsId: 42, url: 'http://127.0.0.1:34049/' },
      { contentsId: 42, webUrl: 'http://127.0.0.1:34049' }
    )
  ).not.toThrow()
})

const webUrl = 'http://127.0.0.1:34049/app?session=current#ready'

test('accepts the complete current document URL', () => {
  expect(() =>
    assertCurrentHarnessAppSurface({ contentsId: 42, url: webUrl }, { contentsId: 42, webUrl })
  ).not.toThrow()
})

test.each([
  ['protocol', 'https://127.0.0.1:34049/app?session=current#ready'],
  ['host', 'http://localhost:34049/app?session=current#ready'],
  ['port', 'http://127.0.0.1:34048/app?session=current#ready'],
  ['path', 'http://127.0.0.1:34049/old?session=current#ready'],
  ['query', 'http://127.0.0.1:34049/app?session=old#ready'],
  ['fragment', 'http://127.0.0.1:34049/app?session=current#old'],
])('rejects a stale runtime %s after the held response is released', (_component, url) => {
  expect(() =>
    assertCurrentHarnessAppSurface({ contentsId: 42, url }, { contentsId: 42, webUrl })
  ).toThrow('A late response restored an obsolete runtime URL')
})

test('rejects a replaced document even when its complete URL matches', () => {
  expect(() =>
    assertCurrentHarnessAppSurface({ contentsId: 41, url: webUrl }, { contentsId: 42, webUrl })
  ).toThrow('A late response replaced the current Host surface')
})
