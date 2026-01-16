# E2E Testing with Code Coverage

This directory contains end-to-end tests for the Wegent frontend using Playwright.

## Running Tests

### Basic Commands

```bash
# Run all E2E tests
npm run e2e

# Run tests with UI mode
npm run e2e:ui

# Run tests in debug mode
npm run e2e:debug

# Run tests in headed mode (see browser)
npm run e2e:headed

# View test report
npm run e2e:report
```

### Local Development

```bash
# Run E2E tests locally (starts services automatically)
npm run e2e:local

# With UI mode
npm run e2e:local:ui

# With debug mode
npm run e2e:local:debug
```

## Code Coverage

### Collecting Coverage

The E2E tests can collect code coverage data from the frontend application during test execution.

```bash
# Run tests and generate coverage report
npm run e2e:coverage

# Generate coverage report from existing data
npm run e2e:coverage:report
```

### Coverage Reports

Coverage reports are generated in the following formats:

- **HTML Report**: `coverage-e2e/index.html` - Interactive HTML report
- **LCOV Report**: `coverage-e2e/lcov.info` - For CI/CD integration
- **Text Report**: Printed to console

### Coverage Configuration

Coverage settings are configured in [`.nycrc.json`](../.nycrc.json):

- **Included**: All files in `src/**/*.{js,jsx,ts,tsx}`
- **Excluded**: Test files, config files, type definitions
- **Thresholds**: 60% lines/statements/functions, 50% branches

### Using Coverage in Tests

To enable coverage collection in your tests, use the coverage helper:

```typescript
import { test } from '@playwright/test'
import { startCoverage, stopCoverage } from '../helpers/coverage'

test('my test with coverage', async ({ page }) => {
  // Start coverage collection
  await startCoverage(page)

  // Your test code here
  await page.goto('/')
  // ... test actions ...

  // Stop coverage and save results
  await stopCoverage(page, 'my-test-name')
})
```

### Coverage in CI/CD

Coverage data is automatically collected during CI/CD runs. The coverage reports are:

1. Uploaded as artifacts
2. Used to generate coverage badges
3. Compared against thresholds

## Test Structure

```
e2e/
├── tests/              # Test files
│   ├── admin/         # Admin panel tests
│   ├── api/           # API tests
│   ├── auth/          # Authentication tests
│   ├── settings/      # Settings page tests
│   └── tasks/         # Task management tests
├── pages/             # Page Object Models
│   ├── auth/          # Auth page objects
│   ├── admin/         # Admin page objects
│   └── settings/      # Settings page objects
├── fixtures/          # Test data and builders
├── helpers/           # Test utilities
│   └── coverage.ts    # Coverage collection helper
├── utils/             # Shared utilities
└── config/            # Test configuration
```

## Page Object Model

Tests use the Page Object Model pattern for better maintainability:

```typescript
import { LoginPage } from '../pages/auth/login.page'

test('login test', async ({ page }) => {
  const loginPage = new LoginPage(page)
  await loginPage.navigate()
  await loginPage.login('username', 'password')
  expect(await loginPage.isLoggedIn()).toBe(true)
})
```

## Best Practices

1. **Use Page Objects**: Encapsulate page interactions in page objects
2. **Descriptive Test Names**: Use clear, descriptive test names
3. **Independent Tests**: Each test should be independent and isolated
4. **Clean Up**: Always clean up test data in `afterEach` hooks
5. **Wait Strategies**: Use proper wait strategies instead of fixed timeouts
6. **Coverage**: Enable coverage for integration and critical path tests

## Debugging

### Visual Debugging

```bash
# Run with UI mode to see tests execute
npm run e2e:ui

# Run in headed mode to see browser
npm run e2e:headed

# Run in debug mode with breakpoints
npm run e2e:debug
```

### Trace Viewer

When tests fail, traces are automatically captured:

```bash
# View trace for failed test
npx playwright show-trace test-results/path-to-trace.zip
```

## CI/CD Integration

E2E tests run automatically in GitHub Actions:

- On pull requests
- On pushes to main branch
- Nightly scheduled runs

See [`.github/workflows/e2e-tests.yml`](../../.github/workflows/e2e-tests.yml) for configuration.

## Troubleshooting

### Tests Timing Out

- Increase timeout in `playwright.config.ts`
- Check if services are running
- Verify network connectivity

### Coverage Not Collected

- Ensure `startCoverage()` is called before navigation
- Check that source maps are enabled in Next.js
- Verify `.nycrc.json` configuration

### Flaky Tests

- Use proper wait strategies (`waitForSelector`, `waitForLoadState`)
- Avoid fixed timeouts (`page.waitForTimeout`)
- Ensure test data is properly cleaned up

## Resources

- [Playwright Documentation](https://playwright.dev)
- [NYC Coverage Documentation](https://github.com/istanbuljs/nyc)
- [Page Object Model Pattern](https://playwright.dev/docs/pom)
