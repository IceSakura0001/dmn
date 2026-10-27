# P2 半自主调度、有限重试与对账

日期：2026-10-26。P2 工作项已实现并验证；本轮止于 P2，没有进入 Desktop/MCP 集成。

## Git 基线

按用户要求先初始化本地 Git 仓库，提交现有 P0/P1：`39f415c`，标题 `feat: establish DMN P0 messaging and P1 private memory baseline`。70 个文件，已排除依赖目录、数据库、Runtime Home、环境文件和本地配置；暂存内容与当前凭据环境变量比对无命中。

P2 完成时实现、迁移、测试与本报告留在工作区，没有混入该基线提交。用户随后要求先提交 P2 再进入 P3，已保存为 `a56917b`，可用 Git 查看 P0/P1 到 P2 的差异。

## 实现与契约

| 组件 | 变化 |
|---|---|
| `execution-contracts.ts` | 严格执行策略：每话题/节点限额、重试次数、退避、连续单向消息上限 |
| `topic-manager.ts` | 唯一生命周期管理入口；配额原子预留、暂停/恢复/关闭、截止检查、授权栅栏 |
| `node-state.ts` | 从锁、可执行队首及退避状态推导 Sleeping/Queued/Running/Cooling |
| `runner.ts` | 有限重试、尝试日志、死信、同节点 FIFO、结果检查点与显式对账 |
| `dsh-runtime.ts` | 只有未 dispatch prompt 且确认清理成功后，才能声明可安全重试的失败 |
| `session-inspector.ts` | 受限的 SDK v4 原始日志证明读取器；不提交 Prompt，不调用模型 |
| `cli.ts` | 人工话题管理、队列元数据、pump 与 reconcile |
| `005_policy_recovery.sql` | 数据库版本 5，节点配额、尝试账本、检查点、死信及控制代次 |

### 生命周期与授权

Topic 使用 Active/Waiting/Paused/Closed。无待处理活动时 Waiting；截止或配额不足时 Paused；Closed 为终态。暂停保留队列；关闭取消 queued/retry 投递和排队的首次唤醒，保留消息事实、已开始活动和未知结果供审计/对账。

`resume` 只恢复尚有合法额度且未到期的话题，不清空已用计数、不延长截止时间、不扩大参与者、不替换 Session。余额不足返回 BUDGET_EXHAUSTED；已到期或关闭返回 TOPIC_STOPPED。需要新额度时应显式创建新授权话题，当前没有隐式补额接口。

人工 pause/resume/close 均使用控制代次 fencing。每轮领取时保存代次；即使话题暂停后迅速恢复，旧代次的在途回复和候选记忆也不能提交。已经发生的模型调用仍计费/占额度，关闭不等于远端请求可追溯撤销。

### 配额与不变量

每话题和每节点均有轮次、输入/输出 Token、估算费用和截止时间。节点未单独配置时继承话题的资源上限与截止时间，并使用话题 maxTurnsPerNode。自定义 nodeLimits 只能属于参与者，且不能高于话题授权。

领取事务在同一个 `BEGIN IMMEDIATE` 范围内检查权限、锁和配额，预留资源，写入 Turn、尝试账本及投递租约。失败也不退款。这里的“已用轮数”是保守的预留尝试数，可能高于实际 SDK 调用数；例如一次提交前失败再成功，会占两次预留但只调用一次模型。

任何节点限额不足会保守暂停整个话题，避免其他节点继续空转。当前还没有三节点下的精细公平调度。输入和费用仍采用 P0 的保守每轮预留上界，实际 Token 用量另外保存；不是实际账单结算系统。

节点单写者锁横跨话题。重试仍占同一逻辑消息的原队列位置，未来退避未到期时，后来的同节点消息不能绕过。不同节点仍可并行。暂停的话题不阻塞该节点其他有效话题；未知节点锁则持续阻止该节点的全部新模型活动。

