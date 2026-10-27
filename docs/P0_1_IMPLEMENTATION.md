# P0.1 实施与验证记录

日期：2026-10-26。范围：P0 的契约与持久化子阶段，**不是新增顶层里程碑，也不是 P0 完成验收**。

## 结果

本目录从设计包增加了可运行的 TypeScript 存储核心。无子代理、无模型请求、无网络服务监听；没有修改现有 DSH Profile、凭据或 Desktop 会话。

| 实现 | 文件 | 行为 |
|---|---|---|
| 消息与配置契约 | `src/contracts.ts` | Ajv 2020 严格使用既有消息 Schema；Node、Topic、策略用严格对象校验；拒绝未知字段、重复节点/Session/命名空间和占位路由 |
| 公共错误边界 | `src/errors.ts` | 固定错误码及受控提示，不透传模型内容、YAML 值或 SQL 异常 |
| 持久化 | `src/store.ts` | SQLite WAL、外键、FULL 同步、5 秒锁等待；同步 `BEGIN IMMEDIATE` 事务；版本化迁移 |
| 管理与消息总线 | `src/gateway.ts` | 注册节点、人工创建话题、暂停/关闭、审计；绑定身份的消息能力；事务提交后返回 Accepted |
| 命令行 | `src/cli.ts` | 配置校验、数据库初始化/迁移、只读状态查询；始终报告 `executionEnabled: false` |
| 自动化验证 | `tests/*.test.ts` | 契约、安全边界、事务故障、进程丢失、迁移、CLI |

### 受影响契约

- `schemas/message.schema.json` 保持原样。完整业务 Message 只能由服务端生成 ID、时间及 `from` 后再校验。
- 模型发送输入仅允许 `to/topicId/type/content/replyTo/expectReply/idempotencyKey/expiresAt`。未知属性，包括 `from`、权限及工具列表，一律拒绝。默认 `type=chat`、`expectReply=false`。
- `bindNode(trustedNodeId)` 只能由可信宿主/未来 Runtime Adapter 调用；不得暴露为模型工具或 HTTP 参数。它返回四种闭包能力：`send/getInbox/getThread/listPeers`，每种操作另查绑定节点的工具白名单。模型不能获得 Gateway 或 Store 对象。
- 节点配置、路由、Session、命名空间、人设路径及工具白名单注册后均不可重绑。工具白名单排序后持久保存；旧数据库升级默认空白名单。`model_decline_message` 目前仅被配置语法识别，未注册为可执行工具。
- 接收方必须同属话题且不能是发送者；`replyTo` 必须引用同话题反方向的消息。
- 同一 `(from, topic, idempotencyKey)`、同一内容返回原 ID；参数改变返回 `CONFLICT`。在话题暂停/关闭后，完全相同的请求仍可取得原入队回执，不会新增投递。回执的 `status=queued` 表示最初入队事实，并不声明当前处理状态。
- Inbox 只查自己的待处理投递并过滤过期消息；Thread 只查自身直接参与的消息；各最多返回 100 条。没有私有记忆 API。
- Topic 必须包含至少两个已注册节点、明确轮数上限及未来截止时间。发送入口拒绝暂停/关闭/到期或持久化总轮数已耗尽的话题。这里**没有推理预算扣减/预留**。
- 策略配置中的 Token/费用必须为正数，安全开关不可放宽。当前只校验策略，尚未连接运行时执行；不能据此声称运行时限额已实现。

## 迁移

保留原 `sql/001_init.sql`；新增 `sql/002_node_capabilities.sql`，为 `model_nodes` 增加 `allowed_tools_json`，默认 `[]`，带 JSON 数组约束。

- 新空库：同一事务执行 001、002，设置 `PRAGMA user_version=2`。
- 已标记 `user_version=1` 的 DMN 数据库：事务执行 002，保留原节点，权限默认为空。
- 未标版本的非空数据库、未来版本数据库：拒绝打开，不猜测其结构，不自动修复或覆盖。
- `status` 使用只读连接，不迁移数据库。`init` 是显式迁移入口。
- 迁移前应保留原数据库的一致备份；本轮仅创建项目 `.dmn/dmn.sqlite` 新空库，没有迁移任何用户现有数据库。测试在临时目录创建合成旧库。

