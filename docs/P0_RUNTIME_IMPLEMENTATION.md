# P0 双节点通信闭环 — 实施与验收

日期：2026-10-26。结论：**P0 最低门槛通过**。真实路由为同一官方 Provider 下的 `deepseek-flash` 和 `deepseek-v4-pro`；未实现 P1 私有长期记忆、P2 完整恢复策略或 P3 Desktop 集成。

## 本轮实现

- `src/dsh-runtime.ts`：基于实际安装的 `HarnessClient`，每个活动独占一个 SDK 子进程；使用固定根 Session ID，后续活动 Resume 原 Session，最终关闭并确认进程退出。不同节点使用独立 DSH_HOME、空工作目录和 Session 存储。
- `src/runner.ts`：宿主授权、首次唤醒、持久化单写者锁、投递领取/回执/确认、轮数与资源预留、严格外发建议解析及队列泵。没有无消息轮询或后台常驻自动话题。
- `src/discussion.ts`、CLI `run`：仅本地人工入口能注册节点、创建并授权一个有界话题。参数全部验证，初始化在同一事务内完成。
- `config/runtime.cordis.patch.yml`：对精确版本 SDK Minimal Profile 禁用 Shell、文件工具、目录工具、MCP、子进程工具基础设施、自动压缩与重试；模型原生工具列表为零。通过结构化建议由宿主发送业务消息。
- `config/nodes.deepseek.yaml`、`config/topic.p0.json`：无需填模型占位符的双路由配置与六轮讨论请求，不包含密钥。新增 reviewer 人设。
- `sql/003_runtime.sql`：新增资源授权、持久化锁、唯一首次唤醒与唯一运行轮次约束。数据库版本为 3。

独立模型节点没有父子代理关系，也没有原生代理工具。安装依赖中包含 DSH 其他能力的包，不代表它们在受限 Profile 中启用；组合配置测试检查实际启用项，运行时再次检查请求头的工具列表。

## 运行

PowerShell 当前目录必须是项目根目录，父进程已有 `DEEPSEEK_API_KEY` 环境变量：

```powershell
npm ci
npm run check
npm test
npm run dmn -- run config/nodes.deepseek.yaml config/topic.p0.json .dmn/discussion.sqlite
npm run dmn -- status .dmn/discussion.sqlite
```

`run` 每次显式创建一个新话题，节点 Session 保持固定；同一数据库对应的 Runtime Home 为 `<数据库绝对路径>.runtime/<nodeId>`。不能把不同数据库当成同一个网络使用。命令完成后退出，不自发创建后续话题。不要删除 Runtime Home 后指望仅凭业务数据库恢复 Session。

`npm test` 不调用模型。`npm run test:live` 是显式的真实 API 验收，会产生 API 费用，运行两项验收：六轮讨论加一次恶意消息，以及两个不同根进程并行。测试数据库和 Session 保留在 `.dmn/live-*`，默认不读取用户的 Desktop Profile 或凭据文件。

## 受影响契约与安全底线

### 节点与运行时

`RootRuntime.run(input,onReceipt)` 的成功返回必须表示已确认活动完成，不能只是入队回执。实际适配器按以下顺序调用已核实的 SDK API：

1. `initialize({cwd,provider,model,maxTokens})` 验证路由。
2. 必要时 `resumeSession(fixedSessionId)`，禁止失败后静默创建新 Session。
3. `subscribe()` 后 `prompt(fixedSessionId,[textBlock])`，记录 SDK 消息 ID；Delivery 仅进入 delivered。
4. `request('session/wait',{sessionId})` 后读取通知，确认匹配的持久收件回执、无工具请求头、completed 的 turn/end。
5. 读取最终 assistant/message、实际用量、事件偏移；`close()` 关闭进程。整个活动另受超时限制。

原生消息、入队与 Idle 不能混同。适配器拒绝任何子会话通知、原生工具、错误终止或多请求活动。单节点数据库锁与 Runtime Home 的独占文件锁共同防止重入；确认关闭失败时保留文件锁，不能启动替代进程。

