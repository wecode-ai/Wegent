---
description: "Provides browser automation capabilities in sandbox environment using Playwright framework. Supports page navigation, element interaction, form filling, and screenshot capture. Ideal for web scraping, form automation, and webpage screenshots."
displayName: "Browser Automation"
version: "1.0.0"
author: "Wegent Team"
tags: ["browser", "automation", "playwright", "web-scraping"]
bindShells: ["Chat"]
dependencies:
  - sandbox
provider:
  module: provider
  class: BrowserToolProvider
config:
  default_timeout: 30
  screenshot_max_size: 10485760
  headless: true
tools:
  - name: browser_navigate
    provider: browser
  - name: browser_click
    provider: browser
  - name: browser_fill
    provider: browser
  - name: browser_screenshot
    provider: browser
    config:
      max_file_size: 10485760
---

# Browser Automation

Execute browser automation tasks securely in isolated sandbox containers using **Playwright** framework.

## Core Capabilities

The browser automation skill provides:

1. **Page Navigation** - Open URLs, navigate back/forward, refresh pages
2. **Element Interaction** - Click buttons, links, and other clickable elements
3. **Form Filling** - Fill text inputs, textareas, and other form fields
4. **Screenshot Capture** - Take screenshots of full pages or specific elements

## When to Use

Use this skill when you need to:

- Open and navigate web pages
- Click buttons or links on web pages
- Fill out forms automatically
- Take screenshots of web pages or specific elements
- Scrape data from websites that require interaction
- Test web applications

## Prerequisites

Before using browser tools, **Playwright must be installed** in the sandbox environment. The browser tools will automatically attempt to install Playwright if not present, but you can also install it manually:

```bash
pip install playwright && playwright install chromium --with-deps
```

**Note**: The first browser operation may take longer as it needs to install Playwright and the Chromium browser.

## Available Tools

### Page Navigation

#### `browser_navigate`
Navigate to a URL or perform navigation actions (back, forward, reload).

**Use Cases:**
- Open a new web page
- Navigate to the previous page
- Refresh the current page
- Wait for page to fully load

**Parameters:**
- `url` (required): Target URL to navigate to
- `action` (optional): Navigation action - `goto` (default), `back`, `forward`, `reload`
- `wait_until` (optional): Wait condition - `load`, `domcontentloaded`, `networkidle` (default)
- `timeout_seconds` (optional): Navigation timeout in seconds (default: 30)

**Returns:**
- `success`: Whether navigation succeeded
- `url`: Current page URL after navigation
- `title`: Page title
- `status`: Page load status

**Example - Open a webpage:**
```json
{
  "name": "browser_navigate",
  "arguments": {
    "url": "https://example.com",
    "wait_until": "networkidle"
  }
}
```

**Example - Go back:**
```json
{
  "name": "browser_navigate",
  "arguments": {
    "url": "",
    "action": "back"
  }
}
```

---

### Element Interaction

#### `browser_click`
Click on a page element using CSS selector, XPath, or text content.

**Use Cases:**
- Click buttons to submit forms
- Click links to navigate
- Click checkboxes or radio buttons
- Interact with dropdown menus

**Parameters:**
- `selector` (required): CSS selector, XPath expression, or text to match
- `selector_type` (optional): Selector type - `css` (default), `xpath`, `text`
- `timeout_seconds` (optional): Element wait timeout in seconds (default: 10)
- `force` (optional): Force click even if element is not visible (default: false)

**Returns:**
- `success`: Whether click succeeded
- `element_info`: Information about the clicked element

**Example - Click by CSS selector:**
```json
{
  "name": "browser_click",
  "arguments": {
    "selector": "button.submit-btn",
    "selector_type": "css"
  }
}
```

**Example - Click by text:**
```json
{
  "name": "browser_click",
  "arguments": {
    "selector": "Sign In",
    "selector_type": "text"
  }
}
```

**Example - Click by XPath:**
```json
{
  "name": "browser_click",
  "arguments": {
    "selector": "//button[@type='submit']",
    "selector_type": "xpath"
  }
}
```

---

### Form Filling

#### `browser_fill`
Fill text into an input field.

**Use Cases:**
- Fill username/password fields
- Enter search queries
- Fill out contact forms
- Input data into text areas

**Parameters:**
- `selector` (required): CSS selector or XPath for the input element
- `value` (required): Text content to fill
- `selector_type` (optional): Selector type - `css` (default), `xpath`
- `clear_first` (optional): Clear existing content before filling (default: true)
- `timeout_seconds` (optional): Element wait timeout in seconds (default: 10)

**Returns:**
- `success`: Whether fill operation succeeded

**Example - Fill a text input:**
```json
{
  "name": "browser_fill",
  "arguments": {
    "selector": "#username",
    "value": "testuser"
  }
}
```

**Example - Fill with XPath:**
```json
{
  "name": "browser_fill",
  "arguments": {
    "selector": "//input[@name='email']",
    "value": "test@example.com",
    "selector_type": "xpath"
  }
}
```

---

### Screenshot Capture

#### `browser_screenshot`
Take a screenshot of the current page or a specific element.

**Use Cases:**
- Capture full page screenshots
- Screenshot specific elements
- Document webpage state
- Visual testing and verification

**Parameters:**
- `file_path` (required): Path to save the screenshot file
- `selector` (optional): CSS selector for specific element (if not provided, captures full viewport)
- `full_page` (optional): Capture entire scrollable page (default: false)
- `type` (optional): Image format - `png` (default), `jpeg`
- `quality` (optional): JPEG quality 0-100 (only for jpeg format)

