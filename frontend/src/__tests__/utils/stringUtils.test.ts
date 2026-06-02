// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { truncateMiddle } from '@/utils/stringUtils'

describe('truncateMiddle', () => {
  describe('no truncation needed', () => {
    it('returns text unchanged when length < maxLength', () => {
      const result = truncateMiddle('hello', 10)
      expect(result).toBe('hello')
    })

    it('returns text unchanged when length === maxLength (boundary)', () => {
      const result = truncateMiddle('1234567890', 10)
      expect(result).toBe('1234567890')
    })
  })

  describe('truncation applied', () => {
    it('truncates with default startChars=8 and endChars=10', () => {
      const result = truncateMiddle('a-very-long-repository-url-string-here', 10)
      expect(result).toBe('a-very-l...tring-here')
    })

    it('respects custom startChars and endChars', () => {
      const result = truncateMiddle('abcdefghijklmnop', 10, 4, 4)
      expect(result).toBe('abcd...mnop')
    })

    it('produces output of length startChars + endChars + 3', () => {
      const result = truncateMiddle('abcdefghijklmnop', 5, 4, 4)
      expect(result).toBe('abcd...mnop')
      expect(result.length).toBe(4 + 4 + 3)
    })

    it('handles real-world repo URL (regression for RepositorySelector)', () => {
      const result = truncateMiddle('https://github.com/owner/repo', 25)
      expect(result).toBe('https://...owner/repo')
    })
  })

  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = truncateMiddle('', 10)
      expect(result).toBe('')
    })

    it('returns only ellipsis when startChars=0 and endChars=0', () => {
      const result = truncateMiddle('abcdefghijklmnop', 10, 0, 0)
      expect(result).toBe('...')
    })

    it('returns ellipsis + suffix when startChars=0', () => {
      const result = truncateMiddle('abcdefghijklmnop', 10, 0, 4)
      expect(result).toBe('...mnop')
    })

    it('returns prefix + ellipsis when endChars=0', () => {
      const result = truncateMiddle('abcdefghijklmnop', 10, 4, 0)
      expect(result).toBe('abcd...')
    })

    it('clamps negative startChars to 0', () => {
      const result = truncateMiddle('abcdefghijklmnop', 10, -2, 4)
      expect(result).toBe('...mnop')
    })

    it('clamps negative endChars to 0', () => {
      const result = truncateMiddle('abcdefghijklmnop', 10, 4, -2)
      expect(result).toBe('abcd...')
    })
  })

  it.todo('handles emoji without splitting surrogate pairs')
})
