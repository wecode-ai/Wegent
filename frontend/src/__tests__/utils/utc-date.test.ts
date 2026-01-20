// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { parseUTCDate, formatUTCDate } from '@/lib/utils'

describe('UTC date utilities', () => {
  describe('parseUTCDate', () => {
    describe('handling null/undefined input', () => {
      it('should return null for null input', () => {
        expect(parseUTCDate(null)).toBeNull()
      })

      it('should return null for undefined input', () => {
        expect(parseUTCDate(undefined)).toBeNull()
      })

      it('should return null for empty string', () => {
        expect(parseUTCDate('')).toBeNull()
      })
    })

    describe('parsing dates without timezone suffix', () => {
      it('should treat date without timezone as UTC', () => {
        // Backend returns "2026-01-15T01:00:00" which should be parsed as UTC
        const date = parseUTCDate('2026-01-15T01:00:00')
        expect(date).not.toBeNull()
        // UTC hours should be 1
        expect(date!.getUTCHours()).toBe(1)
        expect(date!.getUTCMinutes()).toBe(0)
        expect(date!.getUTCSeconds()).toBe(0)
      })

      it('should parse date with seconds correctly', () => {
        const date = parseUTCDate('2026-01-15T12:30:45')
        expect(date).not.toBeNull()
        expect(date!.getUTCHours()).toBe(12)
        expect(date!.getUTCMinutes()).toBe(30)
        expect(date!.getUTCSeconds()).toBe(45)
      })

      it('should parse date with milliseconds correctly', () => {
        const date = parseUTCDate('2026-01-15T12:30:45.123')
        expect(date).not.toBeNull()
        expect(date!.getUTCMilliseconds()).toBe(123)
      })
    })

    describe('parsing dates with timezone suffix', () => {
      it('should parse date with Z suffix correctly', () => {
        const date = parseUTCDate('2026-01-15T01:00:00Z')
        expect(date).not.toBeNull()
        expect(date!.getUTCHours()).toBe(1)
      })

      it('should parse date with positive timezone offset correctly', () => {
        // +08:00 means the time is 8 hours ahead of UTC
        // So 09:00+08:00 = 01:00 UTC
        const date = parseUTCDate('2026-01-15T09:00:00+08:00')
        expect(date).not.toBeNull()
        expect(date!.getUTCHours()).toBe(1)
      })

      it('should parse date with negative timezone offset correctly', () => {
        // -05:00 means the time is 5 hours behind UTC
        // So 20:00-05:00 = 01:00+1day UTC
        const date = parseUTCDate('2026-01-14T20:00:00-05:00')
        expect(date).not.toBeNull()
        expect(date!.getUTCHours()).toBe(1)
        expect(date!.getUTCDate()).toBe(15)
      })
    })

    describe('edge cases', () => {
      it('should handle midnight correctly', () => {
        const date = parseUTCDate('2026-01-15T00:00:00')
        expect(date).not.toBeNull()
        expect(date!.getUTCHours()).toBe(0)
        expect(date!.getUTCMinutes()).toBe(0)
      })

      it('should handle end of day correctly', () => {
        const date = parseUTCDate('2026-01-15T23:59:59')
        expect(date).not.toBeNull()
        expect(date!.getUTCHours()).toBe(23)
        expect(date!.getUTCMinutes()).toBe(59)
        expect(date!.getUTCSeconds()).toBe(59)
      })

      it('should handle year boundary correctly', () => {
        const date = parseUTCDate('2025-12-31T23:59:59')
        expect(date).not.toBeNull()
        expect(date!.getUTCFullYear()).toBe(2025)
        expect(date!.getUTCMonth()).toBe(11) // December is month 11
        expect(date!.getUTCDate()).toBe(31)
      })
    })
  })

  describe('formatUTCDate', () => {
    describe('handling null/undefined input', () => {
      it('should return default fallback for null input', () => {
        expect(formatUTCDate(null)).toBe('-')
      })

      it('should return default fallback for undefined input', () => {
        expect(formatUTCDate(undefined)).toBe('-')
      })

      it('should return default fallback for empty string', () => {
        expect(formatUTCDate('')).toBe('-')
      })

      it('should return custom fallback when specified', () => {
        expect(formatUTCDate(null, 'N/A')).toBe('N/A')
        expect(formatUTCDate(undefined, '--')).toBe('--')
      })
    })

    describe('formatting valid dates', () => {
      it('should return a non-empty string for valid date', () => {
        const result = formatUTCDate('2026-01-15T01:00:00')
        expect(result).not.toBe('-')
        expect(result.length).toBeGreaterThan(0)
      })

      it('should format date with Z suffix correctly', () => {
        const result = formatUTCDate('2026-01-15T01:00:00Z')
        expect(result).not.toBe('-')
        expect(result.length).toBeGreaterThan(0)
      })

      it('should format date with timezone offset correctly', () => {
        const result = formatUTCDate('2026-01-15T09:00:00+08:00')
        expect(result).not.toBe('-')
        expect(result.length).toBeGreaterThan(0)
      })
    })

    describe('handling invalid dates', () => {
      it('should return fallback for invalid date string', () => {
        expect(formatUTCDate('not-a-date')).toBe('-')
      })

      it('should return fallback for partially invalid date', () => {
        expect(formatUTCDate('2026-13-45T99:99:99')).toBe('-')
      })
    })
  })

  describe('UTC to local timezone conversion consistency', () => {
    it('should produce same Date object for equivalent inputs', () => {
      // These should all represent the same moment in time
      const date1 = parseUTCDate('2026-01-15T00:00:00')
      const date2 = parseUTCDate('2026-01-15T00:00:00Z')

      expect(date1).not.toBeNull()
      expect(date2).not.toBeNull()
      expect(date1!.getTime()).toBe(date2!.getTime())
    })

    it('should correctly handle timezone conversion', () => {
      // UTC midnight should be different from +08:00 midnight
      const utcMidnight = parseUTCDate('2026-01-15T00:00:00Z')
      const cstMidnight = parseUTCDate('2026-01-15T00:00:00+08:00')

      expect(utcMidnight).not.toBeNull()
      expect(cstMidnight).not.toBeNull()
      // CST midnight is 8 hours behind UTC midnight (same day)
      expect(utcMidnight!.getTime() - cstMidnight!.getTime()).toBe(8 * 60 * 60 * 1000)
    })
  })
})
