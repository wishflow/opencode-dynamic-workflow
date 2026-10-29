# opencode v2 契约测试（ODW 的事实基线）

这里不是单测，是**用 opencode 自己跑出来的行为快照**。ODW 的每一个设计决定都建立在这些事实上；一旦 opencode 升级改变了它们，这里必须变红。

被测运行时：

| 项 | 值 |
|---|---|
| opencode | `2.1.0`（homebrew `opencode-v2`） |
| 嵌入式 JS 运行时 | Bun `1.4.2`（`process.versions.node` 报 `26.3.0`） |
| `@opencode/plugin`（类型包） | `2.2.0`（与运行时存在版本差，已知风险） |
| 观察日期 | 2026-10-29 |

## 1. 怎么跑

```bash
# 全量：真起 opencode，真跑 worker 会话（约 1~2 分钟）
node tests/contract/opencode-v2/run.mjs

# 保留现场（临时项目 + 原始观察 JSON + 日志）
node tests/contract/opencode-v2/run.mjs --keep

# 只跑不断言，打印原始观察
node tests/contract/opencode-v2/run.mjs --no-assert

# 复用上一次的现场重新断言（改断言时用，不重跑 opencode）
node tests/contract/opencode-v2/run.mjs --reuse <上一次的项目目录>

# 经 vitest（默认 skip，需显式开启）
ODW_CONTRACT=1 npx vitest run tests/contract
```

失败时退出码非 0，并打印失败项与原始观察。

## 2. 隔离规则（必须遵守）

| 规则 | 原因 |
|---|---|
| 只在 `mkdtemp()` 出来的临时 git 项目里跑 | 插件按 location 加载；非 git 目录拿不到 `location.project.id` |
| **绝不写** `~/.config/opencode/` | `OPENCODE_CONFIG_DIR` **不隔离**全局配置（PLAN §1 C9），用户真实配置始终被读取 |
| `spawnSync` 必须显式设 `PWD=<临时项目>` | opencode 用 `PWD` 而不是子进程 `cwd` 解析 location；只设 `cwd` 会**静默绑到调用者所在项目**（M1 踩过，断言 C1c 就是钉这个的） |
| 探针插件只通过 `.opencode/plugins/odw-probe/index.ts` 一行 re-export 挂载 | 配置 `plugins: [...]` 在本版本对本地目录不生效（PLAN §1 C8） |

## 3. 观察结果

`62/62` 通过（`run.mjs` 末行）。关键事实如下。

### 3.1 契约面（C1–C5）

| 项 | 观察 |
|---|---|
| `ctx` 顶层域 | 期望的 26 个域**全部存在**，无缺失、无多余 |
| `ctx.session` 成员 | `command, compact, context, create, generate, get, hook, interrupt, list, move, prompt, remove, switchAgent, switchModel, synthetic, update, wait` |
| `ctx.experimental` 成员 | **只有 `terminal`** —— **没有 `generate`** |
| `ctx.generate` 成员 | 只有 `text` |
| `ctx.model.list()` | 返回 **`{ data, location }` 包装对象**（不是数组），本次 41 个模型 |
| `ctx.agent.list()` | 同样返回 **`{ data, location }`**，7 个 agent：`build, general, explore, compaction, title, summary, plan` |
| agent 条目字段 | `description, hidden, id, mode, name, permissions, request` |
| `Model.Ref` | `{ providerID, id, variant? }` |
| `Model.Ref.parse("compass/some-model#high")` | → `{ providerID: "compass", id: "some-model", variant: "high" }` |
| `session.create({ id })` | ✗ `SchemaError`：`Missing key at ["model"]["providerID"]` |
| `session.create({ providerID, modelID })` | ✗ `SchemaError`：`Missing key at ["model"]["id"]` |
| `SessionInfo.model` 回显 | `{ id, providerID, variant: "default" }` —— `variant` 默认补 `"default"` |
| `session.create({ agent: "explore" })` | ✓ 回显 `agent: "explore"` |
| `session.create({ permissions: [{ action:"edit", resource:"*", effect:"deny" }] })` | ✓ 且 `session.get` 能读回同一份规则 |
| `session.create({ parentID })` | ✓ 回显 `parentID` |
| `session.prompt({ sessionID, parts:[...] })` | ✗ `SchemaError`：`Missing key at ["text"]` —— **`text` 是必填** |
| `session.update({ permissions })` | ✓，`get` 读回 `[{action,resource,effect}]` |

