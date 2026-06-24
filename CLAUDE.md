@AGENTS.md

## Git Remotes

| Remote | URL | 用途 |
|--------|-----|------|
| origin | zhangqinzhong/orca | 公开 fork，只给上游提 PR 用 |
| upstream | stablyai/orca | 跟踪上游更新 |
| mllo | zhangqinzhong/mllo | **私有仓库，日常修改推到这里** |

## 工作流

```
日常开发:
  切分支 → 修改 → git push mllo <分支>

同步上游:
  git fetch upstream && git merge upstream/main && git push mllo main

给上游提 PR:
  git fetch upstream && git checkout -b fix/xxx upstream/main
  修改 → git push origin fix/xxx → GitHub 创建 PR
```

**自己的修改只推到 mllo，不要推到 origin。**
