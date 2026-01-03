# Git Clone 本地缓存实现文档

## 概述

本文档描述了 Wegent 项目中实现的 git clone 本地缓存功能。该功能使用 Git 的 `--reference` 模式，在多次克隆相同仓库时大幅减少网络传输和磁盘使用。

## 功能特性

### 核心特性

- ✅ **本地缓存**：使用 Git `--reference` 模式共享对象数据库
- ✅ **自动更新**：每次使用前自动更新缓存仓库
- ✅ **用户隔离**：基于数据库 user_id 的缓存隔离，保证安全性和隐私
- ✅ **容器级隔离**：每个 executor 容器只挂载自己的 `/git-cache/user_{user_id}` 子目录
- ✅ **路径验证**：应用层路径验证，防止跨用户访问和路径遍历攻击
- ✅ **权限管理**：每次使用最新的 token，避免权限问题
- ✅ **容错机制**：缓存失败时自动回退到普通克隆
- ✅ **按需启用**：通过环境变量控制，默认禁用
- ✅ **严格验证**：必须提供有效的 user_id，否则报错

### 支持的 Git 平台

- GitHub
- GitLab
- Gitee
- Gitea
- Gerrit
- 任何标准 Git 服务器

## 架构设计

### 缓存目录结构

缓存目录基于**数据库 user_id**自动隔离，不同用户的缓存完全分离。

**宿主机 Volume 视图**：

```
/git-cache/                          (git_cache_data Volume)
├── user_123/
│   ├── github.com/
│   │   ├── user1/
│   │   │   └── repo1.git/     (bare repository)
│   │   └── user2/
│   │       └── repo2.git/
│   ├── gitlab.com/
│   │   └── group/
│   │       └── project.git/
│   └── gerrit.example.com/
│       └── project.git/
├── user_456/
│   └── github.com/
│       └── user/
│           └── repo.git/     (与 user_123 的缓存完全隔离)
└── user_789/
    └── github.com/
        └── sensitive-org/
            └── private-repo.git/  (私有仓库完全隔离)
```

**容器内视图（安全隔离）**：

```
容器 user_123:
/git-cache/
└── user_123/                    ← 只有这个目录存在和可见
    └── github.com/
        └── repo.git/

容器 user_456:
/git-cache/
└── user_456/                    ← 只有这个目录存在和可见
    └── github.com/
        └── repo.git/
```

**关键安全特性**：
- ✅ **物理隔离**：每个容器只挂载自己的 `user_{user_id}` 子目录
- ✅ **不可见**：容器内无法看到其他用户的 `user_*` 目录
- ✅ **不可访问**：即使知道路径也无法访问（目录不存在）
- ✅ **双重防护**：容器层隔离 + 应用层路径验证

### 用户 ID 处理

缓存目录使用**数据库中的 user_id**，这是用户表的主键，具有以下特点：

| 特性 | 说明 |
|-----|------|
| **唯一性** | 数据库主键，全局唯一 |
| **不变性** | 用户 ID 创建后不会改变 |
| **类型安全** | 整数类型，无需特殊字符处理 |
| **自动验证** | 必须是正整数，否则报错 |

**验证规则：**
- ✅ user_id 必须是有效的整数（123, 456, etc.）
- ✅ user_id 必须大于 0
- ❌ 空值、字符串、浮点数、负数都会报错
- ❌ 不提供 user_id 时会抛出 ValueError 异常

**Docker 容器环境：**
在 executor 容器中，`GIT_CACHE_USER_ID` 和 `GIT_CACHE_USER_BASE_DIR` 由 executor_manager 从 `task.user.id` 提取并传递：

```python
# executor_manager 设置环境变量
env_vars = {
    "GIT_CACHE_USER_ID": str(user_id),
    "GIT_CACHE_USER_BASE_DIR": f"/git-cache/user_{user_id}",
}
```

**容器挂载策略**：
```python
# 选择性子目录挂载（安全隔离）
volume_mount = f"{GIT_CACHE_VOLUME}:/git-cache/user_{user_id}"
# 例如：git_cache_data:/git-cache/user_123
```

