# Git Cache 安全隔离改进设计

## 问题陈述

### 当前安全风险

**问题**：当前设计中，所有用户的缓存目录 (`/git-cache/user_123`, `/git-cache/user_456` 等) 都通过同一个 Docker volume 挂载到每个 executor 容器中。

**具体风险**：
1. **横向访问**：容器内的任何进程都可以访问 `/git-cache` 下的所有用户缓存
2. **数据泄露**：恶意代码可以读取其他用户的私有仓库缓存
3. **敏感信息暴露**：缓存中可能包含 token、私有代码等敏感信息
4. **路径遍历攻击**：虽然有 user_id 验证，但容器内没有任何强制访问控制

**当前缓解措施的局限性**：
- ❌ 目录隔离（`user_123`, `user_456`）只是逻辑隔离，不是物理隔离
- ❌ 容器以 root 运行时，任何代码都可访问整个 `/git-cache` 目录
- ❌ 没有文件系统级别的权限控制
- ❌ 依赖应用层检查，容易被绕过

## 解决方案

### 推荐方案：选择性子目录挂载

**核心思想**：每个 executor 容器只挂载和访问自己的 `/git-cache/user_{user_id}` 子目录

#### 架构设计

```
Docker Volume: git_cache_data
├── user_123/           ← 只挂载到 user_123 的容器
│   └── github.com/
│       └── repo.git/
├── user_456/           ← 只挂载到 user_456 的容器
│   └── gitlab.com/
│       └── project.git/
└── user_789/           ← 只挂载到 user_789 的容器
    └── github.com/
        └── private.git/
```

**容器视图（user_123）**：
```
Container user_123:
/git-cache/user_123/    ← 可见
└── github.com/
    └── repo.git/

/git-cache/user_456/    ← 不可见（不存在）
/git-cache/user_789/    ← 不可见（不存在）
```

## 实现细节

### 1. Docker Volume 挂载策略

#### 方案 A：Bind Mount 到子目录（推荐）

**优点**：
- 完全隔离，用户只能看到自己的缓存目录
- 实现简单，不需要改变现有缓存结构
- 兼容性好，适用于所有 Docker 版本

**实现**：

在 `executor_manager/executors/docker/executor.py` 中：

```python
def _create_git_cache_mount(self, task):
    """
    创建 git cache 挂载配置
    每个 executor 容器只挂载自己的 user_{user_id} 子目录
    """
    if not is_git_cache_enabled():
        return None

    # 获取 user_id
    user_id = getattr(task.user, 'id', None)
    if not user_id:
        logger.warning(f"Task {task.id} has no user.id, skipping git cache")
        return None

    # 验证 user_id
    try:
        user_id = int(user_id)
        if user_id <= 0:
            raise ValueError("user_id must be positive")
    except (ValueError, TypeError) as e:
        logger.error(f"Invalid user_id {user_id}: {e}")
        return None

    cache_volume = "git_cache_data"
    cache_base_dir = get_cache_dir()  # /git-cache
    user_cache_dir = f"{cache_base_dir}/user_{user_id}"

    # 返回 bind mount 配置
    # 将 volume 挂载到 /git-cache/user_{user_id}
    return {
        "type": "volume",
        "source": cache_volume,
        "target": user_cache_dir,  # /git-cache/user_123
        "read_only": False
    }

def _create_container(self, task):
    """创建容器（修改部分）"""
    mounts = []

    # 添加 git cache 挂载（如果启用）
    cache_mount = self._create_git_cache_mount(task)
    if cache_mount:
        mounts.append(cache_mount)
        logger.info(
            f"Mounted git cache for user {task.user.id}: "
            f"{cache_mount['target']}"
        )

    # ... 其他挂载配置

    self.docker_client.containers.create(
        # ... 其他参数
        mounts=mounts,
        # ...
    )
```

**容器内的目录结构**：
```
/git-cache/
└── user_123/          ← 只有这个目录存在和可见
    └── github.com/
        └── repo.git/
```

#### 方案 B：使用 Tmpfs + 独立 Volume（更安全但性能差）

```python
cache_volume = f"git_cache_user_{user_id}"  # 每个用户独立 volume
```

**缺点**：
- 失去跨用户缓存共享的优势
- 增加存储开销
- 不推荐用于多租户环境

### 2. Git Cache 路径处理修改

#### 修改 `git_cache.py`