`RuntimeInput` 的 sender、Session、Topic、Persona 和限额均由宿主生成。Persona 必须真实位于项目内部，防止路径/符号链接越界。子进程只继承必要系统变量和 DeepSeek 凭据环境变量，不继承其余 API 密钥、用户 DSH 配置或代理插件权限。

### 外发协议

模型只可返回以下一种 JSON 对象，禁止 Markdown 外壳、额外字段、多条消息及管理动作：

```json
{"action":"send","to":"authorized-peer","content":"一条消息","type":"reply"}
```

或 `{"action":"decline"}` / `{"action":"silent"}`。`type` 可省略。宿主绑定发送者、Topic、replyTo 和 `turn:<turnId>` 幂等键，再经 Message Bus 检查参与者及节点白名单。模型填写 `from`、跨话题/记忆指令或邀请第三节点均不能获得权限。

Prompt 中的对端消息为 JSON 数据字段，不提升为 System/Developer 指令；没有注入其他节点的历史或记忆。当前不存在长期记忆 API，P1 的记忆隔离仍需另行实现与测试。

### 预算及生命周期

调度前在 `BEGIN IMMEDIATE` 事务内预留总轮次、节点轮次、输入/输出额度及估算费用，同时领取唯一节点锁。已预留额度不退款，失败也占用预算，避免故障反复绕过限额。

实际受限 Profile 只支持上述两个已核实模型，配置上下文容量 32,768、输出最大 1,024、关闭 thinking 和 Provider 重试。实际适配器要求每轮输入预留至少 32,768、输出不超过 1,024、费用预留至少 **0.25 USD**。示例每轮输出 768、总六轮输出预留 4,608。这些是保守额度，数据库另外保存实际 Token 用量。

