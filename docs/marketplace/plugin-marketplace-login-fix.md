# 插件市场登录态依赖修复

## 问题描述

原问题：插件市场页面依赖登录态才能显示，未登录时显示"云端插件市场暂不可用"的空状态。

## 修复目标

1. 插件市场不依赖登录态，未登录也能浏览所有插件
2. 登录后显示哪些插件已安装
3. 未登录时点击安装提示用户前往登录

## 修改文件

### 1. `wework/src/components/plugins/PluginsWorkspace.tsx`

#### 修改 1：`toMarketplaceOptions` 函数（358-371行）
**变更前：** 只在 `cloudAvailable` 为 `true` 时返回云端市场选项
```typescript
const cloudOptions: MarketplaceOption[] = cloudAvailable
  ? [{ key: cloudMarketplaceKey(), id: 'default', name: 'Wegent 云端市场', kind: 'cloud' }]
  : []
return cloudOptions
```

**变更后：** 始终返回云端市场选项
```typescript
// 始终返回云端市场选项，不管是否已登录
// 登录状态只影响是否能看到已安装的插件和是否能安装插件
const cloudOptions: MarketplaceOption[] = [
  { key: cloudMarketplaceKey(), id: 'default', name: 'Wegent 云端市场', kind: 'cloud' }
]
return cloudOptions
```

#### 修改 2：`installMarketplacePlugin` 函数（1064行）
**新增：** 安装前检查登录状态
```typescript
const installMarketplacePlugin = (item: PluginMarketplaceItem) => {
  if (!selectedMarketplace) {
    return
  }

  // 检查是否已登录（未登录时没有 deviceId 或 token）
  if (!cloudToken || !currentDeviceId) {
    const shouldLogin = window.confirm(
      t('workbench.plugins_login_required', '安装插件需要登录 Wegent 账户。是否前往登录？')
    )
    if (shouldLogin) {
      navigateTo('/settings/connections')
    }
    return
  }

  // 原有的安装逻辑...
}
```

#### 修改 3：`PluginMarketplaceRow` 组件（373行）
**新增：** `isLoggedIn` 属性，控制是否显示已安装状态
```typescript
function PluginMarketplaceRow({
  item,
  isLoggedIn,  // 新增
  // ... 其他 props
}: {
  item: PluginMarketplaceItem
  isLoggedIn: boolean  // 新增
  // ...
}) {
  // 只有登录后才显示 installed 状态
  const showInstalledState = isLoggedIn && item.installed
  
  // 更新按钮显示逻辑，使用 showInstalledState 替代 item.installed
  // ...
}
```

#### 修改 4：调用 `PluginMarketplaceRow` 的位置（1950行、1985行）
**新增：** 传递 `isLoggedIn` 属性
```typescript
<PluginMarketplaceRow
  // ... 其他 props
  isLoggedIn={Boolean(cloudToken && currentDeviceId)}
  // ...
/>
```

### 2. `wework/src/i18n/locales/zh-CN/common.json`

**新增翻译：**
```json
"plugins_login_required": "安装插件需要登录 Wegent 账户。是否前往登录？"
```

### 3. `wework/src/i18n/locales/en/common.json`

**新增翻译：**
```json
"plugins_login_required": "Installing plugins requires a Wegent account. Go to login?"
```

## 实现逻辑

### 未登录状态
- ✅ 显示云端市场及所有插件
- ✅ 所有插件显示"+"（安装）按钮
- ✅ 点击安装弹出确认框，提示前往登录
- ✅ 确认后跳转到设置页面的连接配置

### 登录状态
- ✅ 显示云端市场及所有插件
- ✅ 已安装的插件显示"▷"（试用）按钮
- ✅ 未安装的插件显示"+"（安装）按钮
- ✅ 有更新的插件显示刷新图标（更新）按钮
- ✅ 已安装插件在 hover 时显示"..."菜单，可卸载

## 测试检查点

- [ ] 未登录状态下能看到所有插件
- [ ] 未登录状态下点击安装提示登录
- [ ] 登录后能看到已安装的插件状态（▷ 图标）
- [ ] 登录后能正常安装新插件
- [ ] 登录后能正常卸载已安装插件
- [ ] 搜索功能在登录/未登录状态都正常
- [ ] 分类筛选功能正常
- [ ] 刷新市场功能正常

## 注意事项

