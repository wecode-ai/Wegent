# Web Search Service Configuration

This document describes how to configure the generic HTTP-based web search service to work with different search engines.

## Architecture

The web search service uses a generic HTTP adapter that can be configured to work with any RESTful search API through environment variables. No search engine-specific code is included in the codebase.

## Configuration

### Environment Variables

- `WEB_SEARCH_ENABLED`: Enable/disable web search feature (default: `False`)
- `WEB_SEARCH_BASE_URL`: Search API endpoint URL (required when enabled)
- `WEB_SEARCH_CONFIG`: JSON string containing adapter configuration
- `WEB_SEARCH_MAX_RESULTS`: Default maximum search results (default: `5`)

### WEB_SEARCH_CONFIG Structure

```json
{
  "query_param": "q", // Query string parameter name
  "limit_param": "limit", // Results limit parameter name (null to disable)
  "auth_header": {
    // Optional authentication headers
    "Authorization": "Bearer YOUR_TOKEN"
  },
  "extra_params": {
    // Additional query parameters
    "format": "json",
    "lang": "en"
  },
  "response_path": "results", // JSONPath to results array (null for root)
  "title_field": "title", // Field name for result title
  "url_field": "url", // Field name for result URL
  "snippet_field": "snippet", // Field name for result description
  "content_field": "content", // Field name for main content
  "timeout": 10 // Request timeout in seconds
}
```

## Examples

### SearXNG (Self-hosted, DuckDuckGo-compatible)

```bash
WEB_SEARCH_ENABLED=True
WEB_SEARCH_BASE_URL=https://searx.example.com/search
WEB_SEARCH_CONFIG='{"query_param":"q","limit_param":"limit","extra_params":{"format":"json"},"response_path":"results","title_field":"title","url_field":"url","snippet_field":"content"}'
WEB_SEARCH_MAX_RESULTS=5
```

### Google Custom Search JSON API

```bash
WEB_SEARCH_ENABLED=True
WEB_SEARCH_BASE_URL=https://www.googleapis.com/customsearch/v1
WEB_SEARCH_CONFIG='{"query_param":"q","limit_param":"num","auth_header":{},"extra_params":{"key":"YOUR_API_KEY","cx":"YOUR_SEARCH_ENGINE_ID"},"response_path":"items","title_field":"title","url_field":"link","snippet_field":"snippet"}'
WEB_SEARCH_MAX_RESULTS=5
```

### Bing Web Search API

```bash
WEB_SEARCH_ENABLED=True
WEB_SEARCH_BASE_URL=https://api.bing.microsoft.com/v7.0/search
WEB_SEARCH_CONFIG='{"query_param":"q","limit_param":"count","auth_header":{"Ocp-Apim-Subscription-Key":"YOUR_API_KEY"},"extra_params":{},"response_path":"webPages.value","title_field":"name","url_field":"url","snippet_field":"snippet"}'
WEB_SEARCH_MAX_RESULTS=5
```

### Brave Search API

```bash
WEB_SEARCH_ENABLED=True
WEB_SEARCH_BASE_URL=https://api.search.brave.com/res/v1/web/search
WEB_SEARCH_CONFIG='{"query_param":"q","limit_param":"count","auth_header":{"X-Subscription-Token":"YOUR_API_KEY"},"extra_params":{},"response_path":"web.results","title_field":"title","url_field":"url","snippet_field":"description"}'
WEB_SEARCH_MAX_RESULTS=5
```

### DuckDuckGo (via SearXNG or similar proxy)

Since DuckDuckGo doesn't provide a direct API, you can use SearXNG configured with DuckDuckGo as the backend:

```bash
WEB_SEARCH_ENABLED=True
WEB_SEARCH_BASE_URL=https://searx.example.com/search
WEB_SEARCH_CONFIG='{"query_param":"q","limit_param":"limit","extra_params":{"format":"json","engines":"duckduckgo"},"response_path":"results","title_field":"title","url_field":"url","snippet_field":"content"}'
WEB_SEARCH_MAX_RESULTS=5
```

## How It Works

1. **User enables web search** via the Globe icon toggle in the chat interface
2. **Request sent** with `enable_web_search: true` parameter
3. **Backend performs search**:
   - Builds HTTP request using configured parameters
   - Sends request to `WEB_SEARCH_BASE_URL`
   - Parses response using `response_path`
   - Extracts fields using configured field names
4. **Results formatted** as readable text
5. **Context prepended** to user message before sending to LLM

## Security Notes

- **Never commit API keys** to version control
- **Use environment variables** for sensitive data
- **Consider rate limiting** when using public APIs
- **Self-hosted options** (like SearXNG) provide better privacy

## Testing

To test your configuration:

1. Enable web search in your environment
2. Start a chat with a Chat Shell team
3. Click the Globe icon to enable search
4. Send a query like "latest news about AI"
5. Check backend logs for search results
6. Verify the LLM response uses the search context

## Troubleshooting

- **"WEB_SEARCH_BASE_URL is required"**: Set the base URL in your environment
- **"Search API returned error: 401"**: Check your API key in `auth_header`
- **"Search API returned error: 429"**: Rate limited, reduce request frequency
- **No results**: Check `response_path` matches your API's JSON structure
- **Wrong content**: Verify field names (`title_field`, `url_field`, `snippet_field`)
