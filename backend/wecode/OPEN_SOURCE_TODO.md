# 开源迁移指南

## 概述
本文件记录了从内部版本迁移到开源版本所需的工作

## 修改如下：
### 1. 修改 app/api/api.py 文件
```python
# 分别删除以下行
from wecode.api import internal_router
api_router.include_router(internal_router)
```

### 2. 修改 app/api/endpoints/users.py 文件
**修改内容**：删除内部装饰器导入
```python
# 分别删除以下行
from wecode.api.users_patch import patch_user_endpoint, patch_update_user_endpoint, patch_create_user_endpoint
@patch_user_endpoint
@patch_update_user_endpoint
@patch_create_user_endpoint
```

### 3. 删除wecode目录
```bash
rm -rf wecode/
```
