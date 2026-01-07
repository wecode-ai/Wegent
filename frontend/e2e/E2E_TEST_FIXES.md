# E2E 测试修复总结

## 修复日期

2025-12-13

## 问题概述

Chrome 内核的 E2E 测试出现大量失败（187个测试中约100+失败），而 API 测试全部通过。经过详细分析，发现核心问题是**测试代码与 Playwright 配置不一致**。

## 根本原因

### 1. 重复登录问题（主要原因）

**问题描述**：

- Playwright 配置使用了 `global-setup.ts` 进行全局认证，并保存到 `storageState: './e2e/.auth/user.json'`
- chromium 项目配置了使用该 storageState，意味着测试启动时已经是登录状态
- 但大多数测试在 `beforeEach` 中仍然调用 `loginPage.login()` 进行登录
- 已登录状态下访问 `/login` 页面会被重定向，导致登录表单选择器找不到元素
- 测试超时失败（约17-18秒，接近 `actionTimeout: 15000` + 额外等待）

**影响范围**：

- `admin/admin-users.spec.ts`
- `admin/admin-public-models.spec.ts`
- `integration/settings-chat-integration.spec.ts`
- `knowledge/knowledge.spec.ts`
- `settings/settings-shell.spec.ts`
- `tasks/code-page-enhanced.spec.ts`
- `tasks/file-upload.spec.ts`
- `performance/page-load.spec.ts`
- `examples/coverage-example.spec.ts`

### 2. API 测试配置错误

**问题描述**：

- `admin/admin-public-models.spec.ts` 中的 `Admin - Public Model API Tests` 是纯 API 测试
- 但它们被放在 `admin/` 目录下，被 chromium 项目匹配执行
- chromium 项目的 `baseURL` 是 `http://localhost:3000`（前端）
- API 测试需要 `baseURL` 是 `http://localhost:8000`（后端）

### 3. 选择器不稳定（次要问题）

**问题描述**：

- 选择器使用了多种备选方案，但实际页面结构可能与预期不符
- 等待 `networkidle` 可能不够，页面可能还在渲染

## 修复方案

### 方案 1：移除重复登录代码

**修改的文件**：

1. ✅ `frontend/e2e/tests/auth/login.spec.ts` - 添加 `test.use({ storageState: { cookies: [], origins: [] } })`
2. ✅ `frontend/e2e/tests/admin/admin-users.spec.ts` - 移除 `loginPage.login()`，保留 API 登录
3. ✅ `frontend/e2e/tests/admin/admin-public-models.spec.ts` - 移除 `loginPage.login()`，保留 API 登录
4. ✅ `frontend/e2e/tests/integration/settings-chat-integration.spec.ts` - 移除 `loginPage.login()`
5. ✅ `frontend/e2e/tests/knowledge/knowledge.spec.ts` - 移除 `loginPage.login()`
6. ✅ `frontend/e2e/tests/settings/settings-shell.spec.ts` - 移除 `loginPage.login()`
7. ✅ `frontend/e2e/tests/tasks/code-page-enhanced.spec.ts` - 移除 `loginPage.login()`（两个 describe 块）
8. ✅ `frontend/e2e/tests/tasks/file-upload.spec.ts` - 移除 `loginPage.login()`
9. ✅ `frontend/e2e/tests/performance/page-load.spec.ts` - 移除 `loginPage.login()`
10. ✅ `frontend/e2e/tests/examples/coverage-example.spec.ts` - 添加空 storageState

**修改原则**：

- 需要测试登录功能的测试：使用 `test.use({ storageState: { cookies: [], origins: [] } })`
- 需要 API 操作的测试：保留 `apiClient.login()`，移除 `loginPage.login()`
- 其他测试：依赖 global-setup 的 storageState，无需额外登录

### 方案 2：分离 API 测试

**修改的文件**：

1. ✅ 创建 `frontend/e2e/tests/api/admin-public-models-api.spec.ts` - 将 API 测试移到 api 目录
2. ✅ 从 `frontend/e2e/tests/admin/admin-public-models.spec.ts` 中删除 API 测试部分

**原因**：

