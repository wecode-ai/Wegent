# 测试框架文档

本文档介绍 Wegent 项目的单元测试框架设置。

## 概述

该项目为所有模块提供了全面的单元测试支持：

- **后端** (FastAPI): pytest + pytest-asyncio + pytest-cov + pytest-mock
- **执行器** (AI Agent 引擎): pytest + pytest-mock + pytest-asyncio
- **执行器管理器** (任务管理): pytest + pytest-mock + pytest-cov
- **共享模块** (工具库): pytest + pytest-cov
- **前端** (Next.js + React 19): Jest + @testing-library/react

## 当前测试覆盖率

### 后端 (`backend/`)
- ✅ 核心安全：身份验证、JWT 令牌、password 哈希
- ✅ 配置管理
- ✅ 异常处理
- ✅ 用户服务和模型
- ✅ GitHub 仓库提供者
- ⏳ API 端点（占位符目录已存在）

### 执行器 (`executor/`)
- ✅ Agent 工厂
- ✅ 基础 agent 类
- ✅ 模拟 AI 客户端交互（Anthropic、OpenAI）

### 执行器管理器 (`executor_manager/`)
- ✅ 基础执行器类
- ✅ 任务调度器
- ✅ Docker 执行器和工具
- ✅ Docker 常量和配置

### 共享模块 (`shared/`)
- ✅ 加密工具
- ✅ 敏感数据脱敏（令牌、API 密钥等）

### 前端 (`frontend/`)
- ⏳ 组件测试（已建立基本设置）
- ⏳ Hook 测试
- ⏳ 工具函数测试

## 测试覆盖率目标

- **目标**：初期达到 40-60% 的代码覆盖率
- **优先级**：核心业务逻辑和关键路径
- **策略**：逐步提高覆盖率

## 后端测试

### 运行测试

```bash
cd backend
pytest                          # 运行所有测试
pytest tests/core/             # 仅运行核心测试
pytest --cov=app               # 运行并生成覆盖率报告
pytest -v                      # 详细输出
pytest -k test_security        # 运行特定测试模式
pytest -m unit                 # 仅运行单元测试
pytest -m integration          # 仅运行集成测试
```

### 测试结构

```
backend/tests/
├── conftest.py              # 全局测试 fixture（测试夹具）
├── core/                    # 核心基础设施测试
│   ├── test_security.py     # 身份验证和 JWT 测试
│   ├── test_config.py       # 配置测试
│   └── test_exceptions.py   # 异常处理器测试
├── services/                # 服务层测试
│   └── test_user_service.py # 用户服务测试
├── models/                  # 数据模型测试
│   └── test_user_model.py   # 用户模型测试
├── repository/              # 仓库集成测试
│   └── test_github_provider.py
└── api/                     # API 端点测试（占位符）
```

### 测试配置

后端使用 `pytest.ini` 进行配置，包含以下设置：

```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts =
    -v
    --strict-markers
    --cov=app
    --cov-report=term-missing
    --cov-report=html
    --cov-report=xml
asyncio_mode = auto
markers =
    unit: Unit tests
    integration: Integration tests
    slow: Slow running tests
```

### 关键 Fixture（测试夹具）

- `test_db`：SQLite 内存数据库会话（函数作用域）
- `test_settings`：带有覆盖值的测试设置
- `test_user`：测试用户实例
- `test_admin_user`：测试管理员用户实例
- `test_inactive_user`：非活动测试用户实例
- `test_token`：测试用户的有效 JWT 令牌
- `test_admin_token`：管理员用户的有效 JWT 令牌
- `test_client`：带有数据库覆盖的 FastAPI 测试客户端
- `mock_redis`：模拟的 Redis 客户端

## 执行器测试

### 运行测试

```bash
cd executor
pytest tests/ --cov=agents
```

### 测试结构

```
executor/tests/
├── conftest.py              # 执行器特定的 fixture
└── agents/                  # Agent 测试
```

### 关键 Fixture

- `mock_anthropic_client`：模拟的 Anthropic API 客户端，用于测试 Claude 模型
- `mock_openai_client`：模拟的 OpenAI API 客户端，用于测试 GPT 模型
- `mock_callback_client`：模拟的回调 HTTP 客户端，用于 agent 响应
- `suppress_resource_warnings`：会话作用域的 fixture，用于抑制 ResourceWarning 消息
- `cleanup_logging`：会话作用域的 fixture，用于清理日志处理器并防止守护线程错误

## 执行器管理器测试

### 运行测试

```bash
cd executor_manager
pytest tests/ --cov=executors
```