同话题连续单向消息默认最多两条；模型 payload 不能提高此值，只有对端合法消息才能结束该连续序列。幂等旧请求仍返回最初回执，不额外插入或增加连续消息数。

### 有限重试与死信

`RuntimeNotSubmittedError` 是宿主类型，不是模型字段。实际适配器仅在 **从未调用 session/prompt，且 SDK 进程清理已确认** 后抛出此类型。配置/权限失败可标为不可重试。收到过回执的错误，即使伪装成该类型，也必须进入 unknown。

默认 maxAttempts=3（含首次，最多允许配置 5），退避 `[5,30,180]` 秒；第三项只有更高尝试上限时才会用到。投递与首次唤醒都有有限尝试，截止、话题和节点余额仍在每次领取前检查。退避时间与次数持久保存，重开数据库不会清零。

安全的提交前失败重试；到上限或不可重试时写入死信。已确认但 JSON/权限无效的输出直接死信，不从部分 JSON 猜测发送内容，也不偷偷增加修复推理。普通异常、Prompt 调用期间异常、超时和未知提交状态不盲重试。

`drain()` 只处理当前可执行工作；`runUntilIdle()` 在有限重试仍有效时用定时器等待下一个合法唤醒或截止，最长单次等待 60 秒，不轮询模型。被隔离或已暂停的工作不会造成自旋。人工暂停保留尚未提交的重试任务，恢复后仍检查剩余额度。

### 结果检查点与对账

成功的 RuntimeResult 必须先确认固定 Session、入站回执、无原生工具、单模型请求及 completed 终止事件，并完成 SDK 清理。随后单独保存结果检查点，再事务提交业务回复、记忆和确认。

若业务事务失败，节点进入 unknown/quarantined。人工 `reconcile` 可使用该成功检查点补交业务事务，不发第二个 Prompt。完成后的再次 reconcile 只返回原终态，不重复回复。

若检查点写入也失败，读取固定节点自己的 SDK v4 JSONL：

1. 独占 Runtime Home 标记，证明没有遵循协议的 SDK 活动正在占用该目录；已有 runtime.lock 时拒绝，不自动删除。
2. 仅接受单一、未压缩的 v4 代次；核对根 Session ID、cwd、无父会话/子代理、连续 seq 及已知事件词汇。
3. 精确匹配宿主保存的完整 Prompt、dmnTurnId、SDK 入队回执和真实 user/message，不采信模型自述“我已完成”。
4. 该活动必须只有一条用户输入、一次模型 step、匹配路由、无原生工具，并有 completed 终止及 assistant 结果。混入 Steering、撕裂尾部、未知必需事件、未来代次或额度异常均拒绝。
5. 通过后仍由原 Message Bus 与记忆契约检查结果，再按原 Turn 幂等提交。期间没有模型推理或重置预算。

这不是 DSH 内置的新历史 RPC，而是 DMN 的版本限定证明读取器。读取不到不代表“没提交”，不能因此自动重放。

`reconcile ... drop` 是人工放弃处理：必须有已确认完成的本地检查点，或检查器成功独占目录确认无活动；否则继续隔离。drop 进入死信并保留审计，不重新发送。强杀后遗留 runtime.lock、日志不完整、SDK 写者仍在运行等情况必须先人工检查进程和文件；本轮没有提供无证据删锁或强制重放。

## 使用

父进程已有 `DEEPSEEK_API_KEY` 时，可以显式启动话题：

```powershell
npm run dmn -- run config/nodes.deepseek.yaml config/topic.p2.json .dmn/discussion.sqlite
npm run dmn -- queue .dmn/discussion.sqlite
npm run dmn -- topic .dmn/discussion.sqlite <topic-id> status
npm run dmn -- topic .dmn/discussion.sqlite <topic-id> pause
npm run dmn -- topic .dmn/discussion.sqlite <topic-id> resume
npm run dmn -- pump .dmn/discussion.sqlite
npm run dmn -- reconcile .dmn/discussion.sqlite <unknown-turn-id>
# 明确放弃未知结果，满足无活动证明条件时才生效：
npm run dmn -- reconcile .dmn/discussion.sqlite <unknown-turn-id> drop
npm run dmn -- topic .dmn/discussion.sqlite <topic-id> close
```