### 3.2 worker 循环（C6）—— ODW 的心脏

```
create → context() 给 [] → prompt() → context() 仍是 0 条 → wait() → context() 拿到 assistant
```

| 观察 | 值 |
|---|---|
| `context()` 在任何 prompt 之前 | `[]` |
| `context()` 在 `prompt()` 返回后立刻 | **0 条消息**（`prompt` 只入队，不等结果） |
| `wait()` 返回后消息序列 | `user, assistant, idle` |
| `idle.outcome` | `"succeeded"` |
| assistant 携带 | `tokens{input,output,reasoning,cache{read,write}}`、`cost`、`model`、`finish:"stop"`、`content[{type:"text"}]` |
| 单次往返耗时（免费模型） | ≈ 2.7 s |

> 注意 `cache.read` 会出现非 0（本次 256），ODW 的预算统计不能只加 `input`。

### 3.3 可重入性（C7）—— 架构级闸门

从**一次工具调用内部**并发起 2 个 worker，`Promise.all` 一起等：

| 观察 | 值 |
|---|---|
| 结果 | ✓ 两个 worker 各自产出正确文本（`alpha` / `beta`） |
| 总耗时 | ≈ 2.3 s（并发，不是串行相加） |

这条过了，ODW 的 `agent`/`parallel`/`pipeline` 才成立。

### 3.4 一次性生成（C8）

| 观察 | 值 |
|---|---|
| `ctx.experimental.generate` | **不存在**（`TypeError: undefined is not an object`）→ 计划里「改用 `experimental.generate`」的判断是错的 |
| `ctx.generate.text` | 存在且是函数；免费额度下抛 `Generate.UnavailableError`（"Free usage limit reached"） |
| `ctx.session.generate` | 是函数（形状未进一步探明） |

> 结论：**ODW 不得依赖 `ctx.generate.text`**（免费/无额度环境直接不可用）。所有"再问一次模型"都走 worker 会话。

### 3.5 node:vm capability fence（C11）—— A 档 ScriptHost 的可行性

| 能力 | 结果 |
|---|---|
| `vm.createContext` + `new vm.Script(...).runInContext` | ✓ |
| `codeGeneration: { strings: false }` 挡住 `eval` | ✓ `EvalError: Code generation from strings disallowed for this context` |
| `runInContext(ctx, { timeout })` 中断 `while(true)` | ✓ `Error: Script execution timed out after 300ms` |
| 宿主 `await` 沙箱内产生的 Promise | ✓ 拿到值（跨 realm thenable 可用） |
| 沙箱内 `x instanceof Promise`（跨 realm） | ✗ **`false`** —— 不能跨 realm 做 `instanceof` 判断 |
| 宿主 async 函数传进沙箱、在沙箱内 await | ✓ 返回正确结果（`42`） |
| 沙箱内 `typeof require` | `"undefined"` —— 无 ambient 模块访问 |
| `runInContext({timeout})` 覆盖 **async 函数体的同步前缀** | ✓ `(async () => { while(true){} })()` 被 300ms 超时打断 |
| 沙箱内 await **宿主** Promise | ✓ 返回 `"from-host"` —— 原语桥的双向都通 |
| 沙箱内 catch 宿主 Promise 的 reject | ✓ 拿到 `"host-boom"` |
| 沙箱全局对象面（只注入 `console`） | `process/require/module/exports/__dirname/__filename/Buffer/fetch/setTimeout/opencode` 全为 `undefined`；`Promise/JSON/Math/Date/Object/Function/eval/Proxy/Reflect/TextEncoder/URL/crypto/structuredClone` 均为自带 |

