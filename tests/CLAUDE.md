# Wegent E2E Testing Guidelines

This document contains guidelines for writing and maintaining E2E tests for the Wegent project.

---

## Rules

### Rule 1: Use data-testid for Element Selection

**When locating page elements, prefer using `data-testid` attributes.**

- ✅ **DO** use `data-testid` selectors when available
- ✅ **DO** add `data-testid` to frontend components when creating new tests
- ❌ **DON'T** rely solely on text content or CSS classes for element selection
- ❌ **DON'T** use complex XPath or fragile selectors

**Examples:**

```typescript
// ✅ CORRECT - Using data-testid
const createButton = page.locator('[data-testid="create-kb-card"]').first()
const submitButton = page.locator('[data-testid="submit-create-kb"]').first()

// ❌ AVOID - Using text content (prone to i18n issues)
const createButton = page.locator('button:has-text("Create")').first()

// ❌ AVOID - Using CSS classes (prone to styling changes)
const submitButton = page.locator('.btn-primary').first()
```

**When to Add data-testid:**
- Interactive elements (buttons, inputs, links, selects)
- Key UI components that need to be tested
- Dynamic content containers
- Modal dialogs and their triggers

---

### Rule 2: Update Test Case Documentation

**After generating new test cases, update the test case documentation file to describe:**
- What test cases exist
- What functionality each test covers
- The test file location

**Documentation File:** [TEST_CASES.md](./TEST_CASES.md)

**When updating:**
- Do a comprehensive check of all test files
- If the documentation is missing descriptions for some test cases, add them
- Keep the documentation organized by feature/module
- Include setup requirements if applicable

---

## Running Tests

```bash
# Run all tests
cd tests && sh run-tests.sh

# Run specific test file
TEST_BASE_URL=http://localhost:3000 sh run-tests.sh -t "Knowledge Flow"

# Run in headed mode (with browser UI)
sh run-tests.sh -h -t "Code Flow"

# Update authentication state
npx playwright codegen http://localhost:3000 --save-storage=.auth/user_localhost.json
```

---

## Best Practices

1. **Use descriptive test names** - Test names should clearly describe what is being tested
2. **Clean up test data** - Use `afterEach` to clean up created resources
3. **Handle onboarding** - Always skip onboarding tour in setup functions
4. **Wait for elements** - Use appropriate timeouts and visibility checks
5. **Handle dynamic content** - Use `Promise.race` or conditional checks for elements that may or may not appear
6. **Document data-testid requirements** - When adding tests that require new data-testid attributes, document them in the PR description

---

## Maintenance Checklist

When adding new tests:
- [ ] Use data-testid for element selection (Rule 1)
- [ ] Update TEST_CASES.md file with new test case descriptions (Rule 2)
- [ ] Add setup function if the test requires complex preparation
- [ ] Include cleanup logic in `afterEach`
- [ ] Test locally before committing
- [ ] Verify all existing tests still pass
