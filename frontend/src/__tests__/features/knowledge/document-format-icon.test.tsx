// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render } from '@testing-library/react'
import { DocumentFormatIcon } from '@/components/icons/DocumentFormatIcon'

describe('DocumentFormatIcon', () => {
  it.each([
    [' .PDF ', 'lucide-file-text', 'text-error'],
    ['DOC', 'lucide-file-text', 'text-blue-600'],
    ['adoc', 'lucide-file-text', 'text-blue-600'],
    ['md', 'lucide-file-text', 'text-blue-600'],
    ['.xls', 'lucide-file-spreadsheet', 'text-green-600'],
    ['xlsx', 'lucide-file-spreadsheet', 'text-green-600'],
    ['axls', 'lucide-file-spreadsheet', 'text-green-600'],
    ['csv', 'lucide-file-spreadsheet', 'text-green-600'],
    ['able', 'lucide-table-2', 'text-primary'],
    ['ppt', 'lucide-presentation', 'text-orange-600'],
    ['appt', 'lucide-presentation', 'text-orange-600'],
    ['html', 'lucide-globe', 'text-blue-600'],
    ['dlink', 'lucide-link-2', 'text-blue-600'],
    ['PNG', 'lucide-image', 'text-purple-600'],
    ['mp3', 'lucide-file-headphone', 'text-orange-600'],
    ['mp4', 'lucide-file-play', 'text-purple-600'],
    ['unrecognized', 'lucide-file', 'text-text-muted'],
    ['', 'lucide-file', 'text-text-muted'],
    [undefined, 'lucide-file', 'text-text-muted'],
  ])('shows the format of %s without relying on the provider', (extension, shape, color) => {
    const { container } = render(<DocumentFormatIcon extension={extension} />)
    expect(container.querySelector('svg')).toHaveClass(shape, color, 'h-4', 'w-4')
  })

  it.each([
    ['web', 'lucide-globe', 'text-blue-600'],
    ['external', 'lucide-file-spreadsheet', 'text-green-600'],
  ])('preserves %s semantics and the caller size', (sourceType, shape, color) => {
    const { container } = render(
      <DocumentFormatIcon extension="xlsx" sourceType={sourceType} className="h-3 w-3" />
    )
    expect(container.querySelector('svg')).toHaveClass(shape, color, 'h-3', 'w-3')
    expect(container.querySelector('svg')).not.toHaveClass('h-4', 'w-4')
  })
})