```python
def get_cache_repo_path(url, cache_dir="/git-cache"):
    """
    计算缓存仓库路径

    注意：由于我们只挂载了 /git-cache/user_{user_id}，
    实际可访问的路径就是 {cache_dir}/user_{user_id}/{domain}/{path}.git
    但在容器内，cache_dir 应该指向 /git-cache/user_{user_id}

    Args:
        url: Git repository URL
        cache_dir: 缓存基础目录（在容器内，这是 /git-cache/user_{user_id}）

    Returns:
        缓存仓库路径
    """
    user_id = get_cache_user_id()

    # 环境变量设置：GIT_CACHE_USER_BASE_DIR=/git-cache/user_123
    # 这样在容器内，cache_dir 已经是用户专属目录
    user_base_dir = os.getenv("GIT_CACHE_USER_BASE_DIR", cache_dir)

    # 解析 URL 获取域名和路径
    parsed = urlparse(url)
    domain = parsed.netloc or parsed.path.split('@')[-1].split(':')[0]
    path = parsed.path.strip('/').replace('.git', '') + '.git'

    # 最终路径：/git-cache/user_123/github.com/user/repo.git
    # 或在容器内：/git-cache/github.com/user/repo.git（如果挂载点是 /git-cache/user_123）
    return os.path.join(user_base_dir, domain, path)

def ensure_cache_repo(cache_path, auth_url, branch="main"):
    """
    确保缓存仓库存在并更新

    添加安全检查：确保 cache_path 在允许的目录内
    """
    user_id = get_cache_user_id()
    user_base_dir = os.getenv("GIT_CACHE_USER_BASE_DIR", "/git-cache")

    # 安全检查：防止路径遍历
    abs_cache_path = os.path.abspath(cache_path)
    abs_base_dir = os.path.abspath(user_base_dir)

    if not abs_cache_path.startswith(abs_base_dir + os.sep):
        raise SecurityError(
            f"Cache path {abs_cache_path} is outside allowed base {abs_base_dir}"
        )

    # 继续原有的缓存创建逻辑
    # ...
```

### 3. 环境变量配置

在 `executor_manager/executors/docker/executor.py` 中：

```python
def _get_container_env_vars(self, task):
    """获取容器环境变量"""
    env_vars = {
        # ... 其他环境变量
    }

    # 添加 git cache 配置
    if is_git_cache_enabled():
        user_id = getattr(task.user, 'id', None)
        if user_id:
            env_vars.update({
                "GIT_CACHE_ENABLED": "true",
                "GIT_CACHE_DIR": "/git-cache",  # 容器内的基础路径
                "GIT_CACHE_USER_ID": str(user_id),
                "GIT_CACHE_USER_BASE_DIR": f"/git-cache/user_{user_id}",
                "GIT_CACHE_AUTO_UPDATE": "true",
            })

    return env_vars
```

### 4. 路径遍历防护

```python
# shared/utils/git_cache.py

def _sanitize_path_component(component):
    """
    清理路径组件，防止路径遍历攻击

    Args:
        component: 路径组件（如 user_id, domain, path）

    Returns:
        安全的路径组件

    Raises:
        ValueError: 如果包含危险字符
    """
    if not component:
        raise ValueError("Path component cannot be empty")

    # 检查路径遍历尝试
    if ".." in component or component.startswith(('/')):
        raise ValueError(f"Invalid path component: {component}")

    # 只允许安全字符
    import re
    if not re.match(r'^[a-zA-Z0-9._-]+$', component):
        raise ValueError(f"Path component contains unsafe characters: {component}")

    return component

def get_cache_user_id():
    """从环境变量获取并验证 user_id"""
    user_id_str = os.getenv("GIT_CACHE_USER_ID")

    if not user_id_str:
        raise ValueError(
            "GIT_CACHE_USER_ID is required but not set. "
            "Cannot use git cache without user isolation."
        )

    try:
        user_id = int(user_id_str)
    except ValueError:
        raise ValueError(
            f"Invalid GIT_CACHE_USER_ID: must be an integer, got '{user_id_str}'"
        )

    if user_id <= 0:
        raise ValueError(
            f"Invalid GIT_CACHE_USER_ID: must be positive, got {user_id}"
        )

    return user_id
```

## 安全对比

### 修改前（不安全）

```
Container (user_123):
/git-cache/
├── user_123/    ← 自己的缓存
├── user_456/    ← 其他用户的缓存（可访问！）
└── user_789/    ← 其他用户的缓存（可访问！）

恶意代码可以：
- cat /git-cache/user_456/github.com/repo.git/HEAD
- cp -r /git-cache/user_789/ /tmp/stolen
- rm -rf /git-cache/user_*  （破坏其他用户缓存）
```

### 修改后（安全）

```
Container (user_123):
/git-cache/
└── user_123/    ← 只有自己的缓存

容器只能：
- 访问 /git-cache/user_123/
- 无法访问 /git-cache/user_456/（不存在）
- 无法访问 /git-cache/user_789/（不存在）
```

## 迁移指南

### 步骤 1：修改代码

1. **修改 executor.py**：
   - 更新 `_create_git_cache_mount()` 方法
   - 更新 `_get_container_env_vars()` 方法

2. **修改 git_cache.py**：
   - 添加路径验证
   - 更新环境变量处理

### 步骤 2：更新 Docker 配置

```yaml
# docker-compose.yml
services:
  executor_manager:
    environment:
      - GIT_CACHE_ENABLED=true
      - GIT_CACHE_DIR=/git-cache
      - GIT_CACHE_AUTO_UPDATE=true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - git_cache_data:/git-cache  # 保持不变

volumes:
  git_cache_data:
    driver: local
```

### 步骤 3：测试

```bash
# 1. 部署新版本
docker-compose down
docker-compose up -d

# 2. 创建测试任务（user_123）
# 检查容器内的挂载
docker exec -it <container-id> ls -la /git-cache/
# 应该只看到 user_123

# 3. 尝试访问其他用户目录
docker exec -it <container-id> ls /git-cache/user_456
# 应该报错：No such file or directory
```

