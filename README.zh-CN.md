# opencode-dynamic-workflow (ODW)

[English](README.md) · [简体中文](README.zh-CN.md)

**把「动态工作流」做进 opencode v2 的一等公民**：模型写一个受约束的脚本，插件确定性地执行它，每个 worker 都是宿主 opencode 的一个真子会话。

它只为一类活存在：**对 N 个对象做同一件事**、**扇出后汇总**、**循环到通过为止**。在一个会话里逐轮做，既慢、又严格串行、又不可复现。写成脚本之后，并发、预算、取消、以及「到底发生了什么」的记录，就都由插件来管。

**ODW 自己不需要任何 API key。** 所有模型调用都发生在宿主 opencode 的子会话里，用的是你已经在用的登录态和 provider 凭据。

```
模型                     插件（本仓库）                          宿主 opencode
 │                            │                                       │
 │ ① odw_plan（免费 dry run）  │                                       │
 ├───────────────────────────►│ 编译脚本 + 按「活体清单」校验字面量参数  │
 │                            │（agent/model/effort/mode/permissions） │
 │ ② odw_run(script)          │                                       │
 ├───────────────────────────►│ 归一化 → node:vm 沙箱                  │
 │                            │   └─ 执行 async (ctx) => {...}         │
 │                            │        ├─ ctx.agent      ──────────────┼─► session.create(parentID)
 │                            │        ├─ ctx.parallel   ──────────────┼─►   + prompt + wait
 │                            │        ├─ ctx.pipeline                  │     （真子会话，工具齐全）
 │                            │        ├─ ctx.loop / verify / …         │
 │                            │        └─ 结构化错误 → 交回模型，由模型决定重试
 │ ③ 读 result.json           │                                       │
 │   / journal.jsonl          │                                       │
 │◄───────────────────────────┤                                       │
```

---

## 安装

前置：opencode v2（它用内嵌 Bun 直接加载 TypeScript），以及 `PATH` 里有 `node`。ODW 的运行时依赖为 **0**。

### 全局安装（推荐）

```sh
curl -fsSL https://raw.githubusercontent.com/wishflow/opencode-dynamic-workflow/main/scripts/odw-install.sh | sh -s -- --global
```

或者在本地检出里跑（用本地文件而不是下载）：

```sh
./scripts/odw-install.sh install --global
```

插件本身走 opencode 自己的安装器进入配置（`opencode plugin add github:wishflow/opencode-dynamic-workflow`），这样它在配置里就是 opencode 期望的形式，包也会被立刻拉下来。脚本在它外面包了这些：

| # | 动作 | 为什么是这个顺序 |
|---|---|---|
| 0 | 先写清单 `~/.config/opencode/.odw-migration.json` | **最先**，在任何改动之前，所以中途失败也还有一个能用的 `rollback` |
| 1 | 备份 `opencode.json` → `opencode.json.bak.<ts>` | 回滚需要逐字节精确的旧内容 |
| 2 | 清理遗留的 **project A** 安装：删掉 deprecated 的 `plugin` 键，把 `plugins/odw.mjs` 和 `commands/{odw,ultracode,workflows}.md` 改名成 `*.disabled` | 只改名、不删除；先改配置，再让文件失去引用 |
| 3 | `opencode plugin add <spec>`（自动重试一次） | 它自己会改配置；重试不是防御性噪声，见下面的实测 |
| 4 | 最后写 skill `~/.config/opencode/skills/odw/SKILL.md` | 执行器就位之后，触发面才出现 |

然后**重启 opencode**（配置与插件在 server 启动时读取），并检查：

```sh
opencode plugin list          # 应出现一行：odw  <commit>  github:wishflow/opencode-dynamic-workflow
```

> 第 3 步的重试有实测依据：观察到的 3 次里，`opencode plugin add` 有 2 次首跑失败，报的是瞬时 registry 错误（`No matching version found for @redis/json@6.3.1`、`Error: aborted`），紧接着重试就成功。

### 只装在某个项目里

```sh
./scripts/odw-install.sh install --local
```

