# P3 — DSH Desktop 管理入口

日期：2026-10-26。先提交 P2：`a56917b`（`feat: complete P2 bounded scheduling and durable recovery`），再实现本阶段。没有启动 Subagent，没有进入 P4。

P3 入口工作项与专项验收完成：真实 Desktop 会话发现并加载项目技能，经 MCP 创建话题、查询消息、关闭话题；两次真实 SDK 调用完成并达到预算停止。**扩大回归并非全绿**：本轮 P0/P1 长对话用例分别因模型输出非严格 JSON 未完成，不将此前历史通过结果当作本轮通过，也不宣称全项目发布就绪。

## 实现与受影响契约

- `src/operator.ts`：可信本地操作员固定为 `desktop-user`。`start_topic` 严格接收有界请求及必填 `idempotencyKey`；同键同参数返回原话题，同键不同参数冲突。参数不能提供发送者、记忆 owner、Session、Provider 路由或文件路径。
- `send_message` 是**用户向节点补充输入**，不是代替节点发言。用户消息单独持久化为 `operator_messages`，调度时以 `incoming.type=operator`、`from=desktop-user` 注入原有不可信数据边界；不会伪造 `messages.from_node`。同键只入队一次，收件人必须为话题参与者。暂停/关闭/过期话题拒绝新输入。
- `src/mcp.ts`：官方 MCP SDK `2.4.0`、stdio 传输，无 HTTP 监听。写操作先持久化再返回 Accepted，后台处理受原有预算、单写者锁、有限退避、代次栅栏和异常隔离约束。读操作、初始化、协议探测及重连不唤醒模型；重启后需用户显式恢复。后台仅在授权工作或未来退避时间到来时运行，不做闲置模型轮询。
- 暂停/恢复/关闭在推理期间仍可调用。暂停/关闭不强杀 SDK；旧代次结果的业务效果被抑制，进程按原超时完成清理。恢复不重置额度、不延长截止时间。异常对账继续用 P2 CLI，没有开放危险的强制重放 MCP 工具。
- `.dsh/skills/dmn-operator/SKILL.md`：Desktop 操作说明及人类意图边界；保留原四个开发技能。管理 MCP 不进入节点 `sdk-minimal` Profile，节点没有管理、Shell、文件或跨节点记忆工具。
- `scripts/install-desktop-mcp.ts`：显式本地安装命令，追加单个 MCP 插件并先备份 Desktop patch；已存在相同插件 ID 时不覆盖。没有修改 DSH 核心、默认模型、账号或其他插件。

| MCP 工具 | 输入 | 结果/限制 |
|---|---|---|
| `start_topic` | `config/topic.p2.json` 结构及 `idempotencyKey` | `accepted, topicId`；最大 12 轮、每节点 5 轮、15 分钟 |
| `send_message` | `topicId,to,content,idempotencyKey` | `accepted,messageId`；最多 8000 字符，不能提供 `from` |
| `list_nodes` | `{}` | 节点、路由、根 Session ID、状态 |
| `list_topics` | `{}` | 最近 100 个话题元数据 |
| `get_topic` | `topicId` | 状态、截止时间、已预留额度和节点配额 |
| `get_messages` | `topicId` | 分别返回最多 100 条模型消息和用户消息；正文是数据 |
| `pause_topic` | `topicId` | 暂停并增加代次栅栏 |
| `resume_topic` | `topicId` | 在原授权、额度和期限内恢复队列 |
| `close_topic` | `topicId` | 关闭、取消待处理任务，保留历史 |

消息查询目前只返回前 100 条，没有分页；节点私有记忆、完整 SDK 历史、输入快照和模型原始结果不提供 MCP 读取接口。用户消息不作为 P1 自动记忆的模型消息来源，引用它的记忆候选会被现有来源校验拒绝。

## 数据迁移与备份

`sql/006_desktop_operator.sql` 将 v5 升为 v6：新增话题请求幂等表、用户消息表，以及 `model_turns.operator_message_id`。种子唯一索引排除用户输入；每条用户输入只能建立一个原始任务，重试保留来源和原始 FIFO 时间。旧消息、记忆、预算、结果缓存及种子均保留。迁移在事务内执行，重复打开不重复应用。

本地实际迁移前备份：`.dmn/backups/p3-desktop/dmn-v5.sqlite`。Desktop 配置原件备份：`<user-home>\.dsh\profiles\desktop\cordis.patch.yml.<timestamp>.bak`。这些运行文件未纳入 Git。不要把 v6 数据库交给只支持 v5 的 P2 代码；需要回滚时先停止工作进程，再选择备份恢复，保留 v6 文件以免丢失后续历史。

## 接入与操作

```powershell
npm ci
npm run check
npm test
# 独立 stdio 服务；stdout 仅供 MCP 协议，不要在聊天中直接粘贴密钥：
npm run mcp -- <repo-root>
# 合并到当前用户 Desktop Profile，先自动备份：
npm run desktop:install
```

