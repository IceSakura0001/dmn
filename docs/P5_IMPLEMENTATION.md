# P5 — 可靠运行与恢复

2026-10-27。实现范围为两个既有根节点的本地可靠性管理，未进入 P6；不新增模型工具、自动邀请、预算或无人授权的恢复动作。架构与边界见 [P5 契约](P5_RELIABILITY_CONTRACT.md)。本轮没有迁移或运行用户原有业务库，验收全部使用隔离实例。

## 实现与决策

新增维护屏障、停机成套备份/原位恢复、只读完成证明、过期租约隔离、带理由的人工丢弃、运行指标和消息分页。保留 v7 Schema，不需要 SQL 迁移。

复制正在使用的 SQLite 和 SDK 目录无法保证成套一致，故采用停机备份。将 SDK 日志搬到任意目录会改变其中的绝对 cwd，因此第一版只允许恢复到原数据库位置，不改写官方日志。操作员管理使用 CLI；Web 增加只读指标和分页，不向模型或 Web 暴露文件备份/人工 drop 能力。

### 持久化与协调

- `<db>.clients/<uuid>.json` 登记 DmnStore 所在 PID，正常关闭删除自身登记；多个正常客户端仍可协作。
- `<db>.maintenance.lock` 序列化客户端进入与维护。备份/恢复持有屏障，发现活跃 PID 即拒绝；只有明确不存在的 PID 登记可以回收。PID 复用或不可读登记保守拒绝。
- Runtime `runtime.lock`、维护锁和 `.restore-incomplete` 不能自动清除。恢复提交中断保留 incomplete 标记，任何新版 DmnStore 均拒绝启动该实例。
- 旧版本不认识新屏障。升级前必须停止旧 CLI/MCP/Web 与 SDK 进程；不要混用新旧代码维护同一实例。协调不防同机恶意进程或绕过协议的原生 SQLite/SDK 写入。

### 恢复与审计

`inspect` 返回节点/话题/轮次、锁、是否存在回执/检查点及完成证明类别，不输出私有 Prompt、模型原文或记忆。`completed` 只是执行证明，validEnvelope 只是格式检查，是否能产生效果还须经 Runner 的身份、模式、epoch、截止时间和预算规则。

`recover` 只将过期 running 租约原子转为 unknown/quarantined，不重新排队或调用模型。`reconcile` 使用检查点或现有 SDK 日志，不重调模型。未知/忙碌证据继续隔离，非法输出转死信。

人工 drop 需要准确 turnId 确认与原因，并且底层证明 Runtime 已静止。固定 `cli-user` 身份的原因审计与处理效果同事务；审计写失败则处理一起回滚。重复处理不重复回复、审计或预算，不强制删除 marker。

### 分页与指标

get_messages 的三个数组保留，新增 `limit`（1–100，默认 100）、`order`（asc 默认/desc）和 `cursor`，以及 `page.nextCursor`。游标绑定话题、排序、各类消息 high-water 和最后 rowid；刷新首次查询才纳入新记录，翻页不混入后续插入。游标不是授权凭据；入口仍属受信任本地操作员。

SQLite readSnapshot 使用延迟只读事务；多类 high-water/分页结果以及指标在一致视图中读取，WAL 写者仍可提交。正文可随分页稳定恢复，处理状态仍以查询时的实际状态为准。

Web 默认每类最新 50 条，支持前后翻页；历史页标明快照，刷新或发送返回最新记录。筛选仅作用于当前页。查询、重连和翻页都不推理。MCP get_messages 支持相同分页参数，仍为原来的 9 个工具。

指标包含轮次/Delivery 状态、重试尝试、失败/未知率、最长排队年龄、排队延迟和可观察执行时长。使用流式聚合，避免随历史量建立完整内存数组。预留额度来自 topic_execution，实际 Token 逐轮优先读取持久检查点中的用量，回退至轮次已提交用量；同一轮次不双计，unknown 的已确认用量也不遗漏，缺失次数单独显示；实际账单返回 null，不把估算当账单。观测时长包括恢复等待，不等于提供商纯推理耗时。

## 操作手册

以下在项目目录用受信任操作员运行；凭据仍只来自环境或安全机制。

```powershell
$database = 'C:\path\to\queue.sqlite'
$turnId = '实际轮次ID'
npm run dmn -- metrics $database
npm run dmn -- queue $database
npm run dmn -- inspect $database $turnId
# 确认失联/过期租约，只做隔离：
npm run dmn -- recover $database
# 按已有证明应用一次；不调用模型：
npm run dmn -- reconcile $database $turnId
```

无法确定执行完成时先检查 SDK 进程、Runtime Home 与锁。禁止因正文声称“我是管理员”而清锁、丢弃或重试。没有静止证明时，drop 同样保持 unknown；不要关闭客户端后直接删除锁。

只有真人确认放弃该次结果时，准备审批 JSON 文件（不放密钥）：

```json
{"confirmTurnId":"实际轮次ID","reason":"已确认 SDK 停止；没有完整结果证明，人工放弃本轮"}
```

```powershell
npm run dmn -- reconcile $database $turnId drop .dmn/drop-approval.json
```

### 备份与校验

