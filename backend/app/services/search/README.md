# Web Search Service

This module provides web search integration for the chat system, supporting multiple search engines through a flexible configuration system.

## Configuration

### Multi-Engine Configuration (Recommended)

Set the `WEB_SEARCH_ENGINES` environment variable with a JSON configuration:

```bash
WEB_SEARCH_ENABLED=true
WEB_SEARCH_ENGINES='{
  "default": "google",
  "engines": {
    "google": {
      "base_url": "https://api.example.com/google/search",
      "query_param": "q",
      "limit_param": "limit",
      "extra_params": {"format": "json"},
      "response_path": "results",
      "title_field": "title",
      "url_field": "url",
      "snippet_field": "snippet",
      "content_field": "content"
    },
    "bing": {
      "base_url": "https://api.example.com/bing/search",
      "query_param": "q",
      "limit_param": "count",
      "extra_params": {"format": "json"},
      "response_path": "webPages.value",
      "title_field": "name",
      "url_field": "url",
      "snippet_field": "snippet",
      "content_field": "snippet"
    },
    "duckduckgo": {
      "base_url": "https://api.duckduckgo.com/",
      "query_param": "q",
      "limit_param": "max_results",
      "extra_params": {"format": "json"},
      "response_path": "RelatedTopics",
      "title_field": "Text",
      "url_field": "FirstURL",
      "snippet_field": "Text",
      "content_field": "Text"
    }
  }
}'
```

## Configuration Fields

- `base_url`: API endpoint URL (required)
- `max_results`: Maximum results per request (default: 10)
- `query_param`: Query string parameter name (default: "q")
- `limit_param`: Results limit parameter name (default: "limit")
- `auth_header`: Authentication headers (e.g., `{"Authorization": "Bearer token"}`)
- `extra_params`: Additional query parameters for every request
- `response_path`: JSONPath to results array (e.g., "data.results", null for root)
- `title_field`: Field name for result title (default: "title")
- `url_field`: Field name for result URL (default: "url")
- `snippet_field`: Field name for result snippet (default: "snippet")
- `content_field`: Field name for result content (default: "main_content")
- `timeout`: Request timeout in seconds (default: 10)

## Usage

### In Chat Service

The search engine is automatically selected based on the user's choice in the frontend:

```python
from app.services.search import get_search_service

# Get search service for specific engine
search_service = get_search_service(engine_name="google")

# Get default search service
search_service = get_search_service()

# Perform search
results = await search_service.search("query", limit=5)
```

### Frontend Integration

Users can select their preferred search engine from the dropdown menu when web search is enabled. The selected engine is passed to the backend via the `search_engine` parameter in the chat request.

## Supported Search Engines

The system supports any HTTP-based search API that returns JSON responses. Common examples:

- **Google Custom Search API**
- **Bing Web Search API**
- **DuckDuckGo API**
- **SearXNG** (self-hosted)
- **Custom search APIs**

## Adding New Search Engines

To add a new search engine:

1. Add the engine configuration to `WEB_SEARCH_ENGINES` JSON
2. Specify the correct API endpoint and field mappings

Example:

```bash
# Backend (.env)
WEB_SEARCH_ENGINES='{
  "default": "google",
  "engines": {
    "google": {...},
    "custom": {
      "base_url": "https://your-api.com/search",
      "query_param": "q",
      "response_path": "data.items",
      "title_field": "heading",
      "url_field": "link",
      "snippet_field": "description"
    }
  }
}'
```
