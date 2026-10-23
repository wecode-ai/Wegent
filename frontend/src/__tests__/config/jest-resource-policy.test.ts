/** @jest-environment node */

import resolveJestConfig from '../../../jest.config'

jest.mock('next/jest', () => () => (config: unknown) => async () => config)

describe('Jest worker resource policy', () => {
  it('recycles idle worker heaps without relaxing timeouts or excluding tests', async () => {
    const config = await resolveJestConfig()

    expect(config.workerIdleMemoryLimit).toBe('512MB')
    expect(config).not.toHaveProperty('testTimeout')
    expect(config).not.toHaveProperty('bail')
    expect(config.testMatch).toEqual([
      '<rootDir>/src/__tests__/**/*.test.{js,jsx,ts,tsx}',
      '<rootDir>/src/features/collaboration/shared-api/**/*.test.{ts,tsx}',
    ])
  })
})
