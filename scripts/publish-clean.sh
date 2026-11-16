#!/usr/bin/env bash
# 把当前工作区打成一个「干净的单提交」分支，供公开仓库使用。
#
# 为什么不用 git push 直接推 main：历史提交里有过令牌、域名、服务器 IP，
# 推上去等于把这些一起公开。这个脚本用临时 index 造一棵新树、一个新提交，
# 不动你的工作区、不动 HEAD、不改 main 的任何提交。
#
# 用法：
#   bash scripts/publish-clean.sh            # 生成/更新 publish-clean 分支
#   然后：  git push <你的仓库> publish-clean:main
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先提交再发布（否则会漏掉内容）。" >&2
  exit 1
fi

node scripts/scrub-check.mjs

tmp_index="$(mktemp -u)"
export GIT_INDEX_FILE="$tmp_index"
git read-tree --empty
git add -A
tree="$(git write-tree)"
commit="$(git commit-tree "$tree" -m "DSH Phone：手机通道 + 摄像头与直播（干净快照）")"
unset GIT_INDEX_FILE
rm -f "$tmp_index"

git update-ref refs/heads/publish-clean "$commit"
echo "已生成 publish-clean -> $commit"
echo "确认无误后：git push <你的仓库> publish-clean:main"
