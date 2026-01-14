---
description: "Use this skill to search Weibo posts, search users, read user timelines, query specific posts, batch query posts, and convert Weibo mid formats. This skill enables interaction with Weibo data through MCP (Model Context Protocol) servers."
displayName: "微博集成"
version: "1.0.0"
author: "Wegent Team"
tags: ["weibo", "social-media", "search", "data-analysis"]
bindShells: ["Chat"]
mcpServers:
  - weiboServer
---

# Weibo Integration Skill

This skill provides comprehensive Weibo data access capabilities through MCP (Model Context Protocol) servers. You can search posts, query user information, read timelines, and analyze Weibo content.

## Prerequisites

**IMPORTANT**: Before using this skill, the user must configure a Weibo MCP server in their Ghost specification with valid authentication credentials.

### Example Ghost Configuration

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: weibo-analyst-ghost
  namespace: default
spec:
  systemPrompt: "You are a Weibo data analyst..."
  skills:
    - weibo
  mcpServers:
    weiboServer:
      type: streamable-http
      transport: streamable_http
      url: https://weibo-api.example.com
      headers:
        Authorization: Bearer ${{user.weibo_token}}
        X-User-ID: ${{user.id}}
```

### Variable Substitution

The MCP server configuration supports variable substitution using `${{path}}` syntax:

- `${{user.weibo_token}}` - User's Weibo API token
- `${{user.id}}` - User ID
- `${{user.name}}` - Username
- `${{user.git_login}}` - Git login name
- Any nested path in task data (e.g., `${{workspace.repo_name}}`)

## Available MCP Tools

When this skill is loaded and a Weibo MCP server is configured, the following tools become available:

### 1. getUserTimeline

Query a user's published Weibo posts with pagination and filtering support.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | Either uid or screen_name | User ID (numeric) |
| `screen_name` | string | Either uid or screen_name | User's screen name (username) |
| `count` | integer | No | Number of posts to return (default: 20, max: 25) |
| `since_id` | string | No | Return posts with IDs greater than this value |
| `max_id` | string | No | Return posts with IDs less than or equal to this value |
| `start_time` | string | No | Start timestamp (Unix timestamp) |
| `end_time` | string | No | End timestamp (Unix timestamp) |
| `page` | integer | No | Page number (default: 1) |
| `feature` | integer | No | Filter type: 0=all, 1=original posts, 2=images, 3=videos, 4=music |

**Example:**

```json
{
  "name": "getUserTimeline",
  "arguments": {
    "screen_name": "techblogger",
    "count": 20,
    "feature": 1
  }
}
```

**Response:**

Returns a list of Weibo posts with full content, metadata, user information, and engagement metrics.

---

### 2. getStatus

Query the content of a specific Weibo post by its ID.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Weibo post ID (numeric or base62) |

**Example:**

```json
{
  "name": "getStatus",
  "arguments": {
    "id": "4567890123456789"
  }
}
```

**Response:**

Returns the complete Weibo post including text, images, videos, comments count, likes, reposts, and author information.

---

### 3. convertMid

Convert Weibo base62 mid format to numeric mid format.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mid` | string | Yes | The mid to convert |
| `type` | integer | No | Type: 1=Weibo post (default), 2=comment, 3=direct message |
| `isBase62` | integer | No | 1=input is base62 (default), 0=input is numeric |

**Example:**

```json
{
  "name": "convertMid",
  "arguments": {
    "mid": "Mxj8aQPqL",
    "type": 1,
    "isBase62": 1
  }
}
```

**Response:**

Returns the converted mid in the target format.

---

### 4. getStatusShowBatch

Batch query multiple Weibo posts (up to 50 IDs per request).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | string | Yes | Comma-separated Weibo post IDs (max 50) |

**Example:**

```json
{
  "name": "getStatusShowBatch",
  "arguments": {
    "ids": "4567890123456789,4567890123456790,4567890123456791"
  }
}
```

**Response:**

Returns an array of Weibo posts matching the provided IDs.

---

### 5. getUserInfo

