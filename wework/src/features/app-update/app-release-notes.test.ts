import { beforeEach, describe, expect, test } from 'vitest'
import {
  APP_UPDATE_PENDING_RELEASE_NOTES_KEY,
  clearPendingWeworkReleaseNotes,
  readPendingWeworkReleaseNotes,
  writePendingWeworkReleaseNotes,
} from './app-release-notes'

describe('app release notes storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('round-trips a valid release notes record', () => {
    writePendingWeworkReleaseNotes({
      version: '0.2.0',
      body: '## Changes\n\n- Added a changelog.',
    })

    expect(readPendingWeworkReleaseNotes()).toEqual({
      version: '0.2.0',
      body: '## Changes\n\n- Added a changelog.',
    })
  })

  test('removes malformed and incomplete records', () => {
    localStorage.setItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY, '{"version":7}')

    expect(readPendingWeworkReleaseNotes()).toBeNull()
    expect(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)).toBeNull()

    localStorage.setItem(
      APP_UPDATE_PENDING_RELEASE_NOTES_KEY,
      JSON.stringify({ version: '0.2.0', body: '  ' })
    )

    expect(readPendingWeworkReleaseNotes()).toBeNull()
    expect(localStorage.getItem(APP_UPDATE_PENDING_RELEASE_NOTES_KEY)).toBeNull()
  })

  test('only clears a record when the optional version matches', () => {
    writePendingWeworkReleaseNotes({
      version: '0.2.0',
      body: '## Changes',
    })

    clearPendingWeworkReleaseNotes('0.1.0')
    expect(readPendingWeworkReleaseNotes()?.version).toBe('0.2.0')

    clearPendingWeworkReleaseNotes('0.2.0')
    expect(readPendingWeworkReleaseNotes()).toBeNull()
  })
})
