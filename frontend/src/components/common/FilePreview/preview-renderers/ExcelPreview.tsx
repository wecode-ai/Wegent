// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import type { ExcelSheet } from '../hooks/useExcelParser'

interface ExcelPreviewProps {
  sheets: ExcelSheet[]
  filename: string
}

export function ExcelPreview({ sheets, filename }: ExcelPreviewProps) {
  const [activeSheet, setActiveSheet] = useState(0)

  if (sheets.length === 0) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-gray-900 items-center justify-center">
        <div className="text-text-secondary">无法解析表格内容</div>
      </div>
    )
  }

  const currentSheet = sheets[activeSheet]

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 p-2 bg-surface dark:bg-gray-800 border-b border-border dark:border-gray-700 overflow-x-auto">
          {sheets.map((sheet, index) => (
            <button
              key={index}
              onClick={() => setActiveSheet(index)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                index === activeSheet
                  ? 'bg-white dark:bg-gray-700 text-text-primary dark:text-white shadow-sm border border-border dark:border-gray-600'
                  : 'text-text-secondary hover:text-text-primary hover:bg-white/50 dark:hover:bg-gray-700/50'
              }`}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      {/* Table content */}
      <div className="flex-1 overflow-auto">
        <div className="inline-block min-w-full">
          <table className="border-collapse text-sm">
            <tbody>
              {currentSheet.data.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex === 0 ? 'bg-surface dark:bg-gray-800' : ''}>
                  {/* Row number */}
                  <td className="sticky left-0 w-12 px-2 py-2 text-right text-xs text-text-secondary bg-inherit dark:bg-gray-800 border-r border-b border-border dark:border-gray-700 select-none">
                    {rowIndex + 1}
                  </td>
                  {row.map((cell, cellIndex) => {
                    const isHeader = rowIndex === 0
                    const cellValue = cell !== null && cell !== undefined ? String(cell) : ''

                    return (
                      <td
                        key={cellIndex}
                        className={`px-3 py-2 border-r border-b border-border dark:border-gray-700 min-w-[80px] max-w-[400px] ${
                          isHeader
                            ? 'font-semibold text-text-primary dark:text-white bg-surface dark:bg-gray-800'
                            : 'text-text-primary dark:text-gray-200 bg-white dark:bg-gray-900'
                        }`}
                        title={cellValue}
                      >
                        <div className="truncate">{cellValue}</div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 bg-surface dark:bg-gray-800 border-t border-border dark:border-gray-700 text-xs text-text-secondary">
        {filename} · {currentSheet.name} · {currentSheet.data.length} 行
      </div>
    </div>
  )
}