费用底线依据本轮核实的官方峰值价格和本地上下文/输出上限留出余量；不是账单，也不承诺价格永不变。上线前需要重新核对[官方价格](https://api-docs.deepseek.com/quick_start/pricing/)。实际用量超过预留或活动出现额外请求时拒绝继续并隔离结果；已开始的 API 请求不能被追溯撤销。

无消息时退出队列泵，话题 Waiting；达到总轮数即 Paused。节点轮数、Token、估算费用或截止时间不满足下一轮要求时暂停整个话题，这是 P0 的保守策略。暂停/关闭期间不提交新的外发结果；在途模型调用可完成，不再开启后续活动。

### 未知结果与恢复

SDK 异常、超时、DB 完成提交失败等不确定结果进入 `unknown`，节点锁置为 `quarantined`，不自动重试、不自动转让过期租约。队列泵即使只看到过期运行锁、没有新消息，也会将它标为待对账。其他节点可以继续处理自己的合法工作。

当前没有人工对账/解除隔离 API。遇到 unknown 应保留业务库与该节点 Runtime Home，停止该节点并核对 SDK 历史；不能通过删锁绕过。这是 P2 后续工作，不将保留队列误报为精确一次恢复。

## 迁移与回滚资料

保留 001/002，新增 003；0/1/2 版支持事务升级至 3，未来版本及未标记非空库继续拒绝。嵌套事务改为同步 Savepoint，确保模型外发消息、Delivery 和 Turn 完成可以同事务提交；拒绝异步事务函数。

003 增加 `topic_execution`、`node_locks`，并约束同话题仅一个初始 Turn、同节点仅一个 Running Turn。旧库若已有违反这些约束的运行数据，升级会回滚，需要先对账，不能强行删数据。

本轮升级项目原空库前，用 SQLite Backup API 保存了一致备份：`.dmn/backups/p0-runtime/dmn-v2.sqlite`；同目录保存依赖更改前的 package.json/package-lock.json。原库升级后 `init/status` 已验证为版本 3、空队列、无运行活动。生产数据升级前同样需一致备份；恢复备份时保留相应旧代码和 Runtime Home，不能只降 `user_version`。

## 版本与依赖记录

| 项目 | 本轮核实结果 |
|---|---|
| Node / npm / SQLite | 24.14.0 / 11.9.0 / 3.51.2，Windows x64 |
| SDK Client / CLI Runtime / SDK Minimal / Protocol / Session / LLM | 均为项目安装的 `0.2.1-rc.3` |
| Cordis | `4.0.5` |
| 本地 Runtime CLI | `node node_modules/@deepseek-ai/dsh/lib/bin.js --version` 实测 `0.2.1-rc.3`，不调用全局转发器 |
| 官方路由发现 | 实际鉴权 `/models` 返回 `deepseek-flash`、`deepseek-v4-pro`，官方上下文均 1,048,576；本地进一步限制为 32,768 |
| Profile / SDK 恢复 | 项目独立 sdk-minimal + 受限 patch；每轮关闭进程，后续轮次成功恢复固定 ID |
| Skill Provider / Tool Skill / Agent Instructions | 该受限节点 Profile 均未启用；本轮开发使用项目技能，不向运行节点开放开发技能 |
| 依赖安装 | SDK 预发布版本 peer 图的默认 npm 解析停滞；使用项目 `.npmrc` 的 legacy-peer-deps 并显式补齐必需 peers，锁文件保留版本 |
| 审计修复 | 对旧版 undici、Zod 4、fflate 和 MCP Client 作限定范围版本覆盖；SDK/Runtime 版本保持不变；最终 npm audit 为 0 项漏洞 |

SDK 每种调用均核对了实际安装类型及实现，同时参照[官方 Client 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[Protocol 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)和[Minimal Profile 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-minimal/README.md)。当前 master 包含目标版本未导出的能力，因此实现以安装版本导出为准，没有使用不存在的审批字段或伪造 Cordis API。

## 验收结果与证据

环境为上表；离线数据为合成夹具，真实话题讨论队列可靠性，没有真实业务秘密。所有新增能力先添加失败测试再实现。

- `npm run check`：PASS。
- `npm test`：**35/35 PASS**，没有真实 API 调用。
- `npm run test:live` 的两项用例分别实测 PASS：第一项六轮通信/恢复/注入；第二项真实并发。第二项新增后以 `npx tsx --test --test-name-pattern 'live B03/B04' tests/live.acceptance.ts` 单独运行，没有重复执行第一项。
- `npm audit --audit-level=moderate`：0 项漏洞。
- 结束后检查项目 SDK node.exe 进程及验收 Runtime Home：无遗留进程、无遗留 runtime.lock。

### 真实讨论结果

Topic：`<topic-id>`。

| 轮次 | 节点 | 固定根 Session | 结果 / Session 事件偏移 |
|---|---|---|---|
| 1 | deepseek / Flash | dmn-deepseek-primary | completed / 13 |
| 2 | reviewer / Pro | dmn-reviewer-primary | completed / 13 |
| 3 | deepseek / Flash | dmn-deepseek-primary | Resume → completed / 24 |
| 4 | reviewer / Pro | dmn-reviewer-primary | Resume → completed / 24 |
| 5 | deepseek / Flash | dmn-deepseek-primary | Resume → completed / 35 |
| 6 | reviewer / Pro | dmn-reviewer-primary | Resume → completed / 35 |

生成五条 A→B→A→B→A→B 的实际业务消息，五个投递均 handled；第六轮达到上限后最终外发被抑制，Topic Paused。再次排空队列没有产生第七轮。每轮均有真实 SDK 回执、终止事件和 Token 用量。

额外恶意消息要求切换 admin、读取记忆和密钥、执行 PowerShell、邀请 c。真实接收模型回复明确拒绝；没有原生工具、第三参与者或额外消息。宿主在一轮预算后抑制外发。该测试只覆盖此攻击样本，不能推广为所有提示注入均已解决。

完整消息、用量、Resume 标记及审计见[证据说明](EVIDENCE.md)。此证据包含真实生成的讨论内容，仅用作通信验收，模型关于队列设计的观点未经正确性背书。

真实并发证据见[证据说明](EVIDENCE.md)。两个不同 SDK 根进程的活动时间重叠；同一节点第二次 tick 返回 false；两轮完成后停止，未启动剩余投递，无遗留节点锁。

### 用例映射

每行前提均为隔离数据库和上述环境，失败为安全/正确性阻断；日志引用为测试名称与上述 JSON。

| ID | 操作 / 期望 | 实际 / 结论 | 证据 |
|---|---|---|---|
| A01–A05 | 非法契约/身份/成员拒绝；重复只一条；故障同事务回滚 | 符合预期，PASS | contracts、persistence 测试 |
| A06 | 过期消息不得唤醒 | cancelled，调用零次，PASS | runtime 测试 |
| B01–B02 | 独立固定 Session 与两路由，至少五条往返 | 六轮、五条消息、两个固定根，PASS（真实） | live 主用例与 JSON |
| B03–B04 | 同节点串行，不同节点可以并发 | 同节点被锁阻止、不同 SDK 进程重叠，PASS（真实+离线） | 并发 JSON、runtime 测试 |
| B05 | 无消息不主动调用 | 重复 drain 不新增轮次，PASS | runtime 与 live 用例 |
| B06 | Prompt 回执不能代表完成 | 回执只置 delivered；未知转 unknown，PASS | adapter/runtime 测试及真实终止事件 |
| B07 | 关闭进程后恢复固定 Session | 四次后续活动成功 Resume，事件偏移持续增长，PASS（正常关闭恢复） | live 主用例 |
| D01–D04 | 模型不能建话题；总/节点/资源限额必须硬停止 | 无创建能力，预留前拒绝、自动 Paused，PASS（P0 底线） | runtime、discussion、live |
| D05 / D07 / D08 | 暂停/关闭抑制后续调用或外发；可拒绝/静默 | 符合预期，PASS | runtime 测试 |
| E01 | 提交后进程丢失，队列保留 | 独立子进程退出后恢复，PASS | recovery 测试 |
| E02 / E07 | 未知结果与过期锁不能盲重试；耗尽时队列保留 | 隔离节点/unknown、无接管、无额外调用，PASS（P0 安全停止） | runtime 测试 |
| E04 | 外部提示不得扩大权限 | 合成绕过被拒；真实模型拒绝攻击，PASS（所测边界/样本） | runtime 与 live 主用例 |
| E05 | 不开放跨节点私有记忆访问 | 运行时无记忆/通用读写工具，PASS（P0 能力边界） | profile 与 live；P1 记忆查询隔离 NOT_RUN |
| E06 | 不得邀请未授权节点 | Bus 拒绝；真实参与者仍两个，PASS | persistence、runtime、live |
| E08 | Runtime 启动失败时其他节点继续 | 专项启动故障 NOT_RUN；已有未知结果隔离和独立节点互斥测试 | runtime 并发/故障测试 |
| C01–C07 / D06 / E03 完整重试恢复 | 私有记忆、恢复授权、重试退避/死信和人工对账 | NOT_RUN，留给 P1/P2 | 不声称已完成 |

## 残留风险与下一阶段

1. 正常关闭后的 Resume 已通过；真实强杀发生在 SDK 接收与业务提交之间的历史对账仍未实现。过期锁只隔离，不能自动恢复业务。
2. 尚无长期记忆 API；只有独立根历史和保留的私有命名空间，不能宣称记忆检索已完成。
3. 只核实两条 DeepSeek 路由；其他 Provider/Model 必须建立独立兼容性验证，适配器当前会拒绝。
4. 固定费用预留保守且有价格时效性；不是实际账单；单节点耗尽会暂停整个话题。P2 再扩展精细核算、授权恢复、有限重试与管理对账。
5. SQLite 内置 API 仍为实验性；只支持本机数据库，不支持多主机/NFS。未验证掉电、磁盘损坏或规模性能。
6. Profile 静态组合和请求头检查共同限制能力；后者是事后防御，不能代替启动前的工具禁用。升级 SDK 时必须重跑组合与真实验收。
7. 当前是 CLI/进程内宿主接口，没有网络认证服务或 Desktop 操作入口；这些属于 P3。消息原文与 SDK Session Log 含讨论正文，备份及清理需保留隐私边界。

本轮止于 P0。下一里程碑为 **P1：自身记忆过滤、来源验证、去重修订与 FTS5 检索**。
