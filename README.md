# dsh-archived-cleanup

**归档会话清理 · Archived cleanup** — 一个 DeepSeek Harness（DSH）插件：列出所有已归档会话，勾选后**永久删除**，删除前自动整份备份，可随时恢复。

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH bundle](https://img.shields.io/badge/DeepSeek%20Harness-bundle-4d6bfe.svg)](https://github.com/Datou1999/dsh-archived-cleanup)

---

## 为什么需要它

在 DSH 里「归档」只是把会话从侧栏藏起来，磁盘上的会话日志、投影缓存一点没少。DSH 本身没有提供删除会话的 API，所以归档会一直堆积。

这个插件补上最后一步：在 **Settings → 归档会话清理** 里看到全部归档会话（标题、工作区、时间、占用空间、当前是否在使用中），勾选 → 二次确认 → 删除。删除是**真的删盘**，但会先把这些会话完整复制到 `~/.dsh/cleanup-backups/cleanup-backup-<时间戳>/`，附 `manifest.json` 与当时的 `workspace.json`，随时可以手工还原。

## 功能

- **只处理已归档会话**：只允许删除当前在 `archivedSessionIds` 里的 id，普通会话不会出现在列表里。
- **多选 + 全选 + 搜索**：按工作区分组，显示标题、更新时间、占用大小；实时统计选中数量与可释放空间。
- **占用空间来自真实文件**：Host 半扫描会话目录，给出每个会话的字节数与文件数，而不是估算。
- **级联删除子会话**：选中一个归档会话时，挂在它下面的 subagent 会话会一并删除（列表里以「N 个子会话」标注）。
- **在用会话拒绝删除**：正在加载/运行的会话会被跳过并给出原因，避免删掉你正在看的对话。
- **删除前整份备份**：备份失败则整个请求中止，**一个字节都不删**。
- **可回滚**：备份目录里有完整会话文件与 `workspace.json` 快照，按下面的「恢复」一节操作即可还原。
- **备份文件夹入口**：工具栏「打开备份文件夹」直接在系统文件管理器里打开备份根目录，每条备份右侧可单独定位。
- 中英文界面（跟随浏览器语言），设置页与侧栏一样使用 DSH 主题 token，明暗主题自动适配。

## 安装

> 要求：DeepSeek Harness Desktop，且 profile 里已启用 `@deepseek-ai/dsh-web-app`。

1. 克隆本仓库到本地：
   ```bash
   git clone https://github.com/Datou1999/dsh-archived-cleanup.git
   ```
2. 打开 DSH Web GUI → **Settings → Plugins → Add plugin**。
3. 填入克隆目录的**绝对路径**（用正斜杠），例如：
   ```
   C:/Users/you/Documents/dsh-archived-cleanup
   ```
4. 安装后设置页左侧出现 **归档会话清理 / Archived cleanup**。Host 半的新路由需要重启一次桌面应用（插件代码在 `node_modules` 下，不参与热重载），客户端在刷新页面后生效。

卸载：在 **Settings → Plugins** 里移除该 bundle，再刷新。

## 使用

1. 先在侧栏把不想保留的会话归档（右键 → 归档）。
2. 打开 **Settings → 归档会话清理**。
3. 勾选要删除的会话（或点全选），底部会显示「将删除 N 个会话，释放 X」。
4. 点 **永久删除所选…**，在确认框里核对列表后确认。
5. 删除完成后页面会显示结果与本次备份目录；需要时点「打开备份文件夹」。

### 恢复

备份结构：

```
cleanup-backup-2026-11-24T07-40-12/
├── manifest.json                 # 本次删除了哪些 id、大小、时间、原因
├── workspace.json                # 删除前的注册表快照
├── sessions/<project-key>/<id>/  # 完整会话目录
└── session_projcache/<id>.json   # 投影缓存
```

恢复一个会话：

1. 先把 DSH 桌面应用**退出**（避免注册表被覆盖）。
2. 把 `sessions/<project-key>/<id>/` 复制回 `~/.dsh/sessions/<project-key>/<id>/`。
3. 把 `session_projcache/<id>.json` 复制回 `~/.dsh/storages/session_projcache/<id>.json`（没有就跳过）。
4. 若希望它重新出现在侧栏，把它从 `workspace.json` 的 `global.archivedSessionIds` 里移除，或直接把备份里的 `workspace.json` 覆盖回去。
5. 重新启动应用。

## 工作原理

归档集合是 `workspaceRegistry.archivedSessionIds`，会话数据在：

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/sessions/<project-key>/<session-id>/session.v4.jsonl.zstd` | 会话日志（唯一真相） |
| `~/.dsh/storages/session_projcache/<session-id>.json` | 投影缓存 |
| `~/.dsh/storages/workspace.json` | 工作区与归档/置顶集合 |

DSH 没有删除会话的公开 API，因此删除由插件自己完成，顺序是：

1. **规划**：校验 id 是否在归档集合里、是否在用、目录是否落在 `sessions` 根内，算出字节数与文件数。
2. **备份**：把每个会话目录与投影缓存复制到 `cleanup-backups/`，写入 `manifest.json` 并复制 `workspace.json`；任一步失败即中止。
3. **删除**：`rm -rf` 会话目录、投影缓存文件。
4. **清理注册表**：`workspace.detachSession(id)` + `workspaceRegistry.unarchiveSession(id)`（两者幂等，且不校验会话是否存在）。

搜索索引（`dsh-session-query-sqlite`）是派生数据，会在下次会话列表/搜索时按磁盘实际内容自愈，不需要手动清理。子会话通过 `sessionQuery.listSessions()` 的 `header.parentSession` 链展开。

## 接口

设置页通过 HTTP 调 Host 半，路由同时注册在两种传输上（浏览器 `webServer` 与 Desktop IPC `connection.fetch`），并统一走 DSH 的浏览器围栏（`connection.requestRejection`，无 connection 时 fail-closed）。

| 路由 | 说明 |
| --- | --- |
| `GET /archived-cleanup/info` | 归档集合、每会话字节/文件数与状态、最近备份 |
| `POST /archived-cleanup/delete` | `{ targets: [{ sessionId, cwd? }], dryRun? }`；`dryRun` 只返回计划 |
| `POST /archived-cleanup/reveal` | `{ name? }` 打开备份根目录或某个备份；只接受备份根内的目录 |
| `GET /archived-cleanup/backup-hash` | 当前 `workspace.json` 的 sha256 |

## 开发

纯 ESM，无构建步骤，无运行时依赖；`client.js` 是经典脚本，通过 `window.__ModuleLoader__.load` 注册，React 由宿主提供。

```bash
node --check index.js && node --check client.js
node -e "0" && node tools/selftest.mjs      # Host 半：fixture 仓储，绝不碰真实 ~/.dsh
node tools/client-smoke.mjs                 # 客户端：假 DOM 渲染设置页
node tools/route-smoke.mjs                  # 真实 HTTP 往返（含围栏、dryRun、幂等、reveal）
```

三套测试都用 `mkdtemp` 造临时 `$DSH_HOME`，不会读写你的真实会话。

```
index.js            Host 入口（apply + 路由注册）
lib/paths.js        存储布局、id 编码、备份/删除原语
lib/cleanup.js      规划与执行（备份 → 删除 → 清理注册表）
lib/routes.js       /archived-cleanup/* 路由、双传输适配、浏览器围栏
lib/shell.js        在系统文件管理器中打开备份目录
lib/context.js      ctx.get 安全的服务获取与日志
client.js           设置页 UI
tools/*.mjs         三套测试
```

## 安全边界

- 只会删除**归档集合内**的会话；未归档、在用、目录不存在、路径越界的一律跳过并给出原因。
- 只会打开 **`$DSH_HOME/cleanup-backups` 内**由本插件创建的目录；`..`、绝对路径、任意名字一律 400。
- 删除是用户显式操作：需要勾选 + 二次确认，且没有任何自动/定时删除。
- 所有请求经过浏览器围栏：跨站、`Origin` 与 `Host` 不一致、非回环地址一律 401/403。

## License

[MIT](LICENSE) © 2026 Datou1999

---

## English

A DeepSeek Harness bundle that lists archived Sessions and permanently deletes the ones
you select — after a verified, complete backup.

Archiving in DSH only hides a Session from the sidebar; the Harness has no delete API.
This bundle's Host half removes the session directory and projection cache itself, then
clears the registry state, always after copying everything under
`~/.dsh/cleanup-backups/cleanup-backup-<timestamp>/`.

- Only ids currently in `archivedSessionIds` are eligible.
- Live Sessions, unarchived ids, missing directories and paths outside the sessions root
  are skipped with a reason; subagent children follow their parent.
- A failed backup aborts the request before anything is deleted.
- Install: clone, then **Settings → Plugins → Add plugin** with the absolute clone path.
  Restart the app once for the Host routes; the client half activates on refresh.