> 结论：A 档可行，且「把原语作为 async 函数注入 sandbox」这条桥是通的。实现时要避开跨 realm `instanceof`。
> 沙箱有**自己 realm 的标准内置对象**，所以 ScriptHost 不需要（也不应该）注入宿主的内置对象 —— 跨 realm 混用只会让 `instanceof` 更混乱。只注入 `console` + 原语入口。

### 3.6 反馈通道（C12 / C13 / C9）

| 通道 | 观察 |
|---|---|
| `toolContext.progress({...})` | ✓ 可调用 |
| `toolContext.signal` | 是 `AbortSignal`，未中止 |
| `ctx.session.synthetic({ sessionID, text })` | ✓ 返回 `{ type: "synthetic", payload:{text}, delivery:"steer" }` |
| `ctx.session.hook("prompt", cb)` | ✓ 触发；event 字段 `delivery, messageID, metadata, prompt, sessionID` |
| `event.prompt` 字段 | `agents, files, skills, text` |
| `event.delivery` | `"steer"` |
| 修改 `event.prompt.text` + `event.metadata` | ✓ 生效 |
| 同一 event 重复触发时 marker 出现次数 | 1（探针自带幂等守卫） |

> `event.prompt` 里还有 `files`/`skills`/`agents`，ODW 的 prompt hook 只碰 `text`，其余原样保留。

### 3.7 命令（C17）—— `/workflow` 的落地方式

| 项 | 观察 |
|---|---|
| `ctx.command.transform` 注册 | ✓ |
| `ctx.command.list()` 是否列出注册项 | ✓ 列在 `init/review/odw/ultracode/workflows/...` 同一份清单里（TUI 可见） |
| `opencode run "/name args"` 是否派发命令 | ✗ **不派发** —— 整串当普通 user prompt 送模型 |
| `ctx.session.command({ sessionID, name, text })` | ✓ 真的调用到 `execute`，`prompt.text` 就是 `text` |
| 只改 `invocation.prompt.text`（不自己 enqueue） | ✗ **不会**投递任何东西：命令结束后 session 里 **0 条 user 消息** |
| `execute` 内自己 `ctx.session.prompt({ sessionID: 自己的会话 })` | ✓ 投递成功（`user` 消息入库），且**模型真的按新 prompt 回答** |

> 结论：`/workflow` 必须是「注册命令 + 在 `execute` 里**显式** `session.prompt` 自己那条 prompt」。改 `prompt.text` 只是"能改"，不代表"会被送出去"。
> 另外 `opencode run` 不走命令派发，所以「无 TUI 的真机验证」只能用 `session.command`（或 TUI）触发。

### 3.8 hook 改写是否真到达模型（C9d/C9e）

在独立会话里发带哨兵词的 prompt，跑完后从 `session.context()` 读回 `user` 消息：

| 观察 | 值 |
|---|---|
| `SessionMessageUser` 的文本字段 | **顶层 `text`**（不是 `payload.text`；`payload.text` 是 `session.prompt()` 的**返回值**/inbox item 形状） |
| hook 追加的 marker 是否在入库的 user 消息里 | ✓ 出现 **1** 次 |
| 模型是否照 hook 注入的指令回答 | ✓ 回复 `done HOOKOK` |

> 这条把「hook 只碰 text、且改写确实进入模型输入」钉死了。

### 3.9 skill 发现（C21）—— 自然语言触发的唯一载体

harness 在临时项目里写入 `.opencode/skills/odw-contract-probe/SKILL.md`（frontmatter 带 `name` / `description`，正文带 marker），然后在探针里读 `ctx.skill.list()`：

| 观察 | 值 |
|---|---|
| `ctx.skill` 的成员 | **只有 `list, reload, transform`** |
| `ctx.skill.list()` 返回 | **`{ data, location }` 包装对象**（与 `model.list` / `agent.list` 同形状，见 C12） |
| 条目字段 | `id, name, description, path, content`（`autoinvoke` 未设置时不出现） |
| `name` | 取自 frontmatter |
| `description` | 取自 frontmatter |
| `content` | **只有正文，frontmatter 已被剥掉** —— 「模型加载 skill」拿到的就是这一段 |
| `path` | 绝对路径，指向项目的 `.opencode/skills/<name>/SKILL.md` |
| 注册表规模（本次） | 60 条 = 用户全局 `~/.config/opencode/skills/*` **与项目 skill 合并**，再加本 fixture |

