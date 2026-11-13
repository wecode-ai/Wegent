import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { DshIcon } from './DshIcon'

describe('DshIcon', () => {
  test('renders download from a static alias', () => {
    const { container } = render(<DshIcon name="download" />)

    expect(container.querySelector('svg.lucide-download')).toBeInTheDocument()
    expect(container.querySelector('svg.lucide-grid-3x3')).not.toBeInTheDocument()
  })
})
