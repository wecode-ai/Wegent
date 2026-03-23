// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from 'react'
import * as XLSX from 'xlsx'

export interface ExcelSheet {
  name: string
  data: (string | number | boolean | null)[][]
}

interface UseExcelParserReturn {
  sheets: ExcelSheet[]
  isLoading: boolean
  error: string | null
  parseExcel: (blob: Blob) => Promise<void>
}

/**
 * Hook for parsing Excel files using SheetJS
 */
export function useExcelParser(): UseExcelParserReturn {
  const [sheets, setSheets] = useState<ExcelSheet[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parseExcel = useCallback(async (blob: Blob) => {
    setIsLoading(true)
    setError(null)

    try {
      const arrayBuffer = await blob.arrayBuffer()
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      const parsedSheets: ExcelSheet[] = []

      for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName]
        const jsonData = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
          defval: '',
          blankrows: false,
        }) as (string | number | boolean | null)[][]

        parsedSheets.push({
          name: sheetName,
          data: jsonData,
        })
      }

      setSheets(parsedSheets)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to parse Excel file'
      setError(errorMessage)
      setSheets([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { sheets, isLoading, error, parseExcel }
}
