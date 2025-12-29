FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-update-executor-base-image

# Install Python development tools for git hooks (ai-push-gate.sh)
# These tools are required for pre-push quality checks:
# - black: Python code formatter
# - isort: Python import sorter
# - pytest: Python testing framework
RUN pip install --no-cache-dir \
    black \
    isort \
    pytest \
    pytest-cov \
    pytest-asyncio \
    uv
