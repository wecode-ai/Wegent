# 开源迁移指南

## 概述
本文件记录了从内部版本迁移到开源版本所需的工作

## 修改如下：
### 1. 修改 app/api/api.py 文件
```python
# 删除以下行
import wecode.api
```

### 2. 删除wecode目录
```bash
rm -rf wecode/
```

### 3. 删除内部表
```bash
删除 init.sql 中models表
```