> 结论：ODW 的触发面是可被契约钉死的 —— 文件存在 → 上架 → frontmatter 解析 → 正文进注册表。
> **契约没钉的两件事**（诚实标注）：① 全局 `~/.config/opencode/skills/` 那条路径（§2 规则禁止写用户全局配置）；② 「模型在真实会话里读到并主动激活它」—— 后者在真机验收清单里验（PLAN §9）。

## 4. 负向控制

把探针里 C7 的 `await Promise.all([wait, wait])` 改成 `await Promise.all([])`，重跑：

```
FAIL  C7b   both workers produced text
38/39 passed
```

其余 38 项保持绿色 —— 断言确实绑在真实行为上，不是恒真。（这段是加入 C21 之前测的，当时断言总数是 39。）

C21 的反证：把 `run.mjs` 里写入 skill fixture 的那段临时注释掉，重跑：

```
FAIL  C21b  project skill at .opencode/skills/<name>/SKILL.md is registered
FAIL  C21c  registry name comes from the frontmatter
FAIL  C21d  registry id is present
FAIL  C21e  registry description comes from the frontmatter
FAIL  C21f  skill body is loaded into the registry
FAIL  C21g  registry path points at the project skill file
56/62 passed
```

`C21a`（「注册表本身可用」）仍然绿 —— 红的这几条确实绑在「那个文件被上架」这件事上。

> 另外也踩过一次**假绿以外**的反面：探针默认挑 `model.list()` 里的第一个模型，而它是免费额度模型；额度耗尽后所有模型相关断言集体变红（`C7b`、`C9d`、`C9e` 全挂，报 `provider.quota`）。现在 harness 固定用 `compass/deepseek-v4.1-flash`（可用 `ODW_PROBE_MODEL` 覆盖）。**契约测试不能依赖免费额度。**

## 5. 发现并已回写进 PLAN 的修正

| 编号 | 原判断 | 实测 |
|---|---|---|
| C11 | 用 `ctx.experimental.generate.text` 替代 deprecated 的 `ctx.generate.text` | `ctx.experimental` 只有 `terminal`，**没有 `generate`**；只能继续用 `ctx.generate.text`，且它受额度限制 |
| C12 | `ctx.model.list()` / `ctx.agent.list()` 返回数组 | 返回 `{ data, location }` 包装对象 |
| C13 | 测试隔离靠 `cwd` / `OPENCODE_CONFIG_DIR` | location 由 **`PWD`** 解析；`OPENCODE_CONFIG_DIR` 不隔离全局配置 |
| C14 | `SessionInfo.model` 与传入的 `Model.Ref` 一致 | 回显会补 `variant: "default"` |
| C15 | `ctx.session` 的成员集合以文档为准 | 实际多出 `generate, compact, interrupt, move, switchAgent, switchModel` |
| C16 | — | 免费额度下 `ctx.generate.text` 抛 `Generate.UnavailableError`，**ODW 不得依赖它** |
| C17 | 命令只改 `prompt.text` 就能影响模型输入 | **不投递**；`execute` 必须自己 `ctx.session.prompt` |
| C18 | `opencode run "/cmd args"` 会走命令派发 | **不会**；命令只能由 TUI / `session.command` 触发 |
| C19 | user 消息文本在 `payload.text` | `SessionMessageUser` 是顶层 `text` |
| C20 | 沙箱需要注入宿主的 `JSON/Math/Date` 并冻结 | 沙箱自带自己 realm 的内置对象，注入宿主对象只会引入跨 realm 混淆；只注入 `console` + 原语 |
| C21 | skill 发现路径 `<root>/skills/<name>/SKILL.md`（方案假定，未在契约里验过） | 项目级已实测上架：`ctx.skill` 只有 `list/reload/transform`；`list()` 返回 `{data, location}`；条目 `id/name/description/path/content`，其中 `content` 是**剥掉 frontmatter 的纯正文**；项目 skill 与用户全局 skill 合并。全局路径与本条同规则，未在契约里钉 |