**Returns:**
- `success`: Whether screenshot was captured
- `file_path`: Path where screenshot was saved
- `width`: Image width in pixels
- `height`: Image height in pixels
- `file_size`: File size in bytes

**Limits:**
- Maximum file size: 10MB

**Example - Full page screenshot:**
```json
{
  "name": "browser_screenshot",
  "arguments": {
    "file_path": "/home/user/screenshot.png",
    "full_page": true
  }
}
```

**Example - Element screenshot:**
```json
{
  "name": "browser_screenshot",
  "arguments": {
    "file_path": "/home/user/header.png",
    "selector": "header.main-header"
  }
}
```

**Example - JPEG with quality:**
```json
{
  "name": "browser_screenshot",
  "arguments": {
    "file_path": "/home/user/page.jpg",
    "type": "jpeg",
    "quality": 80
  }
}
```

---

## Tool Selection Guide

| Task Type | Recommended Tool | Notes |
|-----------|-----------------|-------|
| Open a webpage | `browser_navigate` | Use `wait_until: networkidle` for dynamic pages |
| Click a button/link | `browser_click` | Use appropriate selector type |
| Fill form fields | `browser_fill` | Set `clear_first: true` for clean input |
| Take screenshots | `browser_screenshot` | Use `full_page: true` for scrollable content |
| Navigate browser history | `browser_navigate` | Use `action: back` or `action: forward` |

---

## Usage Examples

### Scenario 1: Web Data Scraping

```json
// 1. Open target webpage
{"name": "browser_navigate", "arguments": {"url": "https://example.com/data"}}

// 2. Click load more button
{"name": "browser_click", "arguments": {"selector": "button.load-more"}}

// 3. Take full page screenshot
{"name": "browser_screenshot", "arguments": {"file_path": "/home/user/page.png", "full_page": true}}
```

### Scenario 2: Form Automation

```json
// 1. Open form page
{"name": "browser_navigate", "arguments": {"url": "https://example.com/form"}}

// 2. Fill username
{"name": "browser_fill", "arguments": {"selector": "#username", "value": "testuser"}}

// 3. Fill email
{"name": "browser_fill", "arguments": {"selector": "#email", "value": "test@example.com"}}

// 4. Click submit button
{"name": "browser_click", "arguments": {"selector": "button[type='submit']"}}
```

### Scenario 3: Webpage Screenshot

```json
// 1. Open webpage
{"name": "browser_navigate", "arguments": {"url": "https://example.com"}}

// 2. Take full page screenshot
{"name": "browser_screenshot", "arguments": {"file_path": "/home/user/fullpage.png", "full_page": true}}

// 3. Upload screenshot for user download
{"name": "sandbox_upload_attachment", "arguments": {"file_path": "/home/user/fullpage.png"}}
```

---

## Browser Environment

### Configuration
- **Browser**: Chromium (headless mode)
- **Framework**: Playwright
- **Running Mode**: Headless (no display required)

### Session Management
- Browser instance is created on first tool call
- Subsequent calls in the same session reuse the browser
- Browser state (cookies, localStorage) persists within session
- Browser is automatically cleaned up when sandbox terminates

### Resource Limits
- **Navigation timeout**: 30 seconds (default)
- **Element timeout**: 10 seconds (default)
- **Screenshot max size**: 10MB
- **Browser memory**: Limited by sandbox container

### Security Features
- Browser runs in isolated Docker container
- Headless mode prevents display server requirements
- Timeout protection prevents resource exhaustion
- Browser instance destroyed with sandbox cleanup

---

## Best Practices

1. **Wait for Page Load** - Use `wait_until: networkidle` for pages with dynamic content
2. **Use Specific Selectors** - Prefer ID selectors (#id) or unique class names over generic selectors
3. **Handle Timeouts** - Set appropriate timeouts based on expected page load times
4. **Clear Inputs First** - Use `clear_first: true` when filling forms to avoid appending to existing values
5. **Check Element Visibility** - Ensure elements are visible before clicking (avoid `force: true` unless necessary)
6. **Use Full Page Screenshots** - Enable `full_page: true` when capturing content below the fold

---

## Troubleshooting

### Playwright Not Installed
**Cause**: Playwright or Chromium not installed in sandbox
**Solution**: Run `pip install playwright && playwright install chromium --with-deps`

### Element Not Found
**Cause**: Selector doesn't match any element, or element not yet loaded
**Solution**:
- Verify selector is correct
- Increase timeout
- Wait for page to fully load before interacting

### Navigation Timeout
**Cause**: Page takes too long to load
**Solution**:
- Increase timeout_seconds
- Use `wait_until: domcontentloaded` for faster waiting
- Check if the URL is accessible

### Screenshot Too Large
**Cause**: Full page screenshot exceeds 10MB limit
**Solution**:
- Use viewport-only screenshot (disable full_page)
- Use JPEG format with lower quality
- Screenshot specific elements instead

### Click Not Working
**Cause**: Element is hidden, overlapped, or not clickable
**Solution**:
- Use `force: true` to force click
- Scroll element into view first
- Wait for any overlays to disappear

---

## Technical Support

When troubleshooting browser automation issues:
- Check Playwright installation status
- Verify selector syntax
- Review page structure for dynamic content
- Check network connectivity for target URLs