## 架构决策

选择 Node.js 内置 `node:sqlite`，避免额外原生二进制依赖；SQLite 对每个消息、投递、事件使用同一事务。替代方案是第三方 SQLite 驱动或仅内存队列，前者增加本地构建依赖，后者不能满足持久化目标。代价是 Node 版本门槛及实验性 SQLite API，当前不适合高吞吐服务。

身份通过闭包绑定，替代模型提供 `from` 的方式。节点对象不含管理入口或通用记忆入口。仅消息内容是外部数据，不能改变宿主权限。未实现 Prompt 组装和模型行为验证，不能把此边界测试解释为提示注入已端到端解决。

## 版本关卡（当前实测）

| 项目 | 结果 |
|---|---|
| 系统 | Windows x64；工作目录 `<repo-root>` |
| Node / npm | `v24.14.0` / `11.9.0` |
| SQLite | `3.51.2`（Node 内置） |
| TypeScript / tsx / Node 类型 | `7.0.2` / `4.23.15` / `24.19.2`，锁定于 package-lock |
| `dsh --version` | 实际输出 `0.2.1-rc.3` |
| dsh 命令来源 | `%APPDATA%/npm/dsh.ps1`，转发到 Desktop 的 `resources/runtime/cli/bin/dsh.cmd` |
| 全局 npm 旧包 | `@deepseek-ai/dsh` 和 SDK Server 的 package.json 为 `0.1.7-rc.1`，与上述入口不同，不能混用 |
| 项目 SDK Client/Runtime | 未安装、未启动；没有 SDK 或 Cordis API 调用 |
| npm 对目标 SDK 的查询 | `@deepseek-ai/dsh-sdk-client@0.2.1-rc.3` 声明精确依赖 `@deepseek-ai/dsh@0.2.1-rc.3`；仅元数据核查，未证明可运行 |
| 独立 SDK Profile / Provider / Model | 未配置或运行探测；示例仍为占位符，并被配置校验拒绝 |
| `session/resume` | 官方当前文档描述了此能力，但目标版本本地未实测 |
| Skill Provider / Tool Skill / Agent Instructions | 项目模板存在；实际 SDK Profile 插件启用状态未验证 |

