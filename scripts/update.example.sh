#!/usr/bin/env bash
# update.example.sh — sync pi-mono with upstream and rebase private branches
#
# This file is tracked as a template.
#
# Setup (local):
#   cp scripts/update.example.sh scripts/update.sh
#   chmod +x scripts/update.sh
#
# Usage:
#   ./scripts/update.sh
#
# What it does:
#   1. Pull upstream (badlogic/pi-mono) into main via rebase
#   2. Push updated main to fork (Eleiris-AI/pi-mono)
#   3. Rebase private branches onto updated main
#   4. Push private branches to Eleiris-AI fork
#   5. Rebuild all packages
#   6. Return to original branch

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_BRANCHES=(
    "eleiris/mom-adapters"
    # Add more private branches here as needed:
    # "eleiris/my-other-feature"
)

cd "$REPO_ROOT"

# Auto-reset generated files that often drift locally
AUTO_RESET_FILES=(
    "packages/ai/src/models.generated.ts"
)

for file in "${AUTO_RESET_FILES[@]}"; do
    if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
        git checkout HEAD -- "$file"
    fi
done

# Abort if working tree is dirty
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: working tree has uncommitted changes, commit or stash first"
    exit 1
fi

ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "--- pulling upstream (origin/main) ---"
git checkout main
git pull --rebase origin main

echo ""
echo "--- syncing fork (eleiris/main) ---"
if git remote get-url eleiris >/dev/null 2>&1; then
    git push eleiris main
else
    echo "error: remote 'eleiris' not found"
    exit 1
fi

echo ""
echo "--- rebasing private branches ---"
for branch in "${PRIVATE_BRANCHES[@]}"; do
    if git rev-parse --verify "$branch" &>/dev/null; then
        echo "  rebasing $branch onto main..."
        git rebase main "$branch"
        echo "  pushing $branch to eleiris..."
        git push eleiris "$branch" --force-with-lease
        echo "  done: $branch"
    else
        echo "  skipping $branch (branch not found)"
    fi
done

echo ""
echo "--- rebuilding packages ---"
npm run build

echo ""
echo "--- restoring branch: $ORIGINAL_BRANCH ---"
git checkout "$ORIGINAL_BRANCH"

echo ""
echo "done"