1. `cloudToken` 和 `currentDeviceId` 是判断登录状态的关键变量
2. 未登录时 API 调用仍然会发送，但不携带 `device_id` 参数
3. 后端需要支持未登录状态下的插件列表查询（不携带 device_id 时返回所有插件但不返回安装状态）
4. 前端通过 `isLoggedIn && item.installed` 的组合来决定是否显示已安装状态

### 4. `backend/app/api/endpoints/installed_plugins.py`

**修改：** `list_marketplace_plugins` 接口（108-126行）
**变更：** 使用 `get_current_user_optional` 替代 `get_current_user`，支持未登录访问

```python
@router.get("/marketplace", response_model=PluginMarketplaceListResponse)
def list_marketplace_plugins(
    q: str | None = None,
    source: str | None = None,
    listing_type: str | None = None,
    device_id: str | None = None,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(security.get_current_user_optional),  # 改为可选
) -> PluginMarketplaceListResponse:
    """List Codex-compatible plugins published to the Wegent marketplace.

    This endpoint supports both authenticated and unauthenticated access:
    - Authenticated users see installation status and device-specific info
    - Unauthenticated users see all available plugins without installation status
    """
    return plugin_marketplace_service.list_plugins(
        db,
        user_id=current_user.id if current_user else None,  # 传递 None 给未登录用户
        query=q,
        source=source,
        listing_type=listing_type,
        device_id=device_id,
    )
```

### 5. `backend/app/services/plugin_marketplace_service.py`

#### 修改 1：`list_plugins` 方法（142-151行）
**变更：** `user_id` 参数改为可选

```python
def list_plugins(
    self,
    db: Session,
    *,
    user_id: int | None,  # 改为可选
    query: str | None = None,
    source: str | None = None,
    listing_type: str | None = None,
    device_id: str | None = None,
) -> PluginMarketplaceListResponse:
```

#### 修改 2：`_can_access_plugin` 方法（1155行）
**变更：** 支持 `user_id=None`，未登录用户只能访问公开插件

```python
def _can_access_plugin(self, db: Session, *, plugin: Plugin, user_id: int | None) -> bool:
    """Apply optional direct-user or department grants to workspace plugins.

    Args:
        db: Database session
        plugin: Plugin to check access for
        user_id: User ID, or None for unauthenticated access

    Returns:
        True if user can access plugin, False otherwise

    Notes:
        - Public plugins are accessible to everyone (including unauthenticated users)
        - Owner can always access their own plugins
        - Workspace plugins with no user_id return False (require authentication)
    """
    # Public plugins are accessible to everyone
    if plugin.visibility == "public":
        return True

    # Unauthenticated users can only access public plugins
    if user_id is None:
        return False

    # Owner can always access their own plugins
    if plugin.owner_user_id == user_id:
        return True
    
    # ... 其他权限检查逻辑
```

## 如何添加插件到市场

插件数据存储在后端数据库中，有以下几种方式添加：

### 方式一：通过前端发布（推荐用于测试）

1. 登录 Wegent 账户
2. 在 wework 中创建本地插件
3. 点击"发布到市场"按钮
4. 插件会上传到云端并出现在市场中

### 方式二：直接插入数据库（开发环境）

如果你想快速添加测试数据，可以直接在 MySQL 数据库的 `plugins` 表中插入记录：

```sql
INSERT INTO plugins (
  name, display_name, slug, owner_user_id, 
  status, visibility, listing_type,
  summary, description_md, 
  latest_release_id, created_at, updated_at
) VALUES (
  'github', 'GitHub', 'github', 1,
  'published', 'public', 'plugin',
  '查看仓库、Issue、Pull Request 和 Actions，并在团队执行变更。',
  '连接到 GitHub 仓库进行代码管理',
  1, NOW(), NOW()
);
```

然后在 `plugin_releases` 表中添加对应的发布记录。

### 方式三：通过 API 发布（生产环境）

使用 `/plugins/submissions/init` 和 `/plugins/submissions/{id}/complete` API 发布插件。

## 后续优化建议

1. 可以考虑在未登录状态下显示一个提示横幅："登录后可查看已安装插件"
2. 可以考虑在插件详情页也添加类似的登录检查
3. 可以优化确认对话框，使用自定义的对话框组件替代 `window.confirm`
4. 添加示例插件数据到数据库，方便开发测试