### 关键 Fixture

- `mock_docker_client`：模拟的 Docker SDK 客户端，用于容器操作
- `mock_executor_config`：模拟执行器配置，包含镜像、CPU、内存和网络设置

### 测试结构

```
executor_manager/tests/
├── conftest.py              # 执行器管理器 fixture
└── executors/               # 执行器测试
    ├── test_base.py
    ├── test_dispatcher.py
    ├── test_docker_executor.py
    ├── test_docker_utils.py
    └── test_docker_constants.py
```

## 共享模块测试

### 运行测试

```bash
cd shared
pytest tests/ --cov=utils
```

### 测试结构

```
shared/tests/
└── utils/
    ├── test_crypto.py               # 加密/解密测试
    └── test_sensitive_data_masker.py # 敏感数据脱敏测试
```

### 已测试的关键功能

- **加密**：敏感数据的加密和解密（Git 令牌、API 密钥）
- **数据脱敏**：日志和输出中敏感信息的自动脱敏
  - GitHub 令牌（github_pat_*）
  - Anthropic API 密钥（sk-ant-api03-*）
  - OpenAI API 密钥
  - 通用 API 密钥和 secrets
  - 文件路径保护（无误报）
  - URL 保护（无误报）

## 前端测试

### 运行测试

```bash
cd frontend
npm test                     # 运行所有测试
npm run test:watch          # 监视模式
npm run test:coverage       # 生成覆盖率报告
```

### 测试结构

```
frontend/src/__tests__/
├── utils/                   # 工具函数测试
├── hooks/                   # React hooks 测试
└── components/              # 组件测试
```

## 持续集成

### GitHub Actions 工作流

`.github/workflows/test.yml` 工作流在以下情况下自动运行：
- 推送到 `main`、`master` 或 `develop` 分支
- 向这些分支提交的拉取请求

### 工作流任务

1. **test-backend**：Python 后端测试
   - 矩阵策略：Python 3.10 和 3.11
   - 覆盖率报告上传至 Codecov
   - 依赖缓存以加快构建速度

2. **test-executor**：执行器引擎测试
   - Python 3.10
   - agents 模块的覆盖率
   - 测试 AI agent 工厂和基础类

3. **test-executor-manager**：任务管理器测试
   - Python 3.10
   - executors 模块的覆盖率
   - 测试 Docker 执行器和调度器

4. **test-shared**：共享工具库测试
   - Python 3.10
   - utils 模块的覆盖率
   - 测试加密和数据脱敏

5. **test-frontend**：前端测试（Node.js 18.x）
   - 使用 React Testing Library 的 Jest
   - 使用 `--passWithNoTests` 标志运行
   - 覆盖率上传至 Codecov

6. **test-summary**：汇总结果
   - 依赖于所有测试任务
   - 如果任何测试任务失败则失败
   - 始终运行，无论单个任务的状态如何

### 覆盖率报告

覆盖率报告会自动上传到 Codecov（如果已配置）。

## Mock（模拟）策略

### 外部 API

- **GitHub/GitLab/Gitee**：使用 `httpx-mock` 或 `pytest-mock` 进行模拟
- **Anthropic/OpenAI**：模拟 SDK 客户端
- **Redis**：使用 `fakeredis` 或 mock

### 数据库

- **测试数据库**：SQLite 内存数据库
- **隔离**：每个测试获得一个新的事务
- **清理**：每个测试后自动回滚

### Docker

- 模拟 `docker.from_env()` 和容器操作

## 最佳实践

### 编写测试

1. **每个测试一个断言**：每个测试应验证一个特定的行为
2. **描述性名称**：使用清晰、描述性的测试函数名称来说明正在测试什么
3. **AAA 模式**：安排（Arrange）、执行（Act）、断言（Assert）- 清晰地组织测试结构
4. **模拟外部依赖**：永远不要调用真实的外部服务（API、数据库等）
5. **使用 fixture**：通过 fixture 共享常见的测试设置以减少重复
6. **测试边界情况**：包含错误条件、边界值和异常输入的测试
7. **保持测试独立**：每个测试应该能够独立运行，不依赖其他测试

### 安全测试最佳实践

该项目在 `backend/tests/core/test_security.py` 中包含了全面的安全测试示例：

- Password 哈希和验证（bcrypt）
- JWT 令牌创建和验证
- 令牌过期处理
- 使用有效/无效凭据的用户身份验证
- 非活动用户检测
- 基于角色的访问控制（管理员与普通用户）

安全功能的测试模式示例：