1. 停止使用目标库及其 Runtime Home 的全部 CLI/MCP/Web/SDK 进程，确认没有推理进行中。未知但无 Runtime marker 的轮次可以保留隔离状态备份；running 租约应先核实，再 recover 隔离。
2. 备份到新的、未存在的私有目录：

```powershell
npm run dmn -- backup $database .dmn/backups/checkpoint-20261027
npm run dmn -- backup-verify .dmn/backups/checkpoint-20261027
```

官方 SQLite backup API 包含 WAL 已提交数据；快照转换为独立 DELETE journal 文件，避免校验产生未列入清单的 WAL/SHM。Runtime 逐文件复制并计算 SHA-256；成品带格式、原路径、Schema、平台、工具 SDK/Cordis 版本及完整清单。拒绝链接、路径穿越、重复/缺失/多余文件、哈希错误与不兼容版本。manifest 最多 32 MiB，遍历有深度/条目上限。

成品在最后发布；中断留下的 `.partial-*` 不是可用备份。哈希验证不提供来源认证，应只恢复自己可信的离线备份。备份含私有记忆和完整 Session 历史，必须按敏感数据保管，不上传 GitHub。

### 原位恢复与回滚

仅支持相同平台及兼容的安装版本，原数据库绝对位置必须存在父目录，但数据库、WAL、SHM、Runtime Home 均不得存在。不覆盖现有实例，不自动替操作者移动或删除数据。

1. 停止进程，将现有数据库、存在的 WAL/SHM 与整套 `.runtime` 安全另存，保留完整回退副本；不要仅移走主数据库。
2. 校验备份并恢复至 manifest 原位置：

```powershell
npm run dmn -- backup-verify .dmn/backups/checkpoint-20261027
npm run dmn -- restore .dmn/backups/checkpoint-20261027 $database
npm run dmn -- status $database
```

3. 恢复不推理、不新建根 ID、不重排 unknown；先查队列、证明与预算，再决定是否显式 resume/pump。

恢复准备阶段失败留下 staging，不启动实例；提交途中失败保留 `.restore-incomplete` 并阻止启动。人工检查数据库/Runtime 是否完整配对、保留失败现场，再选择恢复已保存的整套副本或重新做完整恢复。不能只删除标记后继续运行。

备份支持 Schema v1–v7 并保留原版本，不自动迁移；旧库恢复后须按停机升级流程显式 init，P5 只读管理查询要求 v7。工具记录的是当前安装的 SDK/Cordis 版本，不保证任意外来 SDK 历史可读。未知日志版本或未闭合记录仍由原 inspector 拒绝，不能修改日志伪造完成证明。目录迁移、跨平台恢复、备份加密/签名留后续设计。

### 数据保留

默认完整保留消息、尝试、死信、审计、长期记忆及 SDK 历史；不设置自动 TTL、不自动删锁或裁剪日志。定期停机成套备份并检查存储空间，按业务保留期将已停机实例的整套备份放入私有归档；不要在线删库表或分开丢弃 Runtime。到期删除必须由用户单独授权，记忆删除及备份保留例外衔接 P7。此版本没有自动轮换或清理服务。

## 验收、证据与限制

对应门禁及最终数字见[证据说明](EVIDENCE.md)。测试命令：

```powershell
npm run check
npm test
npm run test:ui
# 显式付费：独立实例，4 次调用，131072 输入/4096 输出 Token，估算 $1：
npm run test:reliability:live
# 无 API：每轮约 5 分钟，250 个预定话题/1000 条正式回复：
npm run test:soak
```

自动化覆盖成套恢复、原位置保护、提交中断启动隔离、损坏备份、路径注入/Runtime junction、WAL 崩溃、FTS/私有记忆隔离、未处理队列、真实子进程突然退出、遗留 marker、审计事务失败、读取快照与并发 WAL 写入、分页及预算。

真实模型演练：第一条回复提交失败后从确认结果恢复一次；两个节点分别回复后停机备份、保留原数据并原位恢复，再各调用一次，均恢复原根；恢复后重复输入不重执行，4 次后预算停止。累计 4 次真实调用，两个根、4 条回复、零 peer 广播；私有身份保留且没有串入对端输入。SDK/Runtime `0.2.1-rc.3`、Cordis `4.0.5`，新增功能没有改动 SDK 协议；SQLite backup 用法核对了安装 Node 24 类型及[官方说明](https://nodejs.org/api/sqlite.html#sqlitebackupsource-destination-options)。

耐久测试预先固定 250 个测试话题、1000 条输入、13 次提交前失败、25 次结果提交故障/对账、5 次停机备份与重开。模型运行时为模拟实现，不产生 API 费用。两次中间版本与最终源码的三轮完整结果分别保留；一次发现指标回退问题后的过期测试被明确中止，不计为通过。最终轮核对启动时源码哈希，不将模拟用量当真实消耗。

当前验收针对 Windows/Node 24 的本地原型，不能替代 24 小时生产长稳、断电/磁盘满/真实网络长期故障验证；这些仍 NOT_RUN。模型非法 JSON 的概率性风险仍在，严格拒绝且不自动重放。数据完整保留会持续增长，需要用户按手册管理磁盘。未改变用户 Desktop 配置、原有数据库或旧进程，也未实施 P6。