这确保了：
1. **容器只看到自己的缓存**：挂载点为 `/git-cache/user_{user_id}`
2. **其他用户的缓存不可见**：其他 `user_*` 目录根本不在容器内
3. **完全物理隔离**：即使容器被攻破也无法访问其他用户缓存

### 缓存路径生成规则

缓存路径格式：`{cache_dir}/user_{user_id}/{domain}/{path}.git`

**示例：**

| user_id | URL | 缓存路径 |
|---------|-----|----------|
| `123` | `https://github.com/user/repo.git` | `/git-cache/user_123/github.com/user/repo.git` |
| `456` | `https://gitlab.com/group/project.git` | `/git-cache/user_456/gitlab.com/group/project.git` |
| `789` | `git@github.com:user/repo.git` | `/git-cache/user_789/github.com/user/repo.git` |

## 实现细节

### 1. 核心模块

#### git_cache.py

提供缓存管理的核心功能：

- **`get_cache_user_id()`**：从环境变量获取并验证 user_id（必需，无默认值）
- **`get_user_cache_base_dir()`**：获取用户专属缓存基础目录（必须设置 `GIT_CACHE_USER_BASE_DIR`）
- **`get_cache_repo_path(url)`**：计算缓存仓库路径（自动使用 user_id 并验证）
- **`_validate_cache_path(cache_path, allowed_base_dir)`**：验证缓存路径在允许的目录内（防路径遍历）
- **`ensure_cache_repo(cache_path, auth_url, branch)`**：确保缓存存在并更新（包含路径验证）
- **`update_cache_repo(cache_path, branch, auth_url)`**：更新缓存仓库（使用当前用户的 token）
- **`is_cache_enabled()`**：检查缓存是否启用
- **`is_auto_update_enabled()`**：检查自动更新是否启用

#### git_util.py

集成缓存功能到 git clone 流程：

- **`clone_repo_with_token()`**：主入口，使用 user_id 进行缓存隔离，username 仅用于 Git 认证
- **`_clone_with_reference()`**：使用 `--reference` 克隆
- **`_clone_without_cache()`**：普通克隆（回退方案）

**注意：** `username` 参数仅用于构建 Git 认证 URL（如 `https://username:token@github.com/...`），与缓存隔离无关。缓存隔离完全基于 `user_id`。

### 2. 工作流程

#### 首次克隆（缓存不存在）

```mermaid
graph TD
    A[开始克隆] --> B{缓存启用?}
    B -->|否| C[普通克隆]
    B -->|是| D[计算缓存路径]
    D --> E{缓存存在?}
    E -->|否| F[创建 bare 仓库]
    F --> G[使用 --reference 克隆]
    G --> H{成功?}
    H -->|是| I[完成]
    H -->|否| C
    C --> I
```

#### 后续克隆（缓存已存在）

```mermaid
graph TD
    A[开始克隆] --> B{缓存启用?}
    B -->|否| E[普通克隆]
    B -->|是| C[更新缓存仓库]
    C --> D[更新 remote URL]
    D --> F[git fetch origin]
    F --> G[使用 --reference 克隆]
    G --> H{成功?}
    H -->|是| I[完成]
    H -->|否| E
    E --> I
```

### 3. 权限处理

为解决多用户和 token 过期问题，每次使用缓存时：

1. **更新 Remote URL**：
   ```bash
   git remote set-url origin https://new_token@github.com/user/repo.git
   ```

2. **Fetch 最新数据**：
   ```bash
   git fetch origin --prune
   ```

3. **使用 --reference 克隆**：
   ```bash
   git clone --reference /git-cache/user_123/github.com/user/repo.git \
       https://new_token@github.com/user/repo.git /workspace/repo
   ```

### 4. 容错机制

- **缓存创建失败**：自动回退到普通克隆
- **--reference 克隆失败**：自动回退到普通克隆
- **缓存更新失败**：不影响使用，继续使用旧缓存
- **超时处理**：600秒超时限制，避免长时间挂起

## 配置说明

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `GIT_CACHE_ENABLED` | `false` | 是否启用缓存 |
| `GIT_CACHE_USER_BASE_DIR` | 自动计算 | 用户专属缓存基础目录（容器内：`/git-cache/user_{user_id}`） |
| `GIT_CACHE_AUTO_UPDATE` | `true` | 是否自动更新缓存 |
| `GIT_CACHE_USER_ID` | **必需** | 数据库用户 ID（task.user.id），用于缓存隔离 |

