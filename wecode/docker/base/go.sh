## 这个目前没有使用，注意是否有问题
#!/bin/bash

# 设置 Go 二进制包镜像源
export GO_BINARY_BASE_URL="http://mirrors.nevis.sina.com.cn/golang"

# 安装必要的依赖
echo "Installing dependencies..."
yum install -y bison || { echo "Failed to install bison"; exit 1; }
yum clean all && rm -rf /var/cache/yum

# 安装 GVM
echo "Installing GVM..."

export SRC_REPO=https://ci:_BY3b4ZSV7kssC4qzu2p@git.intra.weibo.com/noc-monitor/mirror/gvm.git
bash /tmp/dev-language/gvm-installer.sh || { echo "GVM installation failed"; exit 1; }

# 注释/root/.gvm/scripts/gvm-default中最后一行：". "$GVM_ROOT/scripts/env/cd" && cd ."，默认不覆盖cd命令
sed -i '$ s/^\. "\$GVM_ROOT\/scripts\/env\/cd".*$/# &/' /root/.gvm/scripts/gvm-default

# 加载 GVM 环境
source /root/.gvm/scripts/gvm || { echo "Failed to source GVM"; exit 1; }

# 安装指定版本的 Go
GO_VERSION="go1.23.2"
echo "Installing Go $GO_VERSION..."
gvm install "$GO_VERSION" -B || { echo "Go $GO_VERSION installation failed"; exit 1; }
gvm use "$GO_VERSION" || { echo "Failed to use Go $GO_VERSION"; exit 1; }
yes | gvm use "$GO_VERSION" --default || { echo "Failed to set Go $GO_VERSION as default"; exit 1; }

# 配置 Go 环境变量
echo "Configuring Go environment..."
go env -w GO111MODULE=on || { echo "Failed to set GO111MODULE"; exit 1; }
go env -w GOPROXY=http://mirrors.cloud.aliyuncs.com/goproxy/,https://goproxy.cn,direct || { echo "Failed to set GOPROXY"; exit 1; }

# 安装常用 Go 工具
echo "Installing Go tools..."
go_tools=(
    "github.com/go-delve/delve/cmd/dlv@latest"
    "github.com/cweill/gotests/gotests@v1.6.0"
    "github.com/fatih/gomodifytags@v1.17.0"
    "github.com/josharian/impl@v1.4.0"
    "golang.org/x/tools/gopls@v0.17.0-pre.2"
    "github.com/haya14busa/goplay/cmd/goplay@v1.0.0"
    "honnef.co/go/tools/cmd/staticcheck@latest"
)

for tool in "${go_tools[@]}"; do
    echo "Installing $tool..."
    go install "$tool" || { echo "Failed to install $tool"; exit 1; }
done

echo "Setup completed successfully!"

touch ~/.bashrc
touch /root/.zshrc

# 批量写入配置到 ~/.bashrc 和 ~/.zshrc，避免重复设置
{
    echo 'source ~/.gvm/scripts/gvm'
    echo 'export GOPROXY=http://mirrors.cloud.aliyuncs.com/goproxy/,https://goproxy.cn,direct'
    echo 'export GO111MODULE=on'
    echo 'export GOINSECURE=git.intra.weibo.com,gitlab.weibo.cn'
    echo 'export GONOPROXY=git.intra.weibo.com,gitlab.weibo.cn'
    echo 'export GONOSUMDB=git.intra.weibo.com,gitlab.weibo.cn'
    echo 'export GOPRIVATE=git.intra.weibo.com,gitlab.weibo.cn'
} >> ~/.bashrc

{
    echo 'export GOPROXY=http://mirrors.cloud.aliyuncs.com/goproxy/,https://goproxy.cn,direct'
    echo 'export GO111MODULE=on'
    echo 'export GOINSECURE=git.intra.weibo.com,gitlab.weibo.cn'
    echo 'export GONOPROXY=git.intra.weibo.com,gitlab.weibo.cn'
    echo 'export GONOSUMDB=git.intra.weibo.com,gitlab.weibo.cn'
    echo 'export GOPRIVATE=git.intra.weibo.com,gitlab.weibo.cn'
} >> /root/.zshrc