- API 测试应该在 `api` 项目下运行，使用正确的 baseURL
- UI 测试应该在 `chromium` 项目下运行

## 修复后的测试结构

### 认证策略

```typescript
// 1. 需要测试登录功能的测试（如 auth/login.spec.ts）
test.describe('Authentication - Login', () => {
  test.use({ storageState: { cookies: [], origins: [] } })
  // 测试登录流程
})

// 2. 需要 API 操作的 UI 测试
test.beforeEach(async ({ page, request }) => {
  apiClient = createApiClient(request)
  await apiClient.login(ADMIN_USER.username, ADMIN_USER.password) // 仅 API 登录
  // page 已通过 storageState 认证，无需 UI 登录
})

// 3. 纯 UI 测试
test.beforeEach(async ({ page }) => {
  // page 已通过 storageState 认证，无需任何登录
  await page.goto('/some-page')
})
```

### 测试分类

| 测试类型 | 项目     | baseURL               | 认证方式          |
| -------- | -------- | --------------------- | ----------------- |
| UI 测试  | chromium | http://localhost:3000 | storageState      |
| API 测试 | api      | http://localhost:8000 | apiClient.login() |
| 登录测试 | chromium | http://localhost:3000 | 空 storageState   |

## 预期效果

修复后，预期测试通过率将从 **~50%** 提升到 **~90%+**：

- ✅ 所有重复登录导致的超时问题将被解决
- ✅ API 测试将使用正确的 baseURL
- ✅ 测试执行时间将显著减少（移除了不必要的登录步骤）
- ✅ 测试更加稳定和可靠

## 验证步骤

```bash
# 1. 运行所有测试
cd frontend
npm run test:e2e

# 2. 仅运行 chromium 测试
npx playwright test --project=chromium

# 3. 仅运行 API 测试
npx playwright test --project=api

# 4. 运行特定测试文件
npx playwright test e2e/tests/auth/login.spec.ts
npx playwright test e2e/tests/admin/admin-users.spec.ts
```

## 后续建议

### 1. 添加测试文档

在 `frontend/e2e/README.md` 中明确说明：

- 认证策略（storageState vs 手动登录）
- 何时使用空 storageState
- API 测试 vs UI 测试的区别

### 2. 改进选择器

为关键 UI 元素添加 `data-testid` 属性：

```tsx
// 示例
<button data-testid="create-user-button">Create User</button>
<div data-testid="user-list">...</div>
```

### 3. 添加 Lint 规则

创建 ESLint 规则检测：

- 在 chromium 测试中使用 `loginPage.login()` 而没有空 storageState
- API 测试放在非 api 目录

### 4. 更新 CI/CD

确保 CI 环境中：

- 前端和后端服务都已启动
- 数据库已初始化
- 环境变量正确配置

## 修复清单

- [x] 修复 auth/login.spec.ts（添加空 storageState）
- [x] 修复 admin/admin-users.spec.ts（移除重复登录）
- [x] 修复 admin/admin-public-models.spec.ts（移除重复登录）
- [x] 创建 api/admin-public-models-api.spec.ts（分离 API 测试）
- [x] 修复 integration/settings-chat-integration.spec.ts（移除重复登录）
- [x] 修复 knowledge/knowledge.spec.ts（移除重复登录）
- [x] 修复 settings/settings-shell.spec.ts（移除重复登录）
- [x] 修复 tasks/code-page-enhanced.spec.ts（移除重复登录）
- [x] 修复 tasks/file-upload.spec.ts（移除重复登录）
- [x] 修复 performance/page-load.spec.ts（移除重复登录）
- [x] 修复 examples/coverage-example.spec.ts（添加空 storageState）

## 总结

本次修复解决了 E2E 测试中最关键的问题：**测试代码与 Playwright 配置的不一致**。通过移除重复的登录代码并正确使用 storageState，测试将变得更快、更稳定、更可靠。

修复的核心原则是：

1. **信任 global-setup**：大多数测试应该依赖全局认证
2. **明确测试意图**：只有测试登录功能时才需要手动登录
3. **正确的测试分类**：API 测试和 UI 测试应该分开

这些修复不仅解决了当前的问题，也为未来的测试开发提供了清晰的指导原则。