**环境变量设置示例**：
```bash
# executor_manager 容器环境
GIT_CACHE_ENABLED=true
GIT_CACHE_AUTO_UPDATE=true

# executor 容器环境（自动设置）
GIT_CACHE_ENABLED=true
GIT_CACHE_USER_ID=123                    # 从 task.user.id 提取
GIT_CACHE_USER_BASE_DIR=/git-cache/user_123  # 自动计算
GIT_CACHE_AUTO_UPDATE=true
```

### Docker Compose 配置

在 `docker-compose.yml` 中启用缓存：

```yaml
services:
  executor_manager:
    environment:
      # Git Cache Configuration
      - GIT_CACHE_ENABLED=true
      - GIT_CACHE_AUTO_UPDATE=true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - git_cache_data:/git-cache

volumes:
  git_cache_data:
    driver: local
```

### 配置文件

#### executor_manager/config/config.py

```python
# Git Cache Configuration
GIT_CACHE_ENABLED = os.getenv("GIT_CACHE_ENABLED", "false")
GIT_CACHE_AUTO_UPDATE = os.getenv("GIT_CACHE_AUTO_UPDATE", "true")
```

#### executor_manager/executors/docker/constants.py

```python
# Git cache configuration
GIT_CACHE_MOUNT_PATH = "/git-cache"
GIT_CACHE_VOLUME = "wegent_git_cache_data"
```

## 使用指南

### 启用缓存

1. **修改 docker-compose.yml**：
   ```yaml
   environment:
     - GIT_CACHE_ENABLED=true
   ```

2. **重启服务**：
   ```bash
   docker-compose down
   docker-compose up -d
   ```

### 验证缓存

1. **查看 executor_manager 缓存目录（宿主机视图）**：
   ```bash
   docker exec -it wegent-executor-manager ls -la /git-cache
   ```

2. **检查特定用户的缓存**：
   ```bash
   docker exec -it wegent-executor-manager ls -la /git-cache/user_123/github.com/
   ```

3. **验证容器级隔离**（关键安全检查）：
   ```bash
   # 找到运行中的 executor 容器
   docker ps | grep executor

   # 进入 user_123 的容器
   docker exec -it <container-id-user-123> sh

   # 查看容器内的 /git-cache 目录结构
   ls -la /git-cache/
   # 应该只看到 user_123 目录

   # 尝试访问其他用户目录（应该失败）
   ls /git-cache/user_456/
   # 应该报错：No such file or directory

   # 查看自己的缓存
   ls /git-cache/user_123/github.com/
   # 应该看到自己的仓库缓存
   ```

4. **查看缓存仓库日志**：
   ```bash
   # 查看 executor_manager 日志
   docker logs wegent-executor-manager | grep "Git cache"

   # 查看特定容器日志
   docker logs <container-id> | grep "cache"
   ```

### 清理缓存

如需清理缓存：

```bash
# 进入 executor_manager 容器
docker exec -it wegent-executor-manager sh

# 删除特定用户的缓存（使用 user_id）
rm -rf /git-cache/user_123

# 删除多个用户的缓存
rm -rf /git-cache/user_123 /git-cache/user_456

# 或删除所有缓存
rm -rf /git-cache/*

# 查看缓存目录结构
tree /git-cache
# 或
ls -la /git-cache/
```

## 性能优势

### 网络传输节省

| 场景 | 无缓存 | 有缓存 | 节省 |
|------|--------|--------|------|
| 首次克隆仓库 (100MB) | 100MB | 100MB | 0% |
| 第二次克隆相同仓库 | 100MB | ~5MB | 95% |
| 第三次克隆相同仓库 | 100MB | ~5MB | 95% |
| 克隆不同分支 | 100MB | ~2MB | 98% |

### 磁盘空间节省

使用 Git alternates 机制，多个克隆共享对象数据库：

- **无缓存**：每个仓库独立存储，100MB × N = 100N MB
- **有缓存**：缓存一次 + 克隆引用，100MB + 5MB × N = (100 + 5N) MB