opencode 的 CLI 只会改**全局**配置，所以 `--local` 由脚本自己写项目的 `opencode.json`（合并进 `plugins`，绝不覆盖其它键），并把 skill 放到 `<项目>/.opencode/skills/odw/SKILL.md`。它**不预装依赖**：opencode 下次启动时会在后台装包（首次约 2.5 分钟，期间插件不可用）。

```jsonc
// <项目>/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:wishflow/opencode-dynamic-workflow"]
}
```

`opencode plugin list` 只反映**全局**配置，所以项目级安装要靠启动日志验证（`msg="loading plugin" ... entrypoint=...`）。

---

## 运维

```sh
./scripts/odw-install.sh status    [--global|--local]   # 装了什么、是否仍然一致
./scripts/odw-install.sh update    [--global|--local]   # 刷新插件与 skill
./scripts/odw-install.sh rollback  [--global|--local]   # 撤销，回到之前的字节
```

`status` 输出：作用域、配置/skill/清单的路径、插件 spec 是否在册、skill 是否仍与安装时记录的摘要一致、有没有遗留安装没清掉。不带 `--local` 时，它还会告诉你当前项目里有没有本地安装。

`update` 刷新 skill，并尽力跑一次 `opencode plugin update`（那条命令需要能连上 opencode 服务；失败只会给一条警告，不算更新失败）。

`rollback` 的顺序是**先恢复文件、最后恢复配置**。这个顺序是刻意的：先恢复配置会开出一个「配置指向一个尚不存在的插件文件」的窗口，opencode 的插件注册表 reconcile 撞上会刷一串 `failed to load plugin ... ENOENT`。

`--ref <ref>` 把下载固定到某个分支/标签，而不是 `main`。

---

## 从旧插件（project A）迁移

安装脚本就会做这次迁移；上表就是它做的事。要点：

| 旧 | 新 | 为什么 |
|---|---|---|
| `opencode.json` 的 `"plugin": ["./plugins/odw.mjs"]` | 删掉 `plugin` 键，改用 `plugins: ["github:wishflow/..."]` | `plugin` 键在 v2 已 deprecated，**而且**它指向一个*文件*；只有 `<名字>/index.ts` 这种*目录*形式才会被发现。旧键也是启动 `WARN must be a directory` 的来源 |
| `plugins/odw.mjs`（V1 wrapper） | 改名 `odw.mjs.disabled` | 留在盘上供 `rollback` 恢复；已经没有东西引用它 |
| `commands/{odw,ultracode,workflows}.md` | 改名 `*.disabled` | `/odw` 正文只有 `workflow: $ARGUMENTS`；`ultracode`/`workflows` 调用的是已不存在的工具。`/workflow` 由本插件重新注册 |
| `odw_ultracode` | **不保留** | 「ultracode 全局开关」意味着每次 prompt 都可能悄悄起编排，与新设计（执行永远显式：`/workflow` 或 `odw_run`）冲突 |
| `odw_workflows` | **不保留** | 它读的是 daemon 状态；ODW 的记录在 `.odw/runs/<runId>/`，两套状态源必须只留一套 |
| `~/.odw/config.json`、`odw-daemon` | 不需要 | ODW 不需要 key，也不跑 daemon |

如果**先装过旧插件**，它自己的清单还留在盘上（`~/.config/opencode/.odw-migration.json`，旧格式），新 `install` 会直接拒绝而不是瞎猜：

```text
odw-install: already installed (/Users/you/.config/opencode/.odw-migration.json). Run rollback first, or delete the manifest and reinstall.
```

这条拒绝是刻意的——脚本不会覆盖自己不认识的清单。要么先用旧脚本 `rollback`，要么把那个文件挪开再装。`install` 发现自己**本版本**的清单时同样拒绝，理由相同。

---

## 触发是怎么发生的

**触发面是一个 skill 文件，不是往 prompt 里注入东西。** ODW 随仓库带 `skills/odw/SKILL.md`，安装器把它复制到 opencode 会发现 skill 的位置（全局 `~/.config/opencode/skills/odw/SKILL.md`，项目级 `<项目>/.opencode/skills/odw/SKILL.md`）。opencode 把它的 `description` 摆给模型，模型在任务匹配时再去加载正文：

