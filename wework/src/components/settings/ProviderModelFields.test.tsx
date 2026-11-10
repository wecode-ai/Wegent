import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test } from 'vitest'
import type { ProviderModel } from '@/features/model-settings/providerModelConfiguration'
import { ProviderModelFields } from './ProviderModelFields'

function Editor({ compatibility }: { compatibility?: 'native' | 'standard' }) {
  const [model, setModel] = useState<ProviderModel>({
    id: 'model',
    model_id: 'arbitrary-model',
    codex_tool_compatibility: compatibility,
  })
  return (
    <ProviderModelFields
      model={model}
      provider={{
        id: 'provider',
        name: 'Custom API',
        base_url: 'https://custom.example',
        api_format: 'openai-responses',
        models: [model],
      }}
      onChange={patch => setModel(current => ({ ...current, ...patch }))}
    />
  )
}

test.each([undefined, 'standard', 'native'] as const)(
  'both editor controls show the effective compatibility value for %s',
  async compatibility => {
    const user = userEvent.setup()
    render(<Editor compatibility={compatibility} />)
    const technical = screen.getByTestId('provider-model-compatibility-model')
    expect(technical).toHaveValue(compatibility ?? 'standard')
    await user.click(screen.getByTestId('local-model-advanced-capabilities-toggle'))
    expect(screen.getByTestId('local-model-codex-tool-compatibility-select')).toHaveValue(
      compatibility ?? 'standard'
    )
  }
)

test('a first explicit native selection updates both controls', async () => {
  const user = userEvent.setup()
  render(<Editor />)
  const technical = screen.getByTestId('provider-model-compatibility-model')
  await user.click(technical.closest('details')!.querySelector('summary')!)
  await user.selectOptions(technical, 'native')
  expect(technical).toHaveValue('native')
  await user.click(screen.getByTestId('local-model-advanced-capabilities-toggle'))
  expect(screen.getByTestId('local-model-codex-tool-compatibility-select')).toHaveValue('native')
})
