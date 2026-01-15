# YAML Initialization

## Overview

This directory contains YAML configuration files for initializing the Wegent system. The system automatically scans this directory on startup and applies all YAML resources using the batch service API.

**Note**: This directory is **built into the Docker image** by default. Users can deploy Wegent with just the `docker-compose.yml` file - no local code repository required.

## How It Works

1. **Auto-scan**: On startup, the backend scans `INIT_DATA_DIR` (default: `/app/init_data`) for all `.yaml` and `.yml` files
2. **Auto-apply**: All resources are loaded and checked against the database
3. **Create-only**: Resources are **only created if they don't exist** - existing resources are **skipped**
4. **User modifications preserved**: Any changes made through the UI/API are **never overwritten** on restart
5. **Order**: Files are processed in alphabetical order (use numeric prefixes for ordering)

### ⚠️ Important: Non-Destructive Initialization

**The initialization is create-only, NOT create-or-update.**

- ✅ First startup: Creates all resources from YAML files
- ✅ User modifies a resource (e.g., edits a Ghost's system prompt)
- ✅ Service restart: **User's modifications are preserved** - YAML file is ignored for that resource
- ❌ YAML changes after first startup: **Not applied to existing resources**

This design ensures:
- User customizations are never lost
- Safe to restart services without data loss
- YAML files serve as initial templates only

If you want to update an existing resource to match YAML:
1. Delete the resource through the UI/API
2. Restart the service (it will be recreated from YAML)
3. Or manually update it through the UI/API

## Configuration

### Environment Variables

```bash
# Enable/disable YAML initialization (default: True)
INIT_DATA_ENABLED=True

# Directory to scan for YAML files (default: /app/init_data)
INIT_DATA_DIR=/app/init_data
```

### Default Admin User

The system automatically creates a default admin user if it doesn't exist:

- **Username**: `admin`
- **Password**: `Wegent2025!`
- **Email**: `admin@example.com`

**⚠️ IMPORTANT**: Change the default password after first login!

## YAML Format

All resources follow the Kubernetes-like format:

```yaml
---
apiVersion: agent.wecode.io/v1
kind: <ResourceType>
metadata:
  name: <resource-name>
  namespace: <namespace>
  user_id: <user-id>  # Optional, defaults to admin user
spec:
  # Resource-specific configuration
status:
  state: Available
```

### Supported Resource Types

- `Ghost` - AI agent personalities and system prompts
- `Model` - LLM model configurations
- `Shell` - Execution environment configurations
- `Bot` - Combines Ghost + Model + Shell
- `Team` - Collections of Bots
- `Workspace` - Git repository configurations
- `Task` - Task definitions

## File Organization

Files are processed in alphabetical order. Use numeric prefixes to control load order:

```
init_data/
├── 01-default-resources.yaml  # Core resources (Ghost, Model, Shell, Bot, Team)
├── 02-public-shells.yaml      # Public shell configurations
└── README.md
```

## Example: Adding Custom Resources

Create a new YAML file (e.g., `03-custom-bots.yaml`):

```yaml
---
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: code-reviewer-ghost
  namespace: default
spec:
  systemPrompt: |
    You are an expert code reviewer...
  mcpServers: {}
status:
  state: Available
---
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: code-reviewer-bot
  namespace: default
spec:
  ghostRef:
    name: code-reviewer-ghost
    namespace: default
  modelRef:
    name: claude-model
    namespace: default
  shellRef:
    name: claude-shell
    namespace: default
status:
  state: Available
```

## Docker Integration

### Self-Contained Deployment

The `init_data` directory is **built into the Docker image**, allowing users to deploy Wegent with just the `docker-compose.yml` file:

```bash
# Download docker-compose.yml and start Wegent
curl -O https://raw.githubusercontent.com/wecode-ai/Wegent/main/docker-compose.yml
docker-compose up -d
```

No local code repository is required - the image contains all default resources and skills.

### Customizing Init Data

To override the built-in init data with your own configuration:

1. Create a custom directory with your YAML files:
   ```bash
   mkdir custom_init_data
   cp my-custom-resources.yaml custom_init_data/
   ```

2. Uncomment and modify the volume mount in `docker-compose.yml`:
   ```yaml
   backend:
     volumes:
       - ./custom_init_data:/app/init_data:ro
   ```

3. Restart the backend container:
   ```bash
   docker-compose restart backend
   ```

### Environment Variables

Control initialization behavior with these environment variables:

```yaml
environment:
  INIT_DATA_ENABLED: "True"   # Enable/disable initialization
  INIT_DATA_DIR: /app/init_data  # Directory path (default)
```

## Advantages

✅ **Declarative**: Describe what you want, not SQL commands
✅ **Human-readable**: YAML is easier to read and edit
✅ **Version control friendly**: Better diffs and merge resolution
✅ **Create-only**: Never overwrites user modifications on restart
✅ **Safe restarts**: No risk of losing customizations
✅ **Reuses existing APIs**: Uses the same `kind_service` as the REST API
✅ **Extensible**: Easy to add new resources without code changes
✅ **No database schema coupling**: Works with any resource type

## Troubleshooting

### Check Initialization Logs

```bash
docker-compose logs backend | grep -i "yaml\|initialization"
```

### Validate YAML Syntax

```bash
python -c "import yaml; print(yaml.safe_load_all(open('01-default-resources.yaml')))"
```

### Disable Initialization

Set environment variable:

```bash
INIT_DATA_ENABLED=False
```

### Common Issues

**Issue**: Resources not created
- Check logs for errors
- Verify YAML syntax is valid
- Ensure `metadata.name` and `metadata.namespace` are set

**Issue**: Resources duplicated
- Resources are identified by `(user_id, kind, name, namespace)`
- Check if any of these fields differ from existing resources

**Issue**: Directory not found
- Ensure `INIT_DATA_DIR` path exists
- Check volume mount in `docker-compose.yml`

## Development

### Testing Locally

```python
from app.db.session import SessionLocal
from app.core.yaml_init import run_yaml_initialization

db = SessionLocal()
try:
    result = run_yaml_initialization(db)
    print(result)
finally:
    db.close()
```

### Adding New Resource Types

1. Ensure the resource `kind` is supported in `batch_service.supported_kinds`
2. Add YAML documents to any `.yaml` file in the init directory
3. Restart the backend

No code changes needed - the system automatically handles any supported resource type!