`queue` 返回节点状态、投递统计、unknown Turn ID 与死信元数据，不返回消息正文、输入快照、原始模型结果或私有记忆。`topic resume` 仅改授权状态，不直接调用模型；`pump` 才处理合法待办。默认 reconcile 的含义是检查证明并补交已完成结果，不是只读状态查看；纯元数据查看用 queue/topic status。

这些仍是本地可信操作员入口，没有多用户网络认证或 MCP 暴露。模型只持有既有消息和自身记忆能力，不能调用话题管理、重试、drop 或对账。

`config/topic.p2.json` 是含独立节点配额的可运行示例。`policy.example.yaml` 仍是建议模板；执行策略来自每话题 limits，不会读取该模板里的占位值并自动授权。

## 迁移与 Git 回退资料

`005_policy_recovery.sql` 添加 topics.control_epoch/pause_reason、投递 next_attempt_at、Turn 尝试号/根尝试/队列时间/输入快照，以及 node_budgets、delivery_attempts、dead_letters、runtime_results。旧首次唤醒唯一索引改为只约束逻辑根尝试，允许有限的后续尝试。

0–4 版按顺序事务迁移至 5。旧策略补齐并持久冻结新增默认值；旧节点配额首次装载时根据历史尝试保守初始化，已用额度不清零。旧 queued 首次唤醒不会因升级重新创建。没有输入快照的旧 unknown 记录不会被伪造重建，需人工处理。

本轮在升级主空库前用 SQLite Backup API 保存 `.dmn/backups/p2-policy/dmn-v4.sqlite`；升级后版本 5、空队列、无运行活动。已有 P0/P1 真实验收数据库未被批量升级。迁移旧非空库的保留额度/幂等行为已在合成 v4 夹具中验证；不能手动重复执行 ALTER，也不能仅修改 user_version 来降级。

代码基线为 Git `39f415c`。数据恢复必须同时使用匹配的旧代码、数据库一致备份和 Runtime Home；Git 本身不包含运行数据或秘密。

## 实测环境与结果

Windows x64，Node 24.14.0、SQLite 3.51.2；项目 DSH SDK/Runtime/Protocol 为 `0.2.1-rc.3`，Session 持久格式实测为 4。官方 README 的历史格式示例与安装版可能不同，读取器以安装版类型、事件词汇和实际日志为准。

本轮核对了[官方 SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)、[JSONL 持久化说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)及本地发行源码；没有使用不存在的 session/history 或 mid-turn cancel API。

- `npm run check`：PASS。
- `npm test`：**76/76 PASS**，不调用真实模型。
- `npm run test:policy:live`：**2/2 PASS**。
- P0 `test:live`：两项真实回归 PASS；P1 `test:memory:live`：真实回归 PASS。
- `npm audit --audit-level=moderate`：0 项漏洞。

### 关键用例

所有用例使用上述环境、隔离夹具和明确预算；失败属于安全/正确性阻断。新增能力先添加失败测试，再实现。

