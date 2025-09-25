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


### 3. 删除init.sql 中初始化数据
```bash
删除 agents 和 models 表初始化数据
```