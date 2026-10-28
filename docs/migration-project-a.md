# 迁移：用 opencode-dynamic-workflow 取代 project A

本文记录 M5 的迁移过程、每一步的真机证据、以及一次真实回滚演练。所有结论都有命令与输出，不只是「应该能行」。

- 脚本：[`scripts/odw-global.sh`](../scripts/odw-global.sh)（`install` / `rollback` / `status`）
- 目标配置目录：`~/.config/opencode/`（可用 `ODW_GLOBAL_CONFIG_DIR` 覆盖，用于演练）
- 运行时：opencode **2.1.0**，内嵌 Bun **1.4.2**

---

## 1. 迁移前的现状（实测）

| 项 | 值 | 问题 |
|---|---|---|
| 全局配置 `opencode.json` | `"plugin": ["./plugins/odw.mjs"]` | `plugin` 键在 v2 已 deprecated，且指向一个**文件** |
| 全局插件 `plugins/odw.mjs` | 27 行 wrapper，`import "file:///Users/shiwei/Documents/code/open-dynamic-workflows/packages/opencode-plugin/src/index.js"` | project A 的 V1 插件（走 `chat.message` hook） |
| 全局命令 | `commands/{odw,ultracode,workflows}.md` | `odw.md` 正文只有 `workflow: $ARGUMENTS`；`ultracode.md`/`workflows.md` 调用的是 project A 的工具 |
| 外部依赖 | `~/.odw/config.json`（provider key）、`odw-daemon` | ODW **不需要**这些 |

**关键事实：project A 在 2.1.0 上早已失效。** 启动日志稳定报：

```
level=WARN message="configured plugin path must be a directory"
            target=/Users/shiwei/.config/opencode/plugins/odw.mjs
```

也就是说，`odw_ultracode` / `odw_workflows` 这些工具**现在本来就没有生效**；`/odw`、`/ultracode`、`/workflows` 三个命令还能用，仅仅因为它们是 `commands/*.md`，与插件无关。

> **所以迁移是低风险的**：没有一条正在工作的能力会被打断，只是清理一条已经失效的配置。

```
迁移前                                      迁移后
─────────────────────────────────────       ─────────────────────────────────────
opencode.json: plugin: [./plugins/odw.mjs]  opencode.json: (无 plugin 键)
plugins/odw.mjs          ← 失效(WARN)       plugins/odw.mjs.disabled
plugins/                                  → plugins/opencode-dynamic-workflow/index.ts  ← 全局 ODW
commands/{odw,ultracode,workflows}.md       commands/*.md.disabled
（无 /workflow）                          → /workflow（插件注册）+ tools.odw.{ping,plan,run}
```

---

## 2. 迁移步骤

### 2.1 一条命令

```sh
./scripts/odw-global.sh install     # 备份 → 装 shim → 清 plugin 键 → 停用 project A 的插件与命令
./scripts/odw-global.sh status      # 看状态
./scripts/odw-global.sh rollback    # 一键回滚
```

### 2.2 它到底做了什么（顺序是刻意的）

| # | 动作 | 为什么是这个顺序 |
|---|---|---|
| 1 | `opencode.json` → `opencode.json.bak.<ts>` | 与目录里既有的备份习惯一致；回滚靠它 |
| 2 | 写 `plugins/opencode-dynamic-workflow/index.ts`（**目录** + 一行 re-export） | 只有 `<name>/index.ts` 目录形式能被发现（§1 C8）；另外**必须在删 `plugin` 键之前**装好，否则会出现「配置指向不存在的路径」的窗口 |
| 3 | 从 `opencode.json` 删掉 `plugin` 键 | 它是上面那条 WARN 的来源 |
| 4 | `plugins/odw.mjs` → `odw.mjs.disabled`；三个旧命令同样改名 | **改名不删除**；此时配置里已没有指向它的引用 |
| 5 | 写 `.odw-migration.json` 清单 | 回滚要精确知道这次改了什么 |

shim 的内容（本机实际写入）：

```ts
export { default } from "/Users/shiwei/Documents/code/me/opencode-dynamic-workflow/src/index.ts"
```