```md
---
name: odw
description: 把任务扇出给多个并发子会话（fan-out / 并行子 agent / 多步流水线 / 循环到通过）并汇总产物；单步任务、或仅在讨论机制时不用。
---
```

（skill 的正文是英文，只有这句 description 是中文。）

几个值得知道的设计后果：

- 插件**不注册任何 prompt hook**，不改写你输入的任何东西 —— 模型看到的就是你发的内容，加上 opencode 摆给它的 skill 清单；
- 没有任何东西会自动执行：skill 的终点是调 `odw_plan` / `odw_run`，而这两个都是普通工具，只有模型（或你）调用时才做事；
- **何时**用 ODW 在 description 里，**怎么**驱动它在正文里，两者都在同一个文件里，可以像读源码一样被 review；
- description 是中文、正文是英文，但机制里**没有任何词表**，判断全交给模型。2026-10-29 实测：同一个扇出型任务用英文、日文、韩文分别叙述，三次都自动加载了 skill 并跑出真实结果（`status: "ok"`）。

---

## 用法

### `/workflow <任务>`

人工入口。它**自己不执行任何东西**：把任务交给模型，并要求模型先加载 `odw` skill、先 `odw_plan`（免费 dry run）、再 `odw_run`。执行的代码路径只有一条 —— 工具 —— 所以创建 worker 的地方也只有一处。

```
/workflow 核查 workflows/ 下每个脚本的头部注释是否与实现一致
```

> 实测限制：`opencode run "/workflow x"` **不会**派发命令，它把整串当普通 user prompt 发出去。命令只能从 TUI 或 `session.command` 进入；无头场景请直接调 `odw_run`。

### 工具（Code Mode）

| 工具 | Code Mode 路径 | 调模型 | 作用 |
|---|---|:--:|---|
| plan | `tools.odw.plan` | **否** | 编译脚本 + 按活体清单校验字面量参数，报告「将要跑什么」 |
| run | `tools.odw.run` | 是（只在脚本内） | 真跑脚本 |
| ping | `tools.odw.ping` | 否 | 存活自检 |

```js
// tools.odw.run
{ script: 'async (ctx) => {...}' }   // 内联源码
{ file: "audit.ts" }                 // 相对 <项目>/workflows/ 解析
// 可选：runId / concurrency（默认 4，上限 10）/ timeoutMs（默认 600000）
//       / budgetUsd / maxWorkers（默认 50）
```

### 脚本里能用的东西

沙箱里**有且只有** `ctx`：

| 原语 | 作用 |
|---|---|
| `ctx.agent(o)` | 起一个真子会话，发 prompt，等它结束，返回文本（给了 `schema` 就返回解析后的对象） |
| `ctx.parallel(items, fn, {concurrency?})` | 有界并发扇出，结果**按输入顺序**返回 |
| `ctx.pipeline(items, ...stages)` | `parallel` + 每个 item 顺序过一条 stage 链，stage 收到上一级的返回值 |
| `ctx.loop({max, body, until?, initial?})` | 迭代；`max` 必填，`until` 成立即停；返回 `{iterations, state, stopped}` |
| `ctx.verify(claim \| o)` | 只读 worker 做**对抗性复核**，返回 `{pass, reasons}`，无法确认即 `pass: false` |
| `ctx.checkpoint(label, data?)` | 落一个持久标记（journal + `checkpoints/` 下的文件） |
| `ctx.abort(reason?)` | 主动终止本次运行 |
| `ctx.phase(name)` / `ctx.log(...)` | 进度与日志 |
| `ctx.budget()` | 目前花了多少 |

`ctx.agent` 的完整选项：

```ts
{
  prompt: string             // 必填、非空
  label?: string             // 进度、journal、子会话标题里用
  agent?: string             // opencode agent id，如 "explore" | "build"
  model?: string             // "provider/model" 或 "provider/model#variant"
  effort?: string            // 继承模型 #variant 的语法糖；不能与 model 同时给
  mode?: "agentic" | "oneshot"   // oneshot = 拒绝全部工具
  permissions?: "inherit" | "read-only" | "dangerous-full-access" | Permission[]
  schema?: object            // JSON Schema；回复按 JSON 解析
  timeoutMs?: number         // 单个 worker 的墙钟
}
```