### 步骤 4：清理旧缓存（可选）

```bash
# 如果需要重新构建缓存
docker exec -it wegent-executor-manager rm -rf /git-cache/*
```

## 兼容性说明

### 向后兼容

- ✅ 缓存目录结构不变
- ✅ 现有缓存可以继续使用
- ✅ API 接口不变

### Docker 版本要求

- Docker API 1.25+ （Docker 17.05+）
- 支持 volume subdirectory mounts

## 性能影响

- ✅ **无性能损失**：只是改变了挂载点，实际 IO 路径相同
- ✅ **启动速度**：不受影响
- ✅ **缓存效果**：完全相同

## 监控和审计

### 添加日志

```python
logger.info(
    f"Git cache mounted for user_{user_id}: "
    f"container={container_id}, "
    f"path={user_cache_dir}"
)

# 安全审计日志
logger.info(
    f"Security: cache access validated: "
    f"user={user_id}, "
    f"path={cache_path}, "
    f"allowed={abs_cache_path.startswith(abs_base_dir)}"
)
```

### 指标收集

- 缓存命中率（按用户）
- 每个用户的缓存空间使用
- 安全验证失败次数

## 其他安全增强建议

### 1. 文件系统权限

```python
# 在宿主机上设置权限
os.chmod(f"/git-cache/user_{user_id}", 0o700)
os.chown(f"/git-cache/user_{user_id}", uid=1000, gid=1000)
```

### 2. 只读挂载（可选）

```python
return {
    "type": "volume",
    "source": cache_volume,
    "target": user_cache_dir,
    "read_only": True  # 缓存只读，防止恶意修改
}
```

### 3. 定期审计

```bash
# 审计脚本
#!/bin/bash
# 检查是否有权限问题
find /git-cache -type d -perm /o=rwx -ls

# 检查是否有越权访问
docker exec <container> ls /git-cache/ | grep -v "^user_"
```

## 总结

### 改进效果

| 方面 | 改进前 | 改进后 |
|------|--------|--------|
| **用户隔离** | 逻辑隔离（应用层） | 物理隔离（容器层） |
| **数据泄露风险** | 高 | 极低 |
| **横向访问** | 可能 | 不可能 |
| **路径遍历防护** | 应用层检查 | 容器层隔离 + 应用层检查 |
| **性能影响** | 无 | 无 |
| **实现复杂度** | 简单 | 中等 |

### 推荐实施优先级

1. **P0（必须）**：实施方案 A（选择性子目录挂载）
2. **P1（强烈建议）**：添加路径验证和安全检查
3. **P2（建议）**：添加监控和审计日志
4. **P3（可选）**：文件系统权限加固

## 附录：完整代码示例

### executor.py 完整修改

```python
class DockerExecutor:
    """Docker executor with secure git cache isolation"""

    def _create_git_cache_mount(self, task):
        """创建安全的 git cache 挂载"""
        if not is_git_cache_enabled():
            return None

        user_id = getattr(task.user, 'id', None)
        if not user_id:
            logger.warning(f"Task {task.id} has no user.id")
            return None

        try:
            user_id = int(user_id)
            if user_id <= 0:
                raise ValueError("user_id must be positive")
        except (ValueError, TypeError) as e:
            logger.error(f"Invalid user_id for task {task.id}: {e}")
            return None

        cache_volume = "git_cache_data"
        cache_base = get_cache_dir()
        user_cache_dir = f"{cache_base}/user_{user_id}"

        logger.info(
            f"Mounting git cache for user {user_id}: {user_cache_dir}"
        )

        return {
            "type": "volume",
            "source": cache_volume,
            "target": user_cache_dir,
            "read_only": False
        }

    def _create_container(self, task):
        """创建容器（修改版）"""
        mounts = []

        # Git cache 挂载
        cache_mount = self._create_git_cache_mount(task)
        if cache_mount:
            mounts.append(cache_mount)

        # ... 其他挂载

        # 环境变量
        env_vars = self._get_container_env_vars(task)

        # 创建容器
        container = self.docker_client.containers.create(
            image=task.image,
            command=task.command,
            environment=env_vars,
            mounts=mounts,
            # ... 其他参数
        )

        return container

    def _get_container_env_vars(self, task):
        """获取环境变量（修改版）"""
        env_vars = {
            # ... 其他变量
        }

        if is_git_cache_enabled():
            user_id = getattr(task.user, 'id', None)
            if user_id:
                env_vars.update({
                    "GIT_CACHE_ENABLED": "true",
                    "GIT_CACHE_DIR": "/git-cache",
                    "GIT_CACHE_USER_ID": str(user_id),
                    "GIT_CACHE_USER_BASE_DIR": f"/git-cache/user_{user_id}",
                    "GIT_CACHE_AUTO_UPDATE": "true",
                })

        return env_vars
```

---

**文档版本**: v1.0
**创建日期**: 2025-01-02
**作者**: Wegent Team
**状态**: 设计审查中
