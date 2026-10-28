# opencode-dynamic-workflow (ODW)

把「动态工作流」做进 opencode v2 的一等公民：**模型写一个受约束的脚本，插件确定性地执行它，每个 worker 都是宿主 opencode 的一个子会话。**

它解决的问题是：当一件事是「对 N 个对象做同一件事」「扇出后汇总」「循环到通过为止」时，在一个会话里逐轮做又慢、又串行、又不可复现。把它写成脚本，并发、预算、取消、留痕就都由插件来管。

**ODW 自己不需要任何 API key。** 所有模型调用都发生在宿主 opencode 的子会话里，用的是你已经在用的登录态和 provider 凭据。

```
模型                     插件（本仓库）                           宿主 opencode
 │                            │                                        │
 │ ① odw_plan（免费 dry run） │                                        │
 ├───────────────────────────►│ 编译脚本 + 校验字面量参数               │
 │                            │（agent/model/effort/mode/permissions）  │
 │ ② odw_run(script)          │                                        │
 ├───────────────────────────►│ 归一化 → node:vm 沙箱                   │
 │                            │   └─ 执行 async (ctx) => {...}          │
 │                            │        ├─ ctx.agent        ─────────────┼─► session.create(parentID)
 │                            │        ├─ ctx.parallel     ─────────────┼─►   + prompt + wait
 │                            │        ├─ ctx.pipeline                  │      （真·子会话，工具齐全）
 │                            │        ├─ ctx.loop / verify / checkpoint │
 │                            │        └─ 结构化错误 → 交回模型，由模型决定重试
 │ ③ 读 result.json / journal  │                                        │
 │◄───────────────────────────┤                                        │
```

---

## 1. 状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 插件骨架 + 在 opencode 2.1.0 上证明加载路径 | ✅ |
| M1 | 契约测试（55 条），钉死宿主 API、vm 能力门、`PWD` 陷阱 | ✅ |
| M2 | 垂直切片：vm 沙箱、`agent`/`parallel`、artifacts、进度双通道 | ✅ |
| M3 | 原语补全：`pipeline`/`loop`/`verify`/`checkpoint`/`abort`、步数上限、`odw_plan` | ✅ |
| M4 | 参数与权限收口：`model`/`effort`/`mode`/`permissions` 全量校验、`oneshot` | ✅ |
| M5 | 迁移旧插件（project A）+ 本文档 + 回滚脚本 | ✅ |

`tsc --noEmit` 干净，单元测试 85 条绿，契约测试 55 条绿（`ODW_CONTRACT=1` 才跑）。

---

## 2. 安装

零构建：opencode 内嵌 Bun 直接加载 TypeScript，`package.json` 的 `exports` 直指 `./src/index.ts`。运行时依赖为 0。

### 2.1 全局安装（推荐）

```sh
# 安装：备份 → 装 shim → 清理旧配置 → 停用旧插件与旧命令
./scripts/odw-global.sh install

# 看一眼现在是什么状态
./scripts/odw-global.sh status

# 一键回滚（恢复 opencode.json + 把 .disabled 改回来 + 摘掉 shim）
./scripts/odw-global.sh rollback
```

它做的事（每一步都先备份，详见 [`docs/migration-project-a.md`](docs/migration-project-a.md)）：

| # | 动作 | 目标 |
|---|---|---|
| 1 | 备份配置 | `~/.config/opencode/opencode.json` → `opencode.json.bak.<ts>` |
| 2 | 装 shim（**目录**） | `~/.config/opencode/plugins/opencode-dynamic-workflow/index.ts` |
| 3 | 删掉 `plugin` 键 | 旧键 `"./plugins/odw.mjs"` 指向一个 **文件**，是启动 WARN 的来源 |
| 4 | 改名停用旧插件 | `plugins/odw.mjs` → `odw.mjs.disabled`（**不删除**） |
| 5 | 改名停用旧命令 | `commands/{odw,ultracode,workflows}.md` → `*.md.disabled` |
| 6 | 写迁移清单 | `~/.config/opencode/.odw-migration.json`（回滚靠它） |

`rollback` 的动作顺序与 `install` **正相反**（先改回文件、再摘 shim、**最后**恢复 `opencode.json`）。这是刻意的：先恢复配置会开出一个「配置指向尚不存在的文件」的窗口，opencode 的插件注册表 reconcile 撞上会刷一串 `failed to load plugin … ENOENT`。详见 [`docs/migration-project-a.md`](docs/migration-project-a.md) §4。

装完**重启 opencode**，然后在任意会话里用 `/workflow <任务>`。

### 2.2 只装在某个项目里

opencode 的加载路径只有两种（实测，见 PLAN §1 C8）：