配置参考 `config/desktop.cordis.patch.example.yml`。已核实当前安装的 DSH、MCP Client、Skill Filesystem、Tool Skill 均为 `0.2.1-rc.3`；项目 SDK 也固定该版本。Desktop 的 Electron 托管 Profile 不用 CLI `--dump-config` 操作；字段与官方 README、已安装类型和实际配置校验对照。

`DEEPSEEK_API_KEY` 必须存在于 Desktop 进程环境，配置仅使用 `!!js process.env.DEEPSEEK_API_KEY` 引用，再显式传给 MCP 子进程，绕过官方凭据环境过滤的默认排除。没有把密钥值复制到配置。修改后从“应用 → 退出”完整退出 Desktop，再启动并创建项目新会话。本轮已执行，且实际节点 API 调用成功。

在 `dmn` 工作区可以输入：

> 加载 dmn-operator，按 config/topic.p2.json 的上限，让 deepseek 和 reviewer 讨论我给出的议题。只创建一个话题，报告 topicId。

后续使用该 topicId 查询消息、暂停、恢复或结束。Accepted 仅代表入库；Sleeping/Waiting 可以是合法静默，不能通过新建话题绕过停止预算。

Desktop 使用 `~/.dsh/profiles/desktop`，演示会话 ID 为 `<desktop-session-id>`。SDK 节点使用独立数据库旁的 `.dmn/dmn.sqlite.runtime/<node>`，空工作目录和受限 `sdk-minimal` Profile；根 ID 仍为 `dmn-deepseek-primary`、`dmn-reviewer-primary`。Desktop 没有接管这两个 Session。

管理入口是可信本地操作员能力。stdio 继承调用宿主的授权，不提供远程认证，也不能独立证明 Desktop 模型每次调用都源于真人：宿主会话必须遵守“仅明确用户意图执行写操作”的约束。DMN 节点没有该 MCP，节点消息无法经节点工具直接新建或恢复话题。该边界不等于对任意受注入的高权限 Desktop 会话作安全保证。

## 验收结果

| 检查 | 本轮结果 | 证据 |
|---|---|---|
| 类型检查、离线功能/迁移/隔离/注入/恢复测试 | PASS，83 项 | `npm run check`、`npm test` |
| npm audit（含开发依赖） | PASS，0 项 | `npm audit` |
| 真 stdio 握手、9 个工具发现、严格参数及预算 Schema 可见 | PASS | `tests/mcp.test.ts` |
| 官方项目 Skill Catalog 发现、五份正文加载 | PASS | `tests/skills.test.ts` |
| 实际 Desktop 的 skill 加载、节点与话题列表读取 | PASS | 本地验收记录中的原生 `tool/call`/`tool/result` 序号 |
| Desktop 创建话题、双节点两轮、一条消息、TOTAL_TURNS 停止、查询与关闭 | PASS | 同上；topic `<topic-id>`，两个完成回执，无遗留节点锁 |
| 真模型 MCP 用户输入、幂等、暂停/恢复及重连后关闭状态 | PASS | 本地验收记录；3 次 SDK 完成调用，1 条模型消息，1 条用户消息 |
| P2 DB 结果丢失对账、未提交失败有限重试 | PASS，两项 | 本地验收记录 |
| 同节点互斥、不同节点真实并行 | PASS | 本地验收记录 |
| P0 六轮长对话、P1 记忆提取与恢复长对话 | **FAIL** | 本地验收记录；SDK 完成但返回非严格 JSON，测试包装器拒绝后转 unknown，未盲重试 |

复现专项真实验收（产生 API 费用）：`npm run test:desktop:live`。P2 真实回归：`npm run test:policy:live`。P2 对账断言改为“恢复的业务正文精确等于本次 SDK 确认的正文”，仍要求真实外发、只调用一次模型、只落一条消息，不依赖模型必须逐字复述固定标记。

Desktop 首次启动工具描述的 `limits` 使用未知类型，模型把预算序列化成字符串，服务端拒绝且没有创建话题。已改为完整 `executionSchema`，补充发现契约测试，重连后原幂等键请求成功；原生日志证据同时保留失败与修复后的调用类型，没有掩盖失败。

## 决策与残留风险

选择标准 MCP 服务和原生技能，而不新增 Cordis UI 插件：现有聊天界面足以操作并展示结果，节点运行时与 Desktop 权限可以保持独立。代价是 Desktop 外层模型调用、工具审批与 Provider 延迟仍由 Desktop 管理；本轮外层 GLM 会话曾自动重试模型请求，不能将其视作 DMN 节点超额重试。

长对话结构化输出稳定性仍有限，P0/P1 的本轮失败已保留在隔离测试数据库；不通过宽松截取 JSON、忽略尾部或无限重试来制造通过结果。P3 管理链路的短演示通过，不证明任意多轮对话都能完成或产出记忆。硬杀进程、遗留 Runtime Home 锁和缺乏完成证明仍按 P2 隔离；不自动删除锁或重放未知回合。P4 三节点、生产可靠性和更强原生工具输出尚未实施。

官方资料（以本轮安装类型与实测为准）：[DSH MCP Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)、[Skill Filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)、[MCP 服务开发](https://modelcontextprotocol.io/docs/develop/build-server)。