因为插件是零构建（opencode 内嵌 Bun 直接吃 TS），shim 指到仓库 `src/` 就是全部安装内容——没有编译产物需要同步。

---

## 3. 验收证据（全部真机）

### 3.1 WARN 消失

| | 命令 | 结果 |
|---|---|---|
| 迁移前 | `opencode run --print-logs … \| grep 'must be a directory'` | 1 条（`target=…/plugins/odw.mjs`） |
| 迁移后 | 同上 | **0 条** |

### 3.2 全局插件真的加载，且能跑完整编排

在一个**全新临时项目**里（`git init`，**没有** `.opencode/plugins/`，所以只可能加载全局插件）：

```
INFO msg="loading plugin"
     id=/Users/shiwei/.config/opencode/plugins/opencode-dynamic-workflow
     entrypoint=file:///Users/shiwei/.config/opencode/plugins/opencode-dynamic-workflow/index.ts
```

```
tools.odw.ping() →
{"ok":true,"pluginId":"odw","opencode":"2.1.0","channel":"latest",
 "directory":"/private/var/folders/…/odw-m5-MUJUPe","projectId":"global"}

tools.odw.run({runId:"m5-global", script: <2 worker 的 parallel 扇出>}) →
ODW run m5-global 完成 ✅
- workers: 启动 2，失败 0
- 耗时: 2.2s，花费: $0.0000（32,380 tok）
- 现场: <项目>/.odw/runs/m5-global
- 脚本返回值: a,b
```

这是「全局安装可用」最直接的证据：项目里没有任何 ODW 文件，编排照样跑起来了。

### 3.3 `/workflow` 仍然注册

契约测试的 C17 探针会调 `ctx.command.list()`（`tests/contract/opencode-v2/probe.ts`）。装上全局插件后重跑，命令清单是：

```json
["init","review","gitlab:review_merge_request","gitlab:triage_pipeline_failure",
 "gitlab:triage_vulnerabilities","workflow","odw-probe-cmd","odw-probe-cmd2"]
```

`"workflow"` 在里面——它只能来自全局 ODW（其余项来自 opencode 内置、MCP、以及探针自己）。同时这也证明**全局插件与项目内插件可以共存**：那次运行里全局 ODW 和项目里的 `odw-probe` 同时加载，契约 **55/55 全绿**。

### 3.4 不需要 ODW 自己的 key

整轮验收期间 `~/.odw` **根本不存在**：

```
$ ls -la ~/.odw
ls: /Users/shiwei/.odw: No such file or directory
```

opencode 的 provider 凭据未做任何改动，`$0.0000` 的 run 也照跑。这就是「免 key」的证据。

### 3.5 回滚演练（真机）

```
$ ./scripts/odw-global.sh rollback
已恢复 plugins/odw.mjs
已恢复 commands/odw.md
已恢复 commands/ultracode.md
已恢复 commands/workflows.md
odw-global: 已移除 shim → …/plugins/opencode-dynamic-workflow
odw-global: 已恢复配置 ← opencode.json.bak.20261028-182815

$ shasum -a 256 ~/.config/opencode/opencode.json
5b16291a28b169f68b20c6c727750b094ebf6232580cd72100664e5b6b0fb0b7   ← 与迁移前逐字节相同
$ shasum -a 256 ~/.config/opencode/plugins/odw.mjs
e801631b29ee91226391f1a7f2fba0637a97531fc41ec958c4f720d33e8fa216   ← 与迁移前逐字节相同
```

| 检查 | 结果 |
|---|---|
| `opencode.json` 恢复 | ✅ 与迁移前 sha256 一致 |
| `plugins/odw.mjs` 恢复 | ✅ 与迁移前 sha256 一致 |
| 三个旧命令恢复 | ✅ `ls commands/` 只剩 `odw.md`/`ultracode.md`/`workflows.md` |
| shim 移除 | ✅ `plugins/` 下只剩 `odw.mjs` |
| 运行中的 server 立刻感知 | ✅ 回滚后编辑器会话的工具目录里 `odw` 消失；再 `install` 后又出现 |

演练之后重新 `install`，当前状态：

```
migration  : 已迁移
shim       : export { default } from "…/opencode-dynamic-workflow/src/index.ts"
plugin key : 已清除
legacy     : plugins/odw.mjs / commands/{odw,ultracode,workflows}.md 均已停用
```

