// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const DAY_MS = 86_400_000

function dateParts(value: string): [number, number, number] {
  const [year, month, day] = value.split('-').map(Number)
  return [year, month, day]
}

export function formatLocalDate(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function localYesterday(): string {
  const value = new Date()
  value.setDate(value.getDate() - 1)
  return formatLocalDate(value)
}

export function inclusiveDateCount(start: string, end: string): number {
  const [startYear, startMonth, startDay] = dateParts(start)
  const [endYear, endMonth, endDay] = dateParts(end)
  const startMs = Date.UTC(startYear, startMonth - 1, startDay)
  const endMs = Date.UTC(endYear, endMonth - 1, endDay)
  return Math.floor((endMs - startMs) / DAY_MS) + 1
}

export function enumerateDateRange(start: string, end: string): string[] {
  const [startYear, startMonth, startDay] = dateParts(start)
  const [endYear, endMonth, endDay] = dateParts(end)
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, startDay))
  const endMs = Date.UTC(endYear, endMonth - 1, endDay)
  const dates: string[] = []
  while (cursor.getTime() <= endMs) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}