| ID / 场景 | 操作、期望与实际 | 结论 / 证据 |
|---|---|---|
| D01 / E06 | 非参与者配额、越限节点配额和消息内授权覆盖均拒绝，事务无半提交 | PASS，policy/policy-migration |
| D02–D04 / E07 | 总/节点轮数、输入/输出、费用、截止均在领取前阻止；剩余队列不引起自发重启 | PASS，policy/runtime |
| D05 / D06 / D07 | 暂停保留、余额检查恢复、关闭取消待办；关闭不能重开 | PASS，policy/control-cli |
| 在途代次 | 暂停后立即恢复，再返回旧模型建议 | 旧建议不发送，PASS，policy |
| E03 安全重试范围 | 提交前故障、5/30 秒模拟推进，到三次停止；首次唤醒同样有限 | PASS，policy |
| 重启/顺序 | 重开数据库保留退避和次数；同节点后一条不能绕过前一条退避 | PASS，policy-migration/policy |
| E02 结果检查点 | Runtime 完成后业务写入失败，检查点补交一次，再次对账无新回复 | PASS，reconciliation |
| E02 无检查点 | 真实模型完成，故障注入阻止检查点入库；依据 SDK 日志恢复 | 一次模型调用、一条回复，PASS，真实证据 |
| 未知/占用 | 普通错误、有回执失败、已有锁或不足证据 | 保留 unknown，不转为可重试，PASS，reconciliation/session-inspector |
| 人工 drop | 无活动证明才转死信，已有占用不能强制 drop | PASS，reconciliation |
| 日志绑定 | 缺回执、不同根、未来格式、撕裂日志、原生工具、混合用户 Steering | 全部拒绝，PASS，session-inspector |
| E08 局部故障 | 一个节点提交前失败，有限重试后可继续；其他节点仍用独立锁 | 类型故障及并发回归 PASS；非任意崩溃自愈保证 |

### 真实证据

1. 结果对账（见[证据说明](EVIDENCE.md)）：真实 Reviewer SDK 完成后注入 SQLite 检查点写入失败，业务 unknown、无缓存；随后只读 v4 日志匹配原输入和回执，补交 `RECONCILED_ONCE`。模型调用 **1** 次，业务回复 **1** 条，再次对账不重复。
2. 有限重试（见[证据说明](EVIDENCE.md)）：宿主在 SDK 调用前注入一次已知未提交故障，实际退避后成功；**2 次预留、1 次模型调用**，达到两轮限额后 Paused。注入点是提交前宿主错误，不冒称真实 Provider 持续超时。
3. P0 六轮回归与真实并发（见[证据说明](EVIDENCE.md)）：六轮、五消息、固定根 Resume 与预算停止仍成立。
4. P1 回归（见[证据说明](EVIDENCE.md)）：四轮提炼三条私有记忆，重开数据库后自身检索和攻击样本隔离仍通过。

原始隔离库和 Session 保留在相应 `.dmn/live-p2-*`、`.dmn/live-acceptance-*`、`.dmn/live-memory-*` 目录。审计错误只保存固定分类，不透传 Provider stderr、Prompt、私有记忆或密钥。

## 残留风险

1. 只对确认未提交且清理完成的错误自动重试。Prompt 已发出的真实模型超时仍需对账；日志未确认 completed 时继续隔离，不能宣称此类超时会自动恢复或自动重放。
2. 真实对账验证的是“模型成功、数据库失败”的可重现窗口，没有在本轮验证随机进程强杀、掉电、残留原生写者清理或磁盘损坏。
3. v4 证明读取器仅支持当前配置的单一未压缩代次、无原生工具、单用户输入/单 step。历史混合代次、压缩、超 16 MiB、未来格式和旧无快照 Turn 会保守拒绝；不能替代官方通用迁移读取器。
4. runtime.lock 不会被自动删掉；陈旧标记会安全阻断，但可能需要操作者确认进程状态后处理。没有强制解锁或无证据重试入口。
5. 配额预留保守，提交前失败也占轮次与估算资源；耗尽任何节点额度会暂停整个话题。当前没有原地补额、按实际账单退款或多节点公平分配。
6. SDK/SQLite 间仍无分布式事务，目标是持久尝试、可追溯结果和防重复业务提交，不能称为所有故障下精确一次。
7. 既有 P1 语义真实性、逻辑删除、格式错误及私有信息 DLP 限制仍适用。当前无跨 Provider 扩展、HTTP/MCP 鉴权或 Desktop UI。

下一里程碑是 **P3：DSH Desktop 的 MCP 管理入口与发现/权限验收**。
