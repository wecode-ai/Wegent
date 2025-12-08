# 数据库迁移指南

本指南介绍如何使用 Alembic 管理 Wegent 后端应用的数据库迁移。

## 概述

Alembic 是 SQLAlchemy 的数据库迁移工具。它为数据库架构提供版本控制，允许您跟踪变更、应用升级和在需要时回滚。

## 快速开始

### 查看当前迁移状态

```bash
# 检查当前数据库版本
alembic current

# 查看迁移历史
alembic history --verbose
```

### 应用迁移

```bash
# 升级到最新版本
alembic upgrade head

# 升级一个版本
alembic upgrade +1

# 升级到指定版本
alembic upgrade <revision_id>
```

### 回滚迁移

```bash
# 降级一个版本
alembic downgrade -1

# 降级到指定版本
alembic downgrade <revision_id>

# 降级到基础版本（移除所有迁移）
alembic downgrade base
```

### 创建新迁移

```bash
# 基于模型变更自动生成迁移脚本
alembic revision --autogenerate -m "变更描述"

# 创建空的迁移脚本
alembic revision -m "变更描述"
```

生成迁移脚本后，务必在应用前仔细检查，确保它符合您的预期。

## 重要说明

### 开发环境 vs 生产环境

- **开发模式**：当 `ENVIRONMENT=development` 且 `DB_AUTO_MIGRATE=True` 时，迁移会在应用启动时自动运行
- **生产模式**：必须手动运行迁移。如果有待处理的迁移，应用会记录警告日志

### 最佳实践

1. **始终检查自动生成的迁移** - Alembic 可能无法正确检测所有变更
2. **在生产数据副本上测试迁移** - 在应用到生产环境之前进行测试
3. **在生产环境运行迁移前备份数据库** - 确保数据安全
4. **永远不要编辑已应用的迁移** - 而是创建新的迁移
5. **保持迁移小而专注** - 更容易审查和回滚

### 迁移安全性

- 初始迁移使用 `CREATE TABLE IF NOT EXISTS` 来安全处理现有数据库
- 所有迁移都包含 `upgrade()` 和 `downgrade()` 函数以支持回滚
- 外键约束按正确顺序处理

## 常用命令

```bash
# 首先进入 backend 目录
cd /path/to/wegent/backend

# 检查将要应用的迁移
alembic upgrade head --sql

# 显示数据库和模型之间的差异
alembic upgrade head --sql > migration.sql

# 获取帮助
alembic --help
alembic upgrade --help
```

## 故障排除

### 迁移失败

1. 检查 `alembic.ini` 或 `DATABASE_URL` 环境变量中的数据库连接
2. 检查迁移脚本是否有错误
3. 查看数据库日志获取详细错误信息

### 与现有表冲突

如果您有现有数据库：
1. 初始迁移设计为使用 `CREATE TABLE IF NOT EXISTS` 安全处理
2. 运行 `alembic stamp head` 将数据库标记为最新状态而不运行迁移
3. 之后的迁移将正常应用

### 重置迁移

**警告**：这将删除所有表和数据！

```bash
# 降级到基础版本
alembic downgrade base

# 升级到最新版本
alembic upgrade head
```

## 迁移文件结构

```
backend/alembic/
├── versions/           # 迁移脚本（应用后不要编辑）
│   ├── 0c086b93f8b9_initial_migration.py
│   └── b2c3d4e5f6a7_add_role_to_users.py  # 用户角色迁移
├── env.py             # Alembic 运行时环境
├── script.py.mako     # 新迁移的模板
└── README             # 快速参考
```

## 重要迁移说明

### 用户角色迁移 (`b2c3d4e5f6a7`)

此迁移为 `users` 表添加 `role` 列，用于基于角色的访问控制：

- **列名**: `role` (VARCHAR(20), NOT NULL, 默认值: 'user')
- **可选值**: 'admin' 或 'user'
- **自动升级**: `user_name='admin'` 的用户会自动设置为 `role='admin'`

该迁移使用条件 SQL 来安全处理列已存在的情况。

## 工作流示例

以下是添加新模型字段的典型工作流：

1. **修改模型** 在 `backend/app/models/` 中：
   ```python
   # 向模型添加新字段
   class User(Base):
       # ... 现有字段 ...
       new_field = Column(String(100), nullable=True)
   ```

2. **生成迁移**：
   ```bash
   cd backend
   alembic revision --autogenerate -m "add new_field to user table"
   ```

3. **检查生成的迁移** 在 `backend/alembic/versions/` 中：
   - 检查变更是否符合预期
   - 验证数据类型转换
   - 确保可空/默认值正确

4. **测试迁移**：
   ```bash
   # 应用迁移
   alembic upgrade head
   
   # 验证是否正常工作
   # 测试您的应用
   
   # 如需要，回滚
   alembic downgrade -1
   ```

5. **提交迁移**：
   ```bash
   git add backend/alembic/versions/<new_migration>.py
   git commit -m "feat(backend): add new_field to user table"
   ```

## 更多信息

- [Alembic 文档](https://alembic.sqlalchemy.org/)
- [SQLAlchemy 文档](https://docs.sqlalchemy.org/)
- [AGENTS.md - Backend 部分](../../../../AGENTS.md#backend)