```python
@pytest.mark.unit
class TestPasswordHashing:
    """Test password hashing and verification functions"""

    def test_verify_password_with_correct_password(self):
        """Test password verification with correct password"""
        password = "testpassword123"
        hashed = get_password_hash(password)
        assert verify_password(password, hashed) is True

    def test_verify_password_with_incorrect_password(self):
        """Test password verification with incorrect password"""
        password = "testpassword123"
        hashed = get_password_hash(password)
        assert verify_password("wrongpassword", hashed) is False
```

### 测试组织

```python
@pytest.mark.unit
class TestFeatureName:
    """Test feature description"""

    def test_success_case(self):
        """Test successful operation"""
        # Arrange（安排）
        data = {"key": "value"}

        # Act（执行）
        result = function_under_test(data)

        # Assert（断言）
        assert result == expected_value

    def test_error_case(self):
        """Test error handling"""
        with pytest.raises(ExpectedException):
            function_under_test(invalid_data)
```

### 使用测试标记

测试标记有助于分类和选择性运行测试：

```bash
# 仅运行单元测试
pytest -m unit

# 仅运行集成测试
pytest -m integration

# 运行慢速测试
pytest -m slow

# 跳过慢速测试
pytest -m "not slow"
```

### 异步测试

```python
@pytest.mark.asyncio
async def test_async_function():
    """Test asynchronous function"""
    result = await async_function()
    assert result is not None
```

后端的 `pytest.ini` 包含 `asyncio_mode = auto`，可自动检测并运行异步测试。

## 添加新测试

### 后端

1. 在相应的 `tests/` 子目录中创建测试文件（例如，`tests/services/test_new_service.py`）
2. 从 `conftest.py` 导入必要的 fixture
3. 使用 `@pytest.mark.unit` 或 `@pytest.mark.integration` 对测试进行分类
4. 遵循 AAA（安排-执行-断言）模式
5. 编写具有描述性名称的测试类和方法
6. 在提交前本地运行测试：`pytest tests/ -v`
7. 确保覆盖率得到维持或提高：`pytest --cov=app --cov-report=term-missing`

### 前端

1. 在 `src/__tests__/` 中创建与源代码结构匹配的测试文件
2. 使用 `@testing-library/react` 进行组件测试
3. 模拟 API 调用和外部依赖
4. 确保测试通过：`npm test`

## 调试测试

### 后端

```bash
# 运行特定测试并输出详细信息
pytest tests/core/test_security.py::TestPasswordHashing::test_verify_password_with_correct_password -v

# 在失败时进入调试器
pytest --pdb

# 显示 print 语句
pytest -s
```

### 前端

```bash
# 在监视模式下运行测试
npm run test:watch

# 调试特定测试文件
npm test -- src/__tests__/utils/test_example.test.ts
```

## 配置文件

### 后端

- `backend/pytest.ini`：pytest 配置，包含覆盖率设置和测试标记
  - 启用详细输出、严格标记和自动异步模式
  - 配置终端、HTML 和 XML 格式的覆盖率报告
  - 定义自定义标记：`unit`、`integration`、`slow`

### 执行器/执行器管理器/共享模块

- `pytest.ini`：模块特定的 pytest 配置
- 与后端类似的设置，但具有模块特定的覆盖率目标

### 前端

- `frontend/jest.config.ts`：Jest 配置
- `frontend/jest.setup.js`：测试环境设置

## 未来改进

- [ ] 将覆盖率提高到 70-80%
- [ ] 为 API 端点添加集成测试（当前为占位符）
- [ ] 为关键用户流程添加 E2E 测试
- [ ] 性能/负载测试
- [ ] 使用 `mutmut` 进行变异测试
- [ ] 添加更多前端组件测试
- [ ] 实现数据库迁移测试
- [ ] 为 WebSocket 连接和实时功能添加测试

## 故障排除

### 常见问题

**测试中的导入错误：**
- 确保您从正确的目录运行 pytest
- 检查模块是否已安装：`uv sync`

**数据库错误：**
- 测试使用 SQLite 内存数据库，无需设置
- 检查 fixture 是否正确导入

**前端测试失败：**
- 确保已安装 Node.js 18.x
- 运行 `npm ci` 以安装确切的依赖版本
- 清除 Jest 缓存：`npx jest --clearCache`

## 资源

- [pytest 文档](https://docs.pytest.org/)
- [Testing Library](https://testing-library.com/)
- [Jest 文档](https://jestjs.io/)
- [GitHub Actions](https://docs.github.com/en/actions)
