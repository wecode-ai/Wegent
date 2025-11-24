# 任务取消机制改进方案

## 概述

本文档描述了对 Wegent 项目任务取消机制的全面改进，解决了原有机制中 SDK 调用与实际执行异步性导致的问题。

## 问题分析

### 原有问题

1. **SDK 调用与实际执行的异步性** - 调用 `client.interrupt()` 只是发送中断信号，但实际的任务循环可能仍在执行
2. **缺少任务执行状态追踪** - 没有明确的标志位来标记任务是否应该继续执行
3. **资源清理不完整** - 取消后可能存在未清理的资源
4. **缺少超时和重试机制** - 如果 SDK 的 `interrupt()` 失败，没有备用方案

## 改进方案

### 核心组件

#### 1. TaskStateManager

文件: `executor/tasks/task_state_manager.py`

功能: 全局状态管理，支持在执行循环中检查

#### 2. ResourceManager

文件: `executor/tasks/resource_manager.py`

功能: 注册和清理资源，防止泄漏

#### 3. CancelHandler

文件: `executor/tasks/cancel_handler.py`

功能: 重试和超时机制

#### 4. StatusSynchronizer

文件: `executor/tasks/status_sync.py`

功能: 状态同步到后端

### 配置参数

文件: `executor/config/config.py`

新增配置:
- CANCEL_TIMEOUT_SECONDS: 取消超时时间（默认30秒）
- CANCEL_RETRY_ATTEMPTS: 重试次数（默认3次）
- CANCEL_RETRY_DELAY: 重试延迟（默认2秒）
- GRACEFUL_SHUTDOWN_TIMEOUT: 优雅关闭超时（默认10秒）

## 使用指南

### 环境变量配置

```bash
export CANCEL_TIMEOUT_SECONDS=30
export CANCEL_RETRY_ATTEMPTS=3
export CANCEL_RETRY_DELAY=2
export GRACEFUL_SHUTDOWN_TIMEOUT=10
```

### 监控指标

1. 取消成功率 (目标: >95%)
2. 取消响应时间 (目标: <10秒)
3. 资源清理成功率 (目标: 100%)
4. 容器强制删除率 (目标: <5%)

## 实施状态

### 已完成
- TaskStateManager 实现
- ResourceManager 实现
- CancelHandler 实现
- StatusSynchronizer 实现
- ClaudeCodeAgent 增强
- 配置文件更新

### 待完成
- DockerExecutor 多层次取消
- 单元测试编写
- 集成测试编写

## 总结

本次改进实现了一个多层次、渐进式的任务取消机制，确保任务最终能被可靠地停止。