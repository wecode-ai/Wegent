# Use the same base image as executor to ensure GLIBC compatibility
# This is critical because wgent-shell runs the executor binary via InitContainer pattern
FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-add-go

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
