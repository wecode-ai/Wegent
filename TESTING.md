# Wegent 测试框架

本文档描述了 Wegent 项目的测试框架和运行方式。

## 测试结构

项目采用分散式测试结构，每个模块内部创建 `tests/` 子目录：

```
backend/
  ├── tests/
  │   ├── conftest.py          # 全局 fixtures
  │   ├── core/                # 核心模块测试
  │   ├── services/            # 服务层测试
  │   ├── models/              # 数据模型测试
  │   └── repository/          # 仓库集成测试
  ├── pytest.ini               # pytest 配置
  └── .coveragerc              # 覆盖率配置

shared/
  ├── tests/
  │   └── utils/               # 工具函数测试
  └── pytest.ini

.github/
  └── workflows/
      └── test.yml             # CI/CD 测试工作流
```

## 测试技术栈

### Backend & Shared
- **pytest**: 测试框架
- **pytest-asyncio**: 异步测试支持
- **pytest-cov**: 代码覆盖率
- **pytest-mock**: Mock 支持
- **fakeredis**: Redis Mock
- **respx**: HTTP Mock (httpx)
- **responses**: HTTP Mock (requests)

## 运行测试

### 安装依赖

```bash
# Backend 测试依赖
cd backend
pip install -r requirements.txt

# Shared 测试依赖
pip install pytest pytest-cov pytest-asyncio cryptography
```

### 运行所有测试

```bash
# Backend 测试
cd backend
pytest tests -v --cov=app --cov-report=term-missing

# Shared 测试
cd shared
pytest tests -v --cov=utils --cov-report=term-missing
```

### 运行特定测试

```bash
# 运行特定测试文件
pytest tests/core/test_security.py -v

# 运行特定测试类
pytest tests/core/test_security.py::TestPasswordHashing -v

# 运行特定测试函数
pytest tests/core/test_security.py::TestPasswordHashing::test_get_password_hash_creates_valid_hash -v
```

### 查看覆盖率报告

```bash
# 生成 HTML 覆盖率报告
pytest tests --cov=app --cov-report=html

# 打开报告
open htmlcov/index.html  # macOS
xdg-open htmlcov/index.html  # Linux
```

## 测试覆盖范围

### Backend 核心模块测试 (backend/tests/core/)

#### test_security.py
- Password 哈希和验证
- JWT token 创建和验证
- 用户认证
- 当前用户获取
- 管理员权限验证

#### test_config.py
- 配置默认值验证
- 环境变量加载
- 配置项完整性检查

#### test_exceptions.py
- 自定义异常类
- 异常处理器
- HTTP 响应格式

### Backend 服务层测试 (backend/tests/services/)

#### test_user_service.py
- Git 信息验证
- 用户创建、更新、删除
- Git token 加密/解密
- Provider Mock (GitHub/GitLab/Gitee)

### Backend 数据模型测试 (backend/tests/models/)

#### test_user_model.py
- 模型字段验证
- 唯一性约束
- JSON 字段存储
- 时间戳自动更新

### Backend 仓库测试 (backend/tests/repository/)

#### test_github_provider.py
- Token 验证
- 仓库列表获取
- 分支列表获取
- 仓库搜索（精确/模糊匹配）

### Shared 工具测试 (shared/tests/utils/)

#### test_crypto.py
- Git token 加密/解密
- 加密状态检测
- 向后兼容性
- 边界条件处理

#### test_sensitive_data_masker.py
- 敏感数据遮蔽
- 字典/列表遮蔽
- 文件路径/URL 不误遮蔽
- 嵌套结构处理

## CI/CD 集成

项目配置了 GitHub Actions 工作流 (`.github/workflows/test.yml`)，在以下情况下自动运行测试：

- Push 到 main/master 分支
- Pull Request 到 main/master 分支

工作流包含：
- Backend 测试 (Python 3.9)
- Shared 测试 (Python 3.9)
- 覆盖率上传到 Codecov

## 编写新测试

### 测试命名规范

- 测试文件：`test_*.py`
- 测试类：`Test*`
- 测试函数：`test_*`

### 使用 Fixtures

全局 fixtures 定义在 `backend/tests/conftest.py`：

```python
def test_example(test_db, test_user, test_token):
    """示例测试使用多个 fixtures"""
    # test_db: SQLite 内存数据库
    # test_user: 测试用户对象
    # test_token: 有效的 JWT token
    pass
```

### Mock 外部依赖

```python
from unittest.mock import Mock, patch

def test_with_mock():
    """使用 Mock 测试外部 API"""
    with patch('requests.get') as mock_get:
        mock_get.return_value.json.return_value = {"key": "value"}
        # 测试代码
```

## 覆盖率目标

- 初期目标：40-60%
- 重点覆盖：核心业务逻辑、安全模块、数据验证

## 常见问题

### 1. 测试数据库隔离

每个测试使用独立的 SQLite 内存数据库，测试结束后自动清理，确保测试之间完全隔离。

### 2. 异步测试

使用 `@pytest.mark.asyncio` 装饰器：

```python
@pytest.mark.asyncio
async def test_async_function():
    result = await some_async_function()
    assert result is not None
```

### 3. Mock 配置

使用 `mock_settings` fixture 覆盖配置：

```python
def test_with_custom_settings(mock_settings):
    # Settings 已被 Mock，使用测试配置
    pass
```

## 参考资料

- [pytest 文档](https://docs.pytest.org/)
- [pytest-asyncio 文档](https://pytest-asyncio.readthedocs.io/)
- [coverage.py 文档](https://coverage.readthedocs.io/)
