#!/bin/bash

set -e

GITHUB_REMOTE_URL="https://github.com/wecode-ai/Wegent.git"
ORIGIN_REMOTE_URL="ssh://git@git.intra.weibo.com:2222/weibo_rd/common/wecode/wegent.git"
GITHUB_REMOTE_NAME="github"
ORIGIN_REMOTE_NAME="origin"
TARGET_BRANCH="github_main"

echo "🔍 Checking git remote configuration..."

# 1. 检查并添加 github remote
if git remote | grep -q "^${GITHUB_REMOTE_NAME}$"; then
    echo "✅ Remote '${GITHUB_REMOTE_NAME}' already exists"
    current_github_url=$(git remote get-url ${GITHUB_REMOTE_NAME})
    if [ "$current_github_url" != "$GITHUB_REMOTE_URL" ]; then
        echo "⚠️  Updating github remote URL from $current_github_url to $GITHUB_REMOTE_URL"
        git remote set-url ${GITHUB_REMOTE_NAME} ${GITHUB_REMOTE_URL}
    fi
else
    echo "➕ Adding remote '${GITHUB_REMOTE_NAME}': ${GITHUB_REMOTE_URL}"
    git remote add ${GITHUB_REMOTE_NAME} ${GITHUB_REMOTE_URL}
fi

# 2. 检查并更新 origin remote
current_origin_url=$(git remote get-url ${ORIGIN_REMOTE_NAME})
if [[ ! "$current_origin_url" =~ git\.intra\.weibo\.com ]]; then
    echo "⚠️  Origin remote is not pointing to git.intra.weibo.com, updating..."
    git remote set-url ${ORIGIN_REMOTE_NAME} ${ORIGIN_REMOTE_URL}
    echo "✅ Origin remote updated to: ${ORIGIN_REMOTE_URL}"
elif [ "$current_origin_url" != "$ORIGIN_REMOTE_URL" ]; then
    echo "⚠️  Updating origin remote URL to: ${ORIGIN_REMOTE_URL}"
    git remote set-url ${ORIGIN_REMOTE_NAME} ${ORIGIN_REMOTE_URL}
else
    echo "✅ Origin remote is correctly configured"
fi

# 3. Fetch github/main 最新代码
echo "📥 Fetching latest code from ${GITHUB_REMOTE_NAME}/main..."
git fetch ${GITHUB_REMOTE_NAME} main

# 4. 提交到 origin 的 github_main 分支
echo "📤 Pushing to ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH}..."
git push ${ORIGIN_REMOTE_NAME} ${GITHUB_REMOTE_NAME}/main:${TARGET_BRANCH} 

echo "✅ Successfully synced ${GITHUB_REMOTE_NAME}/main to ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH}"
echo ""
echo "Summary:"
echo "  - GitHub remote: ${GITHUB_REMOTE_URL}"
echo "  - Origin remote: ${ORIGIN_REMOTE_URL}"
echo "  - Target branch: ${TARGET_BRANCH}"