---

## 4. 一个真实的坑：`failed to load plugin` 的 ENOENT 突发

**症状**：切开关的瞬间，opencode 日志里会出现一串

```
level=WARN message="failed to load plugin"
  target=/Users/shiwei/.config/opencode/plugins/odw.mjs
  cause="ENOENT: no such file or directory, stat '…/plugins/odw.mjs'"
```

编辑器侧可能弹一次 “plugin failed” 提示。它**不影响功能**（同一时刻 `odw` 工具照常可用、契约 55/55 全绿），但吓人。

**根因**（实测时间线）：

1. opencode 的 server 维护一份「已知插件路径」的注册表，并对配置目录与插件目录做**防抖 reconcile**。
2. 只要某个**曾经被配置引用过的路径**消失（改名/删除），下一次 reconcile 就会对它 `stat()` → ENOENT → WARN。
3. 最初我的 `rollback` 顺序是「先恢复配置，再改回文件」，于是出现了一个**配置已指向 `./plugins/odw.mjs`、而该文件还是 `.disabled`** 的窗口，恰好被 reconcile 撞上 → 一次 18 条的突发。

**修法**：`rollback` 改成

```
① 先改回被改名的文件  →  ② 移除 shim  →  ③ 最后才恢复 opencode.json
```

即与 `install` 完全相反的顺序（`install` 是「先装 shim，后删配置键」）。修完复测：`failed to load plugin … odw.mjs` **零新增**（唯一新增的是一条与本次无关的 `/tmp/does-not-exist-plugin-x`，来自契约探针自己的负向用例）。

**剩余说明（诚实记录）**：`install` 把 `plugins/odw.mjs` 改名这一步，仍会让 server 注册表里那个旧路径在下一次 reconcile 时 ENOENT，产生一小串 WARN。这是 opencode 注册表的行为，不是本插件的问题，且**只在切换的那一次**出现。要彻底消除，只能保留一个同名占位文件——那会违背「旧插件必须真正停用」的意图，所以选择保留 WARN 并记录在此。

---

## 5. 兼容策略与不保留的东西

| 旧名字 | 处置 | 理由 |
|---|---|---|
| `/workflow`（新） | 插件用 `ctx.command.transform` 注册 | 与 project A 无关，从零提供 |
| `/odw`、`/ultracode`、`/workflows` | 改名 `*.md.disabled` 保留 | 不删可回滚；内容全部指向已不存在的 project A 工具，留着只会误导 |
| `odw_ultracode` | **不保留** | 「ultracode 全局开关」意味着每次 prompt 都可能自动起编排，与新设计（执行永远由 `/workflow` 或 `odw_run` 显式触发）冲突 |
| `odw_workflows` | **不保留** | 它读的是 daemon 状态；ODW 的运行记录在 `.odw/runs/<runId>/`，两套状态源必须只留一套 |
| `~/.odw/config.json` | 不迁移 | ODW 不需要 key |

如果你希望保留一个「用 `/workflows` 看最近运行」的入口，最省事的做法是写一个 `~/.config/opencode/commands/workflows.md`，正文让模型读 `<项目>/.odw/runs/` 并汇总——纯 markdown，不依赖任何插件工具。默认没有提供，因为它是可选偏好，不是迁移必需。

---

## 6. 回滚速查

```sh
# 一键回滚（恢复 opencode.json + 把 *.disabled 改回来 + 移除 shim）
./scripts/odw-global.sh rollback

# 手工回滚（等价于上面三步）
cp -p ~/.config/opencode/opencode.json.bak.<ts> ~/.config/opencode/opencode.json
mv ~/.config/opencode/plugins/odw.mjs.disabled ~/.config/opencode/plugins/odw.mjs
for f in odw ultracode workflows; do mv ~/.config/opencode/commands/$f.md.disabled ~/.config/opencode/commands/$f.md; done
rm -rf ~/.config/opencode/plugins/opencode-dynamic-workflow
rm -f ~/.config/opencode/.odw-migration.json
```

回滚后**重启 opencode**（全局配置在 server 启动时读取一次）。