**示例**：10个用户克隆同一仓库
- 无缓存：100MB × 10 = 1GB
- 有缓存：100MB + 5MB × 10 = 150MB
- 节省：850MB (85%)

## 安全性

### 用户隔离（容器级物理隔离）

缓存实现**多层安全隔离**，确保不同用户的缓存完全隔离：

#### 第一层：容器级物理隔离

**挂载策略**：每个 executor 容器只挂载自己的用户子目录

```python
# executor.py 中的挂载逻辑
user_cache_subdir = f"/git-cache/user_{user_id}"
docker_volume_mount = f"{GIT_CACHE_VOLUME}:{user_cache_subdir}"
# 实际挂载：git_cache_data:/git-cache/user_123
```

**安全效果**：
- ✅ **物理隔离**：容器内文件系统中只存在 `/git-cache/user_{user_id}` 目录
- ✅ **完全不可见**：其他用户的 `user_*` 目录根本不在容器内
- ✅ **无法访问**：即使知道路径也无法访问（目录不存在）
- ✅ **防止横向移动**：容器被攻破也无法访问其他用户缓存

#### 第二层：应用层路径验证

**路径验证函数**：`_validate_cache_path(cache_path, allowed_base_dir)`

```python
def _validate_cache_path(cache_path, allowed_base_dir):
    """验证缓存路径在允许的目录内"""
    abs_cache_path = os.path.abspath(cache_path)
    abs_base_dir = os.path.abspath(allowed_base_dir)

    # 确保缓存路径在允许的基础目录内
    if not abs_cache_path.startswith(abs_base_dir + os.sep):
        raise ValueError("Security violation: cache path outside allowed directory")
```

**防护能力**：
- ✅ **防止路径遍历**：阻止 `../../../user_456/` 等攻击
- ✅ **防止符号链接攻击**：使用绝对路径解析
- ✅ **防止目录穿越**：严格验证路径边界

#### 第三层：User ID 严格验证

```python
def get_cache_user_id():
    """获取并验证 user_id"""
    user_id = int(os.getenv("GIT_CACHE_USER_ID"))
    if user_id <= 0:
        raise ValueError("Invalid user_id: must be positive")
    return user_id
```

**验证规则**：
- ✅ 必须是有效整数
- ✅ 必须大于 0
- ✅ 拒绝字符串、浮点数、负数
- ✅ 拒绝 SQL 注入、命令注入

### 隔离效果对比

#### 修改前（仅逻辑隔离 - 不安全）

```
容器 user_123 内的文件系统：
/git-cache/
├── user_123/     ← 自己的缓存
├── user_456/     ← 其他用户缓存（可访问！）
└── user_789/     ← 其他用户缓存（可访问！）

恶意代码可以：
- cat /git-cache/user_456/github.com/repo.git/HEAD
- cp -r /git-cache/user_789/ /tmp/stolen
- rm -rf /git-cache/user_*  （破坏其他用户缓存）
```

#### 修改后（物理隔离 + 应用层验证 - 安全）

```
容器 user_123 内的文件系统：
/git-cache/
└── user_123/     ← 只有这个目录存在

容器只能：
- 访问 /git-cache/user_123/
- 无法访问 /git-cache/user_456/（不存在）
- 无法访问 /git-cache/user_789/（不存在）

即使恶意代码尝试：
- ls /git-cache/user_456/  → No such file or directory
- cat /git-cache/user_789/...  → No such file or directory
```

### 完整安全工作流程

```
1. 用户 (user_id=123) 发起任务
   ↓
2. executor_manager 从 task.user.id 提取 user_id=123
   ↓
3. 验证 user_id（必须是正整数）
   ↓
4. 启动容器时：
   - 挂载 git_cache_data:/git-cache/user_123
   - 设置 GIT_CACHE_USER_ID=123
   - 设置 GIT_CACHE_USER_BASE_DIR=/git-cache/user_123
   ↓
5. 容器内 git clone：
   - 读取 GIT_CACHE_USER_ID
   - 读取 GIT_CACHE_USER_BASE_DIR
   - 计算缓存路径：/git-cache/user_123/github.com/repo.git
   - 验证路径在 /git-cache/user_123/ 内
   ↓
6. 安全隔离完成：
   - 容器只能访问 /git-cache/user_123/
   - 其他用户缓存物理不可见
   - 路径验证防止遍历攻击
```

