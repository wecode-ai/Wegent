#!/bin/bash

set -e

GITHUB_REMOTE_URL="https://github.com/wecode-ai/Wegent.git"
ORIGIN_REMOTE_URL="ssh://git@git.intra.weibo.com:2222/weibo_rd/common/wecode/wegent.git"
GITHUB_REMOTE_NAME="github"
ORIGIN_REMOTE_NAME="origin"
TARGET_BRANCH="github_main"

# 检查本地是否有未提交的内容
echo "🔍 Checking for uncommitted changes..."
if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes in your working directory."
    echo ""
    echo "Please commit or stash your changes before running this script:"
    echo "  git status                    # Check what files have changed"
    echo "  git add <files>              # Stage your changes"
    echo "  git commit -m 'message'      # Commit your changes"
    echo "  OR"
    echo "  git stash                    # Temporarily save your changes"
    echo ""
    exit 1
fi

# 检查是否有已暂存但未提交的内容
if ! git diff-index --quiet --cached HEAD --; then
    echo "❌ Error: You have staged changes that are not committed."
    echo ""
    echo "Please commit your staged changes before running this script:"
    echo "  git status                    # Check staged changes"
    echo "  git commit -m 'message'      # Commit your changes"
    echo ""
    exit 1
fi

echo "✅ Working directory is clean"
echo ""
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
# 4. 提交到 origin 的 github_main 分支
echo "📤 Pushing to ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH}..."
git push ${ORIGIN_REMOTE_NAME} ${GITHUB_REMOTE_NAME}/main:${TARGET_BRANCH}

echo "✅ Successfully synced ${GITHUB_REMOTE_NAME}/main to ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH}"
echo ""

# 5. 检查是否可以直接合并到 develop 分支
echo "🔍 Checking if ${TARGET_BRANCH} can be merged into develop..."
git fetch ${ORIGIN_REMOTE_NAME} develop

# 尝试检查合并冲突
MERGE_BASE=$(git merge-base ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH} ${ORIGIN_REMOTE_NAME}/develop)
DEVELOP_HEAD=$(git rev-parse ${ORIGIN_REMOTE_NAME}/develop)

# 首先检查 github_main 是否已经完全合并到 develop（没有新提交）
if git merge-base --is-ancestor ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH} ${ORIGIN_REMOTE_NAME}/develop; then
    echo "✅ ${TARGET_BRANCH} is already fully merged into develop (no new commits)"
    echo "   No merge request needed."
# 检查 develop 是否是 github_main 的祖先（即可以 fast-forward）
elif git merge-base --is-ancestor ${ORIGIN_REMOTE_NAME}/develop ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH}; then
    echo "✅ ${TARGET_BRANCH} can be merged into develop without conflicts (fast-forward possible)"
    echo ""
    echo "📝 Please create a merge request at:"
    echo "   https://git.intra.weibo.com/weibo_rd/common/wecode/wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=github_main"
else
    # 尝试模拟合并以检测冲突
    echo "⚠️  Fast-forward merge not possible, checking for conflicts..."
    
    # 创建临时分支进行测试合并
    TEMP_BRANCH="temp-merge-test-$$"
    git checkout -b ${TEMP_BRANCH} ${ORIGIN_REMOTE_NAME}/develop 2>/dev/null || git checkout ${TEMP_BRANCH}
    
    # 尝试合并，捕获结果
    if git merge --no-commit --no-ff ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH} 2>/dev/null; then
        echo "✅ ${TARGET_BRANCH} can be merged into develop without conflicts"
        git merge --abort 2>/dev/null || true
        git checkout - >/dev/null 2>&1
        git branch -D ${TEMP_BRANCH} >/dev/null 2>&1
        echo ""
        echo "📝 Please create a merge request at:"
        echo "   https://git.intra.weibo.com/weibo_rd/common/wecode/wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=github_main"
    else
        echo "❌ Merge conflicts detected!"
        git merge --abort 2>/dev/null || true
        git checkout - >/dev/null 2>&1
        git branch -D ${TEMP_BRANCH} >/dev/null 2>&1
        
        # 创建新分支用于解决冲突
        CONFLICT_BRANCH="merge-github-main-$(date +%Y%m%d-%H%M%S)"
        echo ""
        echo "🔧 Creating a new branch to resolve conflicts: ${CONFLICT_BRANCH}"
        git checkout -b ${CONFLICT_BRANCH} ${ORIGIN_REMOTE_NAME}/develop
        
        echo "🔀 Attempting to merge ${TARGET_BRANCH} into ${CONFLICT_BRANCH}..."
        if git merge ${ORIGIN_REMOTE_NAME}/${TARGET_BRANCH}; then
            echo "✅ Merge completed successfully (this shouldn't happen, but just in case)"
        else
            echo ""
            echo "⚠️  Merge conflicts need to be resolved manually!"
            echo ""
            echo "📋 Next steps:"
            echo "   1. You are now on branch: ${CONFLICT_BRANCH}"
            echo "   2. Resolve the conflicts in the files listed above"
            echo "   3. After resolving conflicts, run:"
            echo "      git add <resolved-files>"
            echo "      git commit"
            echo "   4. Push the branch and create a merge request:"
            echo "      git push ${ORIGIN_REMOTE_NAME} ${CONFLICT_BRANCH}"
            echo "   5. Create MR at: https://git.intra.weibo.com/weibo_rd/common/wecode/wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=${CONFLICT_BRANCH}"
            exit 1
        fi
    fi
fi

echo ""
echo "Summary:"
echo "  - GitHub remote: ${GITHUB_REMOTE_URL}"
echo "  - Origin remote: ${ORIGIN_REMOTE_URL}"
echo "  - Target branch: ${TARGET_BRANCH}"
