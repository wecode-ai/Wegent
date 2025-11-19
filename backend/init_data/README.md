# YAML Initialization

## Overview

This directory contains YAML configuration files for initializing the Wegent system. These files replace the previous SQL-based initialization approach (`init.sql`).

## Files

- **`default_user.yaml`**: Default admin user configuration
- **`default_resources.yaml`**: Default resources including Ghost, Model, Shell, Bot, and Team configurations
- **`public_shells.yaml`**: Public shell configurations (ClaudeCode, Agno)

## Default User

The default admin user is configured in `default_user.yaml`:

- **Username**: `admin`
- **Password**: `Wegent2025!`
- **Email**: `admin@example.com`

**⚠️ Important**: Change the default password after first login for security.

## YAML Format

All resource files follow the Kubernetes-like resource format:

```yaml
apiVersion: agent.wecode.io/v1
kind: <ResourceType>
metadata:
  name: <resource-name>
  namespace: <namespace>
  user_id: <user-id>  # Only for user-owned resources
spec:
  # Resource-specific configuration
status:
  state: Available
```

### Supported Resource Types

- **Ghost**: AI agent personality and system prompts
- **Model**: LLM model configurations
- **Shell**: Execution environment configurations
- **Bot**: Combines Ghost, Model, and Shell
- **Team**: Collections of Bots with collaboration models

## How It Works

1. **Startup**: When the backend starts, it automatically loads YAML files from this directory
2. **Idempotent**: Resources are only created if they don't already exist (checked by user_id, kind, name, namespace)
3. **Order**: User is created first, then resources, then public shells

## Customization

### Adding Custom Resources

Create a new YAML file or add to existing files using the `---` separator for multiple documents:

```yaml
---
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: my-custom-ghost
  namespace: default
  user_id: 1
spec:
  systemPrompt: |
    Your custom system prompt here
  mcpServers: {}
status:
  state: Available
---
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: my-custom-model
  namespace: default
  user_id: 1
spec:
  modelConfig:
    env:
      ANTHROPIC_MODEL: claude-3-sonnet
      ANTHROPIC_API_KEY: your-api-key
status:
  state: Available
```

### Modifying Existing Resources

Edit the YAML files directly. Changes take effect on next container restart (for new installations only - existing resources won't be updated).

## Docker Integration

The `docker-compose.yml` mounts this directory as read-only:

```yaml
volumes:
  - ./backend/init_data:/app/init_data:ro
```

## Migration from SQL

The previous `init.sql` file has been deprecated. All initialization now happens through YAML files:

| SQL Table | YAML Resource |
|-----------|---------------|
| `users` table | `default_user.yaml` |
| `kinds` table | `default_resources.yaml` |
| `public_shells` table | `public_shells.yaml` |
| `public_models` table | Can be added to new YAML file |

## Advantages

✅ **Human-readable**: YAML is easier to read and edit than SQL
✅ **Version control friendly**: Better diff support
✅ **Declarative**: Describe what you want, not how to create it
✅ **Idempotent**: Safe to run multiple times
✅ **Extensible**: Easy to add custom resources
✅ **Kubernetes-aligned**: Familiar format for cloud-native developers

## Troubleshooting

### Resources Not Created

Check backend logs for initialization errors:

```bash
docker-compose logs backend | grep -i "yaml\|initialization"
```

### Syntax Errors

Validate YAML syntax:

```bash
python -c "import yaml; yaml.safe_load(open('default_resources.yaml'))"
```

### Existing Resources

The initialization is idempotent. If resources already exist with the same `(user_id, kind, name, namespace)`, they won't be recreated or modified.

## Development

To test YAML initialization locally:

```python
from app.db.session import SessionLocal
from app.core.yaml_init import run_yaml_initialization

db = SessionLocal()
try:
    run_yaml_initialization(db)
finally:
    db.close()
```
