#!/usr/bin/env python3
"""Summarize upstream commits relevant to the Span integration."""

import json
import re
import sys
from pathlib import Path


GROUPS = (
    ("权限、沙箱与执行", r"approv|sandbox|permission|exec.server|seccomp|bwrap|security"),
    ("协议、会话与历史", r"app.server|json.rpc|protocol|thread|session|rollout|history|compac"),
    ("模型、流式事件与工具", r"provider|responses api|stream|tool.call|diff|mcp|usage"),
)


def main(baseline, latest, path):
    pages = json.loads(Path(path).read_text())
    commits = [commit for page in pages for commit in page["commits"]]
    expected = pages[0]["total_commits"]
    if len(commits) != expected:
        raise SystemExit(f"GitHub returned {len(commits)} of {expected} commits")
    comparison = f"https://github.com/openai/codex/compare/{baseline}...{latest}"
    print(f"上游新增 {len(commits)} 个提交。[完整比较]({comparison})")
    print("\n按提交标题初筛。准备更新时，核对协议字段和 EL8 回归结果。")
    buckets = {label: [] for label, _ in GROUPS}
    for commit in commits:
        title = commit["commit"]["message"].splitlines()[0]
        for label, pattern in GROUPS:
            if re.search(pattern, title, re.IGNORECASE):
                buckets[label].append((commit["sha"], title))
                break
    for label, entries in buckets.items():
        print(f"\n### {label}（{len(entries)} 项）\n")
        for sha, title in entries[:20]:
            safe_title = re.sub(r"([\\\x60*_[\]<>])", r"\\\1", title)
            print(f"- [`{sha[:8]}`](https://github.com/openai/codex/commit/{sha}) {safe_title}")
        if len(entries) > 20:
            print(f"- 其余 {len(entries) - 20} 项见完整比较。")
    print("\n升级基线前验证：连接模型、提交审批、渲染 diff、持久化与续聊。")


if __name__ == "__main__":
    main(*sys.argv[1:])