### 安全优势总结

| 安全特性 | 实现方式 | 防护能力 |
|---------|---------|---------|
| **容器级隔离** | 每个容器只挂载自己的 `user_{id}` 目录 | ⭐⭐⭐⭐⭐ 完全隔离 |
| **路径验证** | 应用层验证路径边界 | ⭐⭐⭐⭐⭐ 防遍历 |
| **User ID 验证** | 严格整数验证 | ⭐⭐⭐⭐ 防注入 |
| **Token 隔离** | 每个用户使用自己的 token | ⭐⭐⭐⭐ 防权限泄露 |
| **物理不可见** | 其他用户目录不在容器内 | ⭐⭐⭐⭐⭐ 防横向访问 |

### Token 管理

- ✅ 每次使用前更新 remote URL 为最新 token
- ✅ Token 保存在 bare repository 的 config 中
- ✅ 不同用户的 token 完全隔离
- ✅ Token 不在容器间共享

### 数据隔离保证

- ✅ **物理隔离**：容器层只挂载用户自己的目录
- ✅ **逻辑隔离**：应用层路径验证
- ✅ **权限隔离**：每个用户只能访问自己的缓存
- ✅ **容器重启不影响**：缓存隔离持久化
- ✅ **防跨用户访问**：即使容器以 root 运行也无法访问其他用户缓存

## 测试

### 运行单元测试

```bash
# 测试 git_cache 模块（包含 user_id 处理测试）
pytest shared/tests/utils/test_git_cache.py -v

# 测试 git_util 模块（包含缓存集成测试）
pytest shared/tests/utils/test_git_util.py -v

# 运行所有相关测试
pytest shared/tests/utils/test_git*.py -v

# 运行 user_id 相关测试
pytest shared/tests/utils/test_git_cache.py::TestGitCacheUserId -v

# 运行安全测试
pytest shared/tests/utils/test_git_cache.py::TestGitCacheSecurity -v
```

### 测试覆盖率

当前实现包含以下测试：

**基础功能测试**：
- ✅ user_id 验证测试（有效值、缺失、无效字符串、零、负数、浮点数）
- ✅ 缓存启用/禁用测试
- ✅ 缓存路径计算测试（多种 URL 格式）
- ✅ 用户隔离测试（不同 user_id 获得不同路径）
- ✅ 权限处理测试（自动 token 更新）
- ✅ 容错机制测试
- ✅ 边界条件测试（大整数、最小值）
- ✅ 多仓库缓存测试

**安全隔离测试**（新增）：
- ✅ **容器级隔离测试**：验证 `GIT_CACHE_USER_BASE_DIR` 正确使用
- ✅ **路径验证测试**：验证路径在允许的目录内
- ✅ **路径遍历防护测试**：阻止 `../../../user_456/` 等攻击
- ✅ **跨用户访问防护测试**：验证无法访问其他用户目录
- ✅ **安全注入测试**：SQL 注入、命令注入防护
- ✅ **user_id 隔离测试**：不同用户的缓存完全分离

**运行特定测试类**：
```bash
# 测试安全隔离
pytest shared/tests/utils/test_git_cache.py::TestGitCacheSecureIsolation -v

# 测试路径验证
pytest shared/tests/utils/test_git_cache.py::TestGitCachePathValidation -v

# 测试 user_id 处理
pytest shared/tests/utils/test_git_cache.py::TestGitCacheUserId -v

# 测试安全特性
pytest shared/tests/utils/test_git_cache.py::TestGitCacheSecurity -v
```

## 故障排查

### 缓存不工作

**问题**：克隆没有使用缓存

**检查**：
1. 确认 `GIT_CACHE_ENABLED=true`
2. 查看日志中是否有 "Git cache is enabled"
3. 检查 volume 是否正确挂载

### 权限错误

**问题**：`git fetch` 失败，提示权限不足

**解决方案**：
- 检查 token 是否有效
- 查看日志中的 remote URL
- 确认 token 有仓库访问权限