官方参考：[SDK Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[SDK Protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)。已核对当前文档中的固定会话、Resume、入队与 Idle 区别；这些是 master 文档，后续实现必须继续核对实际安装版本的类型与源码。

## 运行与复现

在项目目录 PowerShell 执行：

```powershell
npm ci
npm run check
npm test
npm run dmn -- help
npm run dmn -- init .dmn/dmn.sqlite
npm run dmn -- status .dmn/dmn.sqlite
# 替换占位路由和额度后，可仅校验自己的本地文件：
npm run dmn -- validate config/nodes.local.yaml config/policy.local.yaml
```

`.local.yaml`、`.env*`、数据库和 node_modules 均已加入忽略规则。校验通过不代表路由可用，也不会启动模型。此目录目前没有 Git 仓库，尚未创建提交。

## 自动化测试与适用性

本轮最终运行 `npm run check` 通过，`npm test` **20/20 通过**。先添加测试并运行失败，再实现对应能力。测试环境为上表版本；测试数据全部合成，无真实凭据。

| 用例/测试 | 前提与操作 | 实际结果 | 结论 |
|---|---|---|---|
| A01 | 校验缺字段、空内容、system 类型、额外字段、非法时间 | 全部拒绝 | PASS |
| A02 | 绑定 A 后提交 `from=admin` | 拒绝；合法发送显示 A | PASS |
| A03 / E06 存储边界 | A/B 话题向 C 或自己发送 | 拒绝且无投递 | PASS |
| A04 | 同键重放、改内容重放、重新打开数据库后重放 | 原 ID 唯一、冲突拒绝、审计仅一条入队 | PASS |
| A05 | 用 SQLite Trigger 分别注入 Delivery 和 Event 写入失败 | Message/Delivery 一并回滚；移除故障后可继续发送 | PASS |
| E01 | 子进程提交后 `process.exit(23)`，故意不 close；另一个进程重开 | 消息和待处理投递仍存在 | PASS |
| D01 存储边界 | 检查节点能力，尝试未知参与者 | 没有建话题/邀人能力；未知节点拒绝 | PASS（该层） |
| 暂停/关闭/到期 | 发送新请求与重复旧请求 | 新请求拒绝，原回执可读，历史保留 | PASS（该层） |
| D02 存储边界 | 测试连接将已用轮数设置为总上限 | 新发送拒绝 | PASS（该层）；自动轮数预留及停止 NOT_RUN |
| E04/E05 宿主边界 | 消息中嵌入 SYSTEM、越权记忆/工具要求 | 仅作文本存储，无 Shell/记忆能力；审计不含正文 | PASS（该层）；模型与记忆隔离验收 NOT_RUN |
| 绑定与权限 | 尝试重绑路由/Session/命名空间/工具，重新打开数据库 | 拒绝重绑；白名单仍生效 | PASS |
| 迁移 | 合成 v1 升级、重复打开、未知版本及无标记非空库 | v2 保留节点且权限为空；不支持的库拒绝并保留数据 | PASS |
| CLI / 配置 | 新库 init 两次，status 查询不存在库，YAML 注入未知 secret 字段 | 初始化可重复；status 不建库；错误不含 secret 值；配置校验不执行模型 | PASS |
| B01–B07 | 未安装项目 SDK / 未接独立路由 | 无真实会话、五轮通信、单写者、Idle 或 Resume 验证 | NOT_RUN |
| C01–C07 / D03–D08 运行时 / E02–E03、E07–E08 | 记忆、调度器、预算预留、重试和运行时未实现 | 不作通过推断 | NOT_RUN |

证据定位：`tests/contracts.test.ts`、`tests/persistence.test.ts`、`tests/recovery.test.ts`、`tests/cli.test.ts`；测试名称包含对应边界，`npm test` 可复现。E01 不代表机器断电、磁盘损坏或 SDK 已收 Prompt 后的恢复。

手工验证：`init .dmn/dmn.sqlite` 返回 `initialized=true,schemaVersion=2`；`status` 返回全部计数为零、`executionEnabled=false`；`validate` 两个原始 example 文件返回 `VALIDATION`，符合占位配置不可运行的预期。

## 已知风险与下一个 P0 步骤

1. 尚无 Runtime Adapter、Wake Scheduler、节点锁、Delivery 领取/确认或模型发送解析，不能进行自动通信。
2. Token/费用、单节点轮数、连续消息和预算原子预留未落地；不要将 Gateway 接入自动推理循环。
3. 长期记忆表来自既有 SQL，但没有记忆 API、提炼或检索。P1 隔离验收尚未开始。
4. 当前节点 API 是进程内可信边界；网络身份认证、HTTP/MCP 服务和 Desktop 集成未实现。
5. SQLite 在当前 Node 仍打印 ExperimentalWarning；应保持锁定环境。只验证了进程退出与事务失败，没有验证电源故障、网络文件系统或大规模并发。
6. 数据库保存消息正文，审计省略正文；没有自动识别/擦除正文中的任意密钥。接入方不得提交真实凭据。
7. 旧 v1 节点升级后无工具权限；目前没有权限管理 API，需要后续显式管理迁移，不能靠模型改配置授权。
8. P0 下一步先安装隔离且匹配的 SDK/Runtime，核实独立 Profile、可用路由和无高危工具能力，再测试固定根 Session/Resume；之后实现单写者调度及预算安全底线，完成 A→B→A 至少五轮实测。P0 完成前不进入 P1–P4。
