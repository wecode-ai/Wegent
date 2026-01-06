# Use the same base image as executor to ensure GLIBC compatibility
# This is critical because wgent-shell runs the executor binary via InitContainer pattern
FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-add-go

# Configure npm registry to use China mirror for faster dependency downloads
# This only affects download speed, does NOT modify package-lock.json resolved URLs
RUN npm config set registry https://registry.npmmirror.com

# Configure pip and uv to use China mirror for faster Python package downloads
# This only affects download speed, does NOT modify lock files (uv.lock, requirements.txt)
RUN pip config set global.index-url http://mirrors.cloud.aliyuncs.com/pypi/simple/ && \
    pip config set install.trusted-host mirrors.cloud.aliyuncs.com && \
    mkdir -p /root/.config/uv && \
    echo 'index-url = "http://mirrors.cloud.aliyuncs.com/pypi/simple/"' > /root/.config/uv/uv.toml

# Install Python development tools for git hooks (ai-push-gate.sh)
# These tools are required for pre-push quality checks:
# - black: Python code formatter
# - isort: Python import sorter
# - pytest: Python testing framework
# - uv: Python package manager
RUN pip install --no-cache-dir \
    black \
    isort \
    pytest \
    pytest-cov \
    pytest-asyncio \
    uv