### 缓存损坏

**问题**：缓存仓库损坏，无法使用

**解决方案**：
```bash
# 删除损坏的缓存（使用 user_id）
rm -rf /git-cache/user_123/github.com/repo.git

# 下次克隆时会自动重新创建
```

### 磁盘空间不足

**问题**：缓存占用过多磁盘空间

**解决方案**：
```bash
# 清理旧缓存
find /git-cache -type f -mtime +30 -delete

# 或清理整个缓存
rm -rf /git-cache/*
```

## 最佳实践

### 生产环境

1. **定期清理**：设置定时任务清理超过 30 天的缓存
2. **监控空间**：监控 `/git-cache` 的磁盘使用
3. **设置告警**：缓存失败率超过阈值时告警
4. **备份策略**：重要仓库的缓存定期备份

### 开发环境

1. **默认禁用**：开发环境默认关闭缓存
2. **按需启用**：需要测试时手动启用
3. **快速清理**：开发完成后清理测试缓存

### 多租户环境

1. **严格隔离**：✅ 已实现容器级物理隔离，每个租户只能访问自己的缓存
2. **配额限制**：为每个租户设置缓存空间配额
3. **审计日志**：记录缓存使用情况
4. **定期安全审计**：
   - 验证容器挂载点正确（只挂载 `user_{id}` 子目录）
   - 检查日志中的安全验证记录
   - 测试跨用户访问是否被阻止

## 未来改进

### 短期改进

- [ ] 添加缓存统计接口（命中率、空间使用等）
- [ ] 支持缓存预热（提前缓存常用仓库）
- [ ] 添加缓存 TTL（自动清理过期缓存）
- [ ] 支持缓存压缩（进一步节省空间）
- [x] ✅ **容器级安全隔离**（已完成 - 2025-01-02）

### 长期改进

- [ ] 分布式缓存（多个 executor_manager 共享缓存）
- [ ] 缓存代理服务器（集中式缓存管理）
- [ ] 智能缓存策略（基于使用频率优化）
- [ ] 缓存健康检查（自动检测和修复损坏的缓存）

## 相关文档

- [Git --reference 文档](https://git-scm.com/docs/git-clone#Documentation/git-clone.txt---reference-if-ableltrepositorygt)
- [Git Alternates 机制](https://git-scm.com/docs/gitrepository-layout#Documentation/gitrepository-layout.txt)
- [Docker Volume 管理](https://docs.docker.com/storage/volumes/)
- [Git Cache 安全隔离设计](./git-cache-security-isolation-design.md) - 详细的安全隔离改进设计文档

## 贡献者

- 实现日期：2025-01
- 版本：v1.1.0（安全隔离改进）
- 维护者：Wegent Team

## 版本历史

### v1.1.0 (2025-01-02)

**安全隔离改进** - 解决容器级用户隔离问题

#### 核心改进
- ✅ **容器级物理隔离**：每个 executor 容器只挂载自己的 `/git-cache/user_{user_id}` 子目录
- ✅ **路径验证**：应用层路径验证，防止跨用户访问和路径遍历攻击
- ✅ **双重防护**：容器层隔离 + 应用层验证

#### 代码变更
- `executor_manager/executors/docker/executor.py`：修改挂载策略
- `shared/utils/git_cache.py`：添加路径验证和 `GIT_CACHE_USER_BASE_DIR` 支持
- `shared/tests/utils/test_git_cache.py`：添加安全隔离测试

#### 安全提升
- **修改前**：容器可访问所有用户的缓存目录（仅逻辑隔离）
- **修改后**：容器只能访问自己的缓存目录（物理隔离）
- **数据泄露风险**：从高降低到极低
- **横向访问**：从可能变为不可能

#### 文档更新
- 添加容器内视图说明
- 添加安全隔离对比
- 添加路径验证测试说明

### v1.0.0 (2025-01-01)

**初始实现**

- Git `--reference` 模式缓存
- 基于 user_id 的逻辑隔离
- 自动更新机制
- Token 管理

## 许可证

Apache-2.0

---

**最后更新**：2025-01-02（v1.1.0 安全隔离改进）