- `<项目>/.opencode/plugins/<名字>/index.ts|js` ← 项目级
- `~/.config/opencode/plugins/<名字>/` ← 全局级

注意两点：**配置里的 `plugins: [...]` 数组不会加载本地目录**；**目录软链接不会被跟随**。所以项目级安装要真的写一个文件：

```sh
mkdir -p .opencode/plugins/odw
printf 'export { default } from "%s/src/index.ts"\n' \
  "$(cd /path/to/opencode-dynamic-workflow && pwd)" > .opencode/plugins/odw/index.ts
```

<details>
<summary>为什么本仓库的 <code>.opencode/dev/plugin-entry.ts</code> 不放在 <code>plugins/</code> 下</summary>

opencode 会监听被自动发现的插件文件。把 shim 放在本仓库的 `.opencode/plugins/` 里，会导致「在仓库内改 `src/` 的每一笔都触发插件重载 + 全量工具/技能目录刷新」。所以开发入口放在 `.opencode/dev/`，另见其 `README.md`。
</details>

---

## 3. 用法

### 3.1 `/workflow <任务>`

人工入口。它**自己不执行任何东西**：只是把任务交给模型，并要求模型「先 `odw_plan` dry run，再 `odw_run` 写脚本执行，最后汇总」。真正执行的是 `odw_run` 工具——所以 worker 的创建只有一条代码路径。

```
/workflow 核查 workflows/ 下每个脚本的头部注释是否与实现一致
```

> 实测限制：`opencode run "/workflow x"` **不会**派发命令（它把字符串当普通 user prompt 发出去）。命令要从 TUI 或 `session.command` 进入；无头场景请直接调 `odw_run`。

### 3.2 工具（Code Mode）

| 工具 | Code Mode 路径 | 调模型 | 作用 |
|---|---|:--:|---|
| plan | `tools.odw.plan` | **否** | 编译 + 按「活体清单」校验字面量参数，返回「将要跑什么」 |
| run | `tools.odw.run` | 是（只在脚本内） | 真跑脚本 |
| ping | `tools.odw.ping` | 否 | 自检 |

```js
// tools.odw.run
{ script: 'async (ctx) => {...}' }   // 内联源码（迭代期首选）
{ file: "audit.ts" }                 // 相对 <项目>/workflows/ 的文件
// 可选：runId / concurrency(默认4,上限10) / timeoutMs(默认600000)
//       / budgetUsd / maxWorkers(默认50)
```

### 3.3 脚本里能用的东西

沙箱里 **有且只有** 这些：

