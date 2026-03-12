#!/bin/bash

# 定义需要释放的端口列表
PORTS=(8000 8100 8001)

# 脚本标题
echo "====================================="
echo "  端口占用进程清理脚本"
echo "====================================="
echo

# 第一步：显示每个端口的占用情况
for port in "${PORTS[@]}"; do
    echo "🔍 正在查询端口 $port 的占用情况："
    lsof -i ":$port"
    if [ $? -ne 0 ]; then
        echo "   端口 $port 未被占用"
    fi
    echo "-------------------------------------"
done

# 第二步：确认是否执行终止操作
read -p "❓ 是否要终止以上占用 8000/8100/8001 端口的进程？(y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "🚫 操作已取消"
    exit 0
fi

# 第三步：终止占用端口的进程
echo
echo "🗑️  开始终止占用进程..."
for port in "${PORTS[@]}"; do
    # 查找端口对应的 PID 并强制终止
    PIDS=$(lsof -ti ":$port")
    if [ -n "$PIDS" ]; then
        echo "   终止端口 $port 的进程(PID: $PIDS)..."
        kill -9 $PIDS
        echo "   ✅ 端口 $port 进程已终止"
    else
        echo "   ℹ️  端口 $port 无占用进程，无需终止"
    fi
done

# 第四步：验证结果
echo
echo "✅ 验证端口释放情况："
for port in "${PORTS[@]}"; do
    if lsof -i ":$port" > /dev/null; then
        echo "   ❌ 端口 $port 仍被占用"
    else
        echo "   ✅ 端口 $port 已成功释放"
    fi
done

echo
echo "🎉 脚本执行完成！"