Get basic user information by user ID or screen name.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | Either uid or screen_name | User ID (numeric) |
| `screen_name` | string | Either uid or screen_name | User's screen name (username) |

**Example:**

```json
{
  "name": "getUserInfo",
  "arguments": {
    "screen_name": "techblogger"
  }
}
```

**Response:**

Returns user profile including display name, bio, follower count, following count, verified status, and profile image.

---

## Usage Workflow

### 1. Search for a User

First, get the user's information to obtain their `uid`:

```
LLM calls getUserInfo(screen_name="techblogger")
→ Returns: {"uid": "123456", "screen_name": "techblogger", ...}
```

### 2. Read User's Timeline

Once you have the `uid`, fetch their recent posts:

```
LLM calls getUserTimeline(uid="123456", count=20, feature=1)
→ Returns: Array of 20 original Weibo posts from this user
```

### 3. Query Specific Post Details

If you need detailed information about a specific post:

```
LLM calls getStatus(id="4567890123456789")
→ Returns: Complete post with text, media, engagement metrics
```

### 4. Batch Query Multiple Posts

For efficiency when querying multiple posts:

```
LLM calls getStatusShowBatch(ids="4567890123456789,4567890123456790,4567890123456791")
→ Returns: Array of posts
```

### 5. Convert Mid Formats

If you encounter a base62 mid and need numeric format:

```
LLM calls convertMid(mid="Mxj8aQPqL", type=1, isBase62=1)
→ Returns: {"mid": "4567890123456789"}
```

---

## Best Practices

### 1. Pagination

When fetching large amounts of data, use pagination:

```
# Page 1
getUserTimeline(screen_name="user", count=25, page=1)

# Page 2
getUserTimeline(screen_name="user", count=25, page=2)

# Or use since_id/max_id for cursor-based pagination
getUserTimeline(screen_name="user", count=25, max_id="previous_oldest_id")
```

### 2. Filtering Posts

Use the `feature` parameter to filter content types:

- `feature=0`: All posts (default)
- `feature=1`: Original posts only (no retweets)
- `feature=2`: Posts with images
- `feature=3`: Posts with videos
- `feature=4`: Posts with music

### 3. Batch Processing

When querying multiple specific posts, always use `getStatusShowBatch` instead of multiple `getStatus` calls:

```
# ✅ Good - One batch call
getStatusShowBatch(ids="id1,id2,id3")

# ❌ Bad - Multiple individual calls
getStatus(id="id1")
getStatus(id="id2")
getStatus(id="id3")
```

### 4. Time Range Filtering

Use `start_time` and `end_time` for temporal analysis:

```
getUserTimeline(
  screen_name="user",
  start_time="1640995200",  # 2022-01-01 00:00:00
  end_time="1672531199"     # 2022-12-31 23:59:59
)
```

---

## Error Handling

### Common Errors and Solutions

#### 1. MCP Server Not Configured

**Error**: `"Error: Skill 'weibo' is configured but MCP server 'weiboServer' is not available."`

**Solution**: The user needs to add the Weibo MCP server configuration to their Ghost's `mcpServers` field.

#### 2. Authentication Failed

**Error**: `"Weibo MCP server error: 401 Unauthorized"`

**Solution**: The user's Weibo API token is invalid or expired. They need to update `${{user.weibo_token}}` in their configuration.

#### 3. Rate Limiting

**Error**: `"Weibo MCP server error: 429 Too Many Requests"`

**Solution**: Wait before making additional requests. Implement exponential backoff or reduce request frequency.

#### 4. User Not Found

**Error**: `"User not found"`

**Solution**: Verify the `screen_name` or `uid` is correct. The user may have changed their username or deactivated their account.

#### 5. Invalid Post ID

**Error**: `"Post not found" or "Invalid ID"`

**Solution**: Check that the post ID is correct and the post still exists (it may have been deleted).

---

## Response Format Examples

### getUserTimeline Response