| 原语 | 作用 |
|---|---|
| `ctx.agent(o)` | 起一个真子会话，发 prompt，等它结束，返回文本（给了 `schema` 就返回解析后的对象） |
| `ctx.parallel(items, fn, {concurrency?})` | 有界并发扇出，结果**按输入顺序**返回 |
| `ctx.pipeline(items, ...stages)` | `parallel` + 每个 item 顺序过一条 stage 链，stage 收到上一级的返回值 |
| `ctx.loop({max, body, until?, initial?})` | 迭代，`max` 必填，`until` 成立即停，返回 `{iterations, state, stopped}` |
| `ctx.verify(claim \| o)` | 只读 worker 做**对抗性复核**，返回 `{pass, reasons}`，无法确认即 `pass:false` |
| `ctx.checkpoint(label, data?)` | 落一个持久标记（journal + `checkpoints/` 文件） |
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
  timeoutMs?: number         // 单 worker 墙钟
}
```

**没有自动重试。** worker 失败就抛错，脚本随之中止，工具把结构化错误（`kind` + `message` + 现场目录）交回模型，由模型改脚本重跑（要重试逻辑就自己用 `ctx.loop`）。

---

## 4. 能力围栏声明（请当真读）

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
- 防「写错」的主力其实不是隔离，而是 **上限治理**（下一节）+ 结构化错误 + 每一步都留痕；
- 如果将来需要真隔离，接口已预留升级到 B 档（`worker_threads`，可 `terminate()`）。

另外，能力门是**启动时判定**的：`vm` 必须支持 `runInContext({timeout})` 且真能打断纯 CPU 死循环——否则 A 档不成立，要升 B 档。opencode 2.1.0（内嵌 Bun 1.4.2）实测四项全过，A 档成立。

---

## 5. 上限与预算

| 项 | 默认 | 说明 |
|---|---|---|
| 单脚本墙钟 | 10 min | 每个原语调用前检查；同步死循环由 vm `timeout` 打断 |
| 并发 | **4**（上限 10） | `parallel`/`pipeline` 的 `concurrency` 只能向下收，不能越过它 |
| 总 worker 数 | **50** | 超出抛 `worker-limit`，**不静默截断** |
| 原语调用步数 | **500** | 每次 `agent`/`parallel`/`pipeline`/`loop`/`verify`/`checkpoint`/`log`/`phase` 记 1 步；防的是「不花钱但失控」（`while(true) await ctx.log("x")`） |
| 预算 | 默认只统计 | 给了 `budgetUsd` 就**事后**判定：worker 一完成就累加，超了就停止派发（不杀正在跑的） |
| 取消 | `context.signal` | 触发后：停派发 → `interrupt` → `remove` |

> **诚实说明（实测）**：`budgetUsd` 的**金额**语义在免费模型上验证不了——`compass/deepseek-v4.1-flash` 的每次调用都上报 `cost = 0`（token 数非 0）。所以「超预算就停」这条链路的**金额判定**目前只有单测覆盖，没有真机金额证据；token 计数与 `maxWorkers` / `maxSteps` / 并发上限都有真机证据。

---

## 6. `mode: "oneshot"` 的诚实说明

`mode: "oneshot"` 表示「这一轮除了说话什么也做不了」：

- 它**不是**宿主强制的单轮。opencode 的 `session.create` 没有「禁用工具」开关（已核 generated types），所以 ODW 的做法是：**拒绝全部权限**（`[{action:"*",resource:"*",effect:"deny"}]`，实测确实落到会话行上）+ **在 prompt 里明确告诉模型没有工具**；
- 于是模型仍然可以**尝试**调用工具——会被拒——然后不得不用 prompt 里已有的信息回答；
- 实测证据：让它去读一个文件，它回答「本会话没有文件访问，请把内容贴给我」，**没有编造**文件内容；
- 反过来：如果答案需要外部信息，oneshot 就是错的工具，请用默认的 `agentic`。

同一 prompt 的实测对比：`oneshot` 1.37s / 1050 input tokens，`agentic` 1.58s / 2116 input tokens（agentic 要多花工具描述的开销）。

---

## 7. 运行产物

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

## 8. 目录结构

```
opencode-dynamic-workflow/
├── src/
│   ├── index.ts                    # Plugin.define({id:"odw", setup})
│   ├── types.ts                    # 错误族 + AgentOptions/RunContext/ScriptHost 契约
│   ├── plugin/{tools,commands,trigger,guard}.ts
│   ├── script/{host,host-vm,normalize,api-doc,plan}.ts
│   ├── primitives/{agent,parallel,pipeline,loop,verify,index}.ts
│   ├── worker/{agentic,result,lifecycle}.ts
│   ├── runner/{runner,semaphore,budget,deadline,steps,journal}.ts
│   ├── params/model.ts
│   └── artifacts/store.ts
├── tests/
│   ├── unit/                       # 85 条：原语 / 步数 / 归一化 / 计划扫描器 / worker / 触发器
│   └── contract/opencode-v2/       # 55 条：探针 + 断言 + harness + CONTRACT.md
├── workflows/audit.ts              # file: 载体示例（pipeline + checkpoint + verify）
├── scripts/odw-global.sh           # 全局安装 / 回滚 / 状态
├── docs/migration-project-a.md     # 迁移旧插件（project A）的详细步骤
├── .opencode/dev/                  # 开发入口（故意不在 plugins/ 下）
└── README.md
```

---

## 9. 已知限制

| 限制 | 说明 |
|---|---|
| 命令不能从 `opencode run` 触发 | `opencode run "/workflow x"` 只会把字符串当 prompt 发出去；无头用 `odw_run` |
| `odw_plan` 不执行脚本 | 它只看**字面量**：`agent: someVar`、在 `parallel`/`loop` 里拼出来的调用点会被标成 `dynamic` 并跳过校验，所以真实 worker 数在计划阶段不可预测 |
| 计划通过 ≠ 运行成功 | 逻辑错误、运行期失败、worker 数量`它都看不到 |
| 免费模型给不出金额 | 见 §5 的诚实说明 |
| project A 的 `odw_ultracode` / `odw_workflows` 不保留 | 避免两套状态源；旧命令改名保留可回滚，见 `docs/migration-project-a.md` |

---

## 10. 开发

```sh
npx tsc --noEmit                    # 类型检查（零构建，不需要转译产物）
npx vitest run tests/unit           # 85 条单测
ODW_CONTRACT=1 npx vitest run tests/contract   # 55 条契约测试（真起 opencode，约 25s）
node tests/contract/opencode-v2/run.mjs --keep # 留下现场以便排查
```

**开发回路铁律**：永远在一个**临时项目**里跑 opencode（自带 shim），不要在仓库里跑。原因见 §2.2 的折叠块。契约 harness 已经这么做了：`mkdtemp` → `git init` → 写 shim → `spawnSync("opencode", …)`，并显式设 `PWD=<临时项目>`（只设 `cwd` 会让 server 按继承的 `PWD` 绑错项目，M1 实际踩过）。
