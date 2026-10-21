import { beforeEach, describe, expect, it } from 'vitest'
import {
  readStandInRecords,
  writeStandInRecords,
  STAND_IN_RECORD_LIMIT,
  STAND_IN_RECORD_MAX_AGE_MS,
} from './standInNotificationStorage'

beforeEach(() => localStorage.clear())
describe('bounded stand-in notification records', () => {
  it('expires read and delivery markers on both reads and writes', () => {
    const now = Date.now()
    const records = {
      expired: { version: 'completed:old', savedAt: now - STAND_IN_RECORD_MAX_AGE_MS },
      current: { version: 'completed:new', savedAt: now },
    }
    localStorage.setItem('read', JSON.stringify(records))
    expect(Object.keys(readStandInRecords('read', now))).toEqual(['current'])
    expect(JSON.parse(localStorage.getItem('read')!)).not.toHaveProperty('expired')
    expect(Object.keys(writeStandInRecords('delivered', records, now))).toEqual(['current'])
  })
  it('keeps only the newest 1000 records', () => {
    const now = Date.now()
    const records = Object.fromEntries(
      Array.from({ length: STAND_IN_RECORD_LIMIT + 30 }, (_, index) => [
        String(index),
        { version: 'completed:result', savedAt: now - index },
      ])
    )
    expect(Object.keys(writeStandInRecords('read', records, now))).toHaveLength(
      STAND_IN_RECORD_LIMIT
    )
    expect(readStandInRecords('read', now)).toHaveProperty('0')
    expect(readStandInRecords('read', now)).not.toHaveProperty('1000')
  })
  it('removes malformed and invalid records without crashing the inbox', () => {
    localStorage.setItem('read', '{')
    expect(readStandInRecords('read')).toEqual({})
    expect(localStorage.getItem('read')).toBeNull()
    expect(writeStandInRecords('read', { invalid: { version: 'x', savedAt: NaN } })).toEqual({})
  })
})
