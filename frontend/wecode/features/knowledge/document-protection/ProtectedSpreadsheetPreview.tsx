// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ProtectedSpreadsheetPreviewProps {
  file: Blob
  onError?: (error: Error) => void
}

interface SheetData {
  name: string
  rows: string[][]
}

const MAX_ROWS = 1000
const MAX_COLUMNS = 100

export function ProtectedSpreadsheetPreview({ file, onError }: ProtectedSpreadsheetPreviewProps) {
  const [sheets, setSheets] = useState<SheetData[]>([])
  const [activeSheet, setActiveSheet] = useState(0)

  useEffect(() => {
    let active = true
    setSheets([])
    setActiveSheet(0)

    const parse = async () => {
      try {
        const { read, utils } = await import('styled-exceljs')
        const workbook = read(await file.arrayBuffer(), {
          type: 'array',
          cellDates: true,
        })
        const parsedSheets = workbook.SheetNames.map(name => {
          const rawRows = utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
            header: 1,
            raw: false,
            defval: '',
          })
          return {
            name,
            rows: rawRows
              .slice(0, MAX_ROWS)
              .map(row => row.slice(0, MAX_COLUMNS).map(value => String(value ?? ''))),
          }
        })
        if (active) setSheets(parsedSheets)
      } catch (error) {
        if (!active) return
        onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }

    void parse()
    return () => {
      active = false
    }
  }, [file, onError])

  if (sheets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const sheet = sheets[activeSheet]
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
      {sheets.length > 1 && (
        <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-border p-2">
          {sheets.map((item, index) => (
            <button
              key={item.name}
              type="button"
              className={
                index === activeSheet
                  ? 'rounded bg-primary px-3 py-1.5 text-xs text-white'
                  : 'rounded bg-surface px-3 py-1.5 text-xs text-text-secondary'
              }
              onClick={() => setActiveSheet(index)}
              data-testid={`protected-spreadsheet-sheet-${index}`}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse bg-base text-xs">
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((value, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="min-w-24 whitespace-pre-wrap border border-border px-2 py-1.5 align-top text-text-primary"
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