```json
{
  "statuses": [
    {
      "id": "4567890123456789",
      "mid": "Mxj8aQPqL",
      "text": "Just published a new blog post about...",
      "source": "Weibo Web",
      "created_at": "Mon Jan 15 08:30:00 +0800 2024",
      "user": {
        "id": "123456",
        "screen_name": "techblogger",
        "name": "Tech Blogger",
        "verified": true,
        "followers_count": 50000
      },
      "reposts_count": 120,
      "comments_count": 45,
      "attitudes_count": 890,
      "pic_urls": [
        {"thumbnail_pic": "https://..."}
      ]
    }
  ],
  "total_number": 1234
}
```

### getUserInfo Response

```json
{
  "id": "123456",
  "screen_name": "techblogger",
  "name": "Tech Blogger",
  "description": "Technology enthusiast | Software engineer",
  "verified": true,
  "verified_reason": "Tech blogger",
  "followers_count": 50000,
  "friends_count": 500,
  "statuses_count": 2345,
  "created_at": "Wed Jan 01 00:00:00 +0800 2020",
  "profile_image_url": "https://...",
  "cover_image_phone": "https://..."
}
```

---

## Example Use Cases

### Use Case 1: Analyze User's Recent Activity

```
Step 1: Get user info
getUserInfo(screen_name="analyst_user")

Step 2: Fetch recent posts
getUserTimeline(uid="<user_id>", count=25, feature=0)

Step 3: Analyze content themes, posting frequency, engagement rates
```

### Use Case 2: Track Hot Topics

```
Step 1: Monitor multiple influential users' timelines
getUserTimeline(screen_name="user1", count=20)
getUserTimeline(screen_name="user2", count=20)

Step 2: Extract trending keywords and hashtags

Step 3: Batch query related posts for deeper analysis
```

### Use Case 3: Content Aggregation

```
Step 1: Collect post IDs from multiple sources

Step 2: Batch query all posts
getStatusShowBatch(ids="id1,id2,id3,...")

Step 3: Process and format content for reporting
```

---

## Limitations

1. **Rate Limits**: Weibo API has rate limits per user/token. Monitor your usage to avoid throttling.
2. **Data Freshness**: Cached data may be up to a few minutes old depending on the MCP server implementation.
3. **Batch Size**: Maximum 50 IDs per `getStatusShowBatch` call.
4. **Timeline Limit**: `getUserTimeline` returns a maximum of 25 posts per request.
5. **Historical Data**: Very old posts may not be accessible through the API.

---

## Troubleshooting

### Issue: No tools available after loading skill

**Diagnosis**: The MCP server is not properly configured or connected.

**Solution**:
1. Verify Ghost's `mcpServers` contains the `weiboServer` configuration
2. Check that the MCP server URL is correct and accessible
3. Verify authentication credentials are valid
4. Check backend logs for MCP connection errors

### Issue: Tools return empty results

**Diagnosis**: The query parameters may be incorrect or the data doesn't exist.

**Solution**:
1. Verify user IDs and screen names are correct
2. Try removing optional filters (feature, time range)
3. Check if the user has public posts (some accounts are private)

### Issue: Inconsistent mid formats

**Diagnosis**: Weibo uses both numeric and base62 mid formats.

**Solution**:
1. Use `convertMid` to normalize formats before making queries
2. Store both formats if available for flexibility

---

## Related Skills

- **mermaid-diagram**: Visualize Weibo data trends with diagrams
- **web-search**: Supplement Weibo data with web searches

---

## Security Notes

1. **Token Security**: Never expose Weibo API tokens in logs or responses. Always use variable substitution (`${{user.weibo_token}}`) in configurations.
2. **User Privacy**: Respect user privacy when accessing and sharing Weibo data. Only query public information.
3. **Rate Limiting**: Implement proper rate limiting to avoid API abuse.
4. **Data Retention**: Follow data retention policies for any cached Weibo content.

---

## Support

For issues with:
- **Skill functionality**: Contact Wegent support
- **MCP server configuration**: Check Wegent documentation on Ghost and MCP servers
- **Weibo API limitations**: Refer to Weibo API official documentation