**没有自动重试。** worker 失败就抛错，脚本随之中止；工具把结构化错误（`kind` + `message` + 现场目录）交回模型，由模型改脚本重跑。要重试就自己用 `ctx.loop` 写。

---

## 能力围栏（请当真读）

脚本跑在 `node:vm` 里，注入的白名单**只有** `ctx` 和一个被重定向的 `console`。

| 沙箱里**没有** | 也就是说 |
|---|---|
| `require` / `import` / 动态 `import()` | 脚本无法加载任何模块 |
| `process` / `fs` / `path` / `os` | 脚本无法读环境变量、无法读写文件、无法起子进程 |
| `fetch` / `XMLHttpRequest` / `WebSocket` | 脚本没有网络 |
| `eval` / `new Function` | 被 `codeGeneration:{strings:false}` 阻断（实测抛 `EvalError`） |
| 定时器 / 宿主全局对象 | 没注入，取不到 |

**能力围栏 ≠ 安全边界。** 这一档的威胁模型是「**模型写错代码**」，不是「攻击者拿到任意代码执行」：

- `node:vm` 不是安全沙箱，`constructor` 链逃逸是已知的、本档**不防**的手法；
- 因此 ODW 的正确用法是：**脚本由模型写、由用户过目、由插件执行**，而不是「执行来路不明的脚本」；
- 防「写错」的主力其实不是隔离，而是**上限治理**（下一节）+ 结构化错误 + 每一步都留痕；
- 如果将来需要真隔离，接口已预留升级到 `worker_threads` 宿主（可以 `terminate()`）。

另外，能力门是**启动时判定**的：`vm` 必须支持 `runInContext({timeout})` 且真能打断纯 CPU 死循环，否则这一档不成立。opencode 2.1.0（内嵌 Bun 1.4.2）实测四项全过。

---

## 上限与预算

| 项 | 默认 | 说明 |
|---|---|---|
| 单脚本墙钟 | 10 min | 每个原语调用前检查；同步死循环由 vm `timeout` 打断 |
| 并发 | **4**（上限 10） | 脚本的 `concurrency` 只能向下收，不能越过它 |
| 总 worker 数 | **50** | 超出抛 `worker-limit`，**不静默截断** |
| 原语调用步数 | **500** | 每次 `agent`/`parallel`/`pipeline`/`loop`/`verify`/`checkpoint`/`log`/`phase` 记 1 步；防的是「不花钱但失控」（`while(true) await ctx.log("x")`） |
| 预算 | 默认只统计 | 给了 `budgetUsd` 就**事后**判定：worker 一完成就累加，超了就停止派发（不杀正在跑的） |
| 取消 | `context.signal` | 触发后：停派发 → `interrupt` → `remove` |

> **诚实说明（实测）**：`budgetUsd` 的**金额**语义在免费模型上验证不了 —— `compass/deepseek-v4.1-flash` 每次调用都上报 `cost = 0`（token 数非 0）。所以「超预算就停派发」这条链路只有单测覆盖，没有真机金额证据；token 计数、`maxWorkers`、`maxSteps`、并发上限都有真机证据。

---

## `mode: "oneshot"` 的诚实说明

`mode: "oneshot"` 表示「这一轮除了说话什么也做不了」：

- 它**不是**宿主强制的单轮。opencode 的 `session.create` 没有「禁用工具」开关（已核 generated types），所以 ODW 的做法是：**拒绝全部权限**（`[{action:"*",resource:"*",effect:"deny"}]`，实测确实落到会话行上）+ 在 prompt 里明确告诉模型没有工具；
- 于是模型仍然可以**尝试**调用工具 —— 会被拒 —— 然后不得不用 prompt 里已有的信息回答；
- 实测证据：让它去读一个文件，它回答「本会话没有文件访问，请把内容贴给我」，**没有编造**文件内容；
- 反过来：如果答案需要外部信息，oneshot 就是错的工具，请用默认的 `agentic`。

同一 prompt 的实测对比：`oneshot` 1.37s / 1050 input tokens，`agentic` 1.58s / 2116 input tokens（agentic 要多花工具描述的开销）。

