---
sidebar_position: 4
---

# Container Image Tags

Wegent separates stable release images from main branch snapshot images. Regular users and production deployments should use stable tags; maintainers, contributors, and test environments can use main branch snapshot tags to validate the latest merged changes.

## Tag Semantics

| Tag | Type | Updated By | Recommended Use |
|-----|------|------------|-----------------|
| `latest` | Mutable stable tag | Release workflow | Quick deployment for regular users and non-strict production environments |
| `1.2.3` | Version tag | Release workflow | Production deployments, reproducible deployments, rollback |
| `main` | Mutable snapshot tag | Snapshot workflow after main merges | Internal testing and contributor validation |
| `edge` | Mutable snapshot tag | Snapshot workflow after main merges | Same as `main`, for users familiar with edge channels |
| `main-<short-sha>` | Commit-scoped snapshot tag | Snapshot workflow after main merges | Reproducing a specific main build, debugging, rollback |
| `main-<short-sha>-amd64` / `main-<short-sha>-arm64` | Architecture tag | Internal snapshot workflow tag | Used to assemble multi-arch manifests; direct deployment is not recommended |

`latest` means the latest stable release, not the latest commit on main. `main` and `edge` may contain changes that have not been released yet, so only use them where unstable updates are acceptable.

## Snapshot Images

Every merge to `main` triggers the `Snapshot Image` workflow, which builds these images:

```text
ghcr.io/wecode-ai/wegent-backend
ghcr.io/wecode-ai/wegent-web
ghcr.io/wecode-ai/wegent-executor
ghcr.io/wecode-ai/wegent-executor-manager
ghcr.io/wecode-ai/wegent-chat-shell
ghcr.io/wecode-ai/wegent-knowledge-runtime
ghcr.io/wecode-ai/wegent-knowledge-doc-converter
ghcr.io/wecode-ai/wegent-standalone
```

The workflow first pushes commit-scoped `main-<short-sha>` multi-arch tags and verifies that the standalone image can start. Only after verification passes does it promote the same image set to the mutable `main` and `edge` tags.

## Examples

Use the latest stable release:

```bash
docker pull ghcr.io/wecode-ai/wegent-standalone:latest
```

Use the latest main branch snapshot:

```bash
docker pull ghcr.io/wecode-ai/wegent-standalone:edge
```

Reproduce a specific main build:

```bash
docker pull ghcr.io/wecode-ai/wegent-standalone:main-631609e5a123
```

When testing a standard multi-container deployment with a main snapshot, keep every Wegent service on the same snapshot tag to avoid cross-service version drift.