---

## 运行产物

每次 run 落一盘证据到 `<项目>/.odw/runs/<runId>/`：

```
.odw/runs/<runId>/
├── script.ts          # 实际执行的脚本源码（归一化之后）
├── meta.json          # runId / sessionID / directory / origin / 上限 / scriptHost
├── journal.jsonl      # 追加式事件流（run-start、worker-start、step、worker-end、run-end…）
├── result.json        # 机器可读结果：workers/steps/cost/tokens/returnValue/humanSummary…
└── checkpoints/       # ctx.checkpoint 落的文件（label 会消毒，防目录穿越）
```

**worker 会话不会被删。** 它们的 transcript 就是「发生了什么」的一手证据，`parentID` 让它们在你的会话树里可折叠。

---

## 目录结构

```
opencode-dynamic-workflow/
├── src/
│   ├── index.ts                    # Plugin.define({id:"odw", setup})
│   ├── types.ts                    # 错误族 + AgentOptions/RunContext/ScriptHost 契约
│   ├── plugin/{tools,commands,guard}.ts
│   ├── script/{host,host-vm,normalize,api-doc,plan}.ts
│   ├── primitives/{agent,parallel,pipeline,loop,verify,index}.ts
│   ├── worker/{agentic,result,lifecycle}.ts
│   ├── runner/{runner,semaphore,budget,deadline,steps,journal}.ts
│   ├── params/model.ts
│   └── artifacts/store.ts
├── skills/odw/SKILL.md             # 触发面：何时用 ODW，以及怎么驱动它
├── scripts/odw-install.sh          # install / update / status / rollback（全局或 --local）
├── tests/
│   ├── unit/                       # 84 条：原语 / 步数 / 归一化 / 计划扫描器 / worker / skill
│   └── contract/opencode-v2/       # 62 条断言：探针 + 断言 + harness + CONTRACT.md
├── workflows/audit.ts              # file: 载体示例（pipeline + checkpoint + verify）
└── README.md
```

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 命令不能从 `opencode run` 触发 | `opencode run "/workflow x"` 只会把字符串当 prompt 发出去；无头用 `odw_run` |
| `odw_plan` 不执行脚本 | 它只看**字面量**：`agent: someVar`、在 `parallel`/`loop` 里拼出来的调用点会被标成 `dynamic` 并跳过校验，所以真实 worker 数在计划阶段不可预测 |
| 计划通过 ≠ 运行成功 | 逻辑错误、运行期失败、worker 数量它都看不到 |
| 免费模型给不出金额 | 见「上限与预算」的诚实说明 |
| worker 继承会话的模型 | 除非脚本在该调用上传 `model`（或 `effort`）。会话本身跑在免费档时，每个 worker 都会撞 provider 配额，run 以 `kind: "internal"` 失败——用 `opencode run` 驱动 ODW 时请显式传 `--model` |
| 旧的 `odw_ultracode` / `odw_workflows` 不保留 | 避免两套状态源；旧命令是改名而非删除，所以可回滚 |

---

## 开发

```sh
npx tsc --noEmit                               # 类型检查（零构建，不需要转译产物）
npx vitest run tests/unit                      # 84 条单测
ODW_CONTRACT=1 npx vitest run tests/contract   # 62 条契约断言（真起 opencode）
node tests/contract/opencode-v2/run.mjs --keep # 留下现场以便排查
```

契约测试是**用 opencode 自己跑出来的行为快照**（`tests/contract/opencode-v2/CONTRACT.md`），不是 mock：它建一个临时 git 项目、写入探针与一个 skill fixture、`spawnSync` 起 `opencode run`，然后断言原始观察。它绝不读也不写你的 `~/.config/opencode`。

**开发回路铁律：永远不要在本仓库里跑 opencode。** 它会自动发现插件，然后在你每改一笔时重载。契约 harness 已经这么做了（`mkdtemp` → `git init` → 写入 fixture → `spawnSync("opencode", ...)`，并显式设 `PWD=<临时项目>`；只设 `cwd` 会让 server 静默绑到错误的项目上）。

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。
