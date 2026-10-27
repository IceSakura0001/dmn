# Desktop-N implementation record

## N0 — PASS (2026-10-27)

Installed Desktop `0.2.1-rc.3`, build `be72761ee1a6736ebcdf4f3739363b083ae53c98`; bundled Runtime/SDK `0.2.1-rc.3`, Cordis `4.0.5`, runtime payload Node `24.21.0`. Repository Node `24.14.0` is separate from the Desktop payload.

Public interface matrix (N0 时点评估；后续实现/实测见 N1–N5 记录):

| Capability | Evidence | Status |
|---|---|---|
| Global native panel | `main` keyed slot, `ctx.layout.selectPanel` | Real Desktop PASS |
| Native navigation | `sidebar.panellist`, matching panel ID | Real Desktop PASS |
| Host communication | `ctx.connection.fetch.register`, exact GET route | Real Desktop PASS |
| Disposal/HMR | Official Desktop CLI add/remove local bundle; navigation/body withdrawn | Real Desktop PASS |
| Client resource loading | `dsh.client`, `./client`, shared React module table | Real Desktop PASS |
| Settings | `settings.section` / `configForms` | Documented; final settings NOT_RUN |
| Credentials | Owner credential service; environment references | Existing API; new credential UI NOT_RUN |
| Child process ownership | Node child-process primitives under Cordis effects | N1 NOT_RUN |
| Distributable installer/update | Official profile manager with pnpm forwarding | N4 NOT_RUN |

The minimal plugin is `plugins/dsh-dmn`. Real Desktop showed “DMN 原生扩展验证”, loaded two configured nodes through the Host, and displayed “宿主读取成功 · 模型调用 0 次”. The isolated QA database retained zero turns. Official CLI removal withdrew the native navigation and panel without modifying DSH core. Existing profile bundles/dependencies and user patch were checked after removal; local backup retained. pnpm recomputed its lock, so byte-identical lock restoration is not claimed.

Prototype unit tests: 3 PASS. No model requests, topic writes, SDK processes or production database migration. The user profile has a pre-existing incompatible `dsh-subagent-codex@0.2.1-rc.2` warning; no exemption was granted and no such agent was invoked. It did not block this native panel gate.

Architecture selected after the gate: a native global panel using shared React/official slots, a Host-owned authenticated bridge, and one separately supervised DMN service per physical instance. No iframe/external Web replacement, no direct database access from the renderer. N0's isolated read-only SQLite probe will be replaced in N1.

Sources checked against installed package READMEs and official repository: [layout](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/README.md), [sidebar](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/README.md), [module system](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/modules/README.md). Installed Desktop CLI `dsh plugin --profile desktop` supports management of the Electron-owned profile; ordinary npm CLI profile boot does not replace the Desktop carrier.

## Remaining gates

N1 service ownership, N2 interaction, N3 controlled recovery, N4 installation/upgrade and N5 real release acceptance follow in order. No later gate is passed by the N0 demonstration.

## N1 — 单实例与生命周期（2026-10-27）

已实现命名管道服务、能力令牌、Host 所有权握手、CLI client 与 MCP 自动连接现有服务。启动及重连只读，不自动恢复队列；关闭面板不停止服务，拥有者卸载通过私有 stop 与父 IPC 断开停止新调度并等待当前调用结束。借用者不能停止服务，遗留锁保持隔离。无 Schema 变更。

真实 rc3 Desktop 加载 N1：面板读取两个 sleeping 节点、0 次模型调用；CLI 经同一管道确认服务 PID、凭据仅报告 configured。重复读取未创建新实例；官方 CLI 卸载后 owner/endpoint 消失，该 PID 已退出，数据库保留。模拟用例另覆盖鉴权、重复请求、遗失响应、停止期间后续队列保留与重启零调用。

验证：127 个核心测试、4 个插件测试、TypeScript 检查通过（新增响应丢失用例之后以最新测试总数为准）。安装/卸载日志仅保留在忽略目录，不公开用户配置或凭据。旧 rc2 Codex provider 不兼容告警保持原状，未授予豁免，未启动子代理。

限制：进程崩溃后残留 owner 不自动清除；须诊断并证明旧活动已停止，不能通过重启绕过 Runtime/unknown 隔离。源码开发包依赖本仓库 node_modules，正式分发在 N4 完成。

## N2 — 原生双节点交互（2026-10-27）

原生 React 主面板提供 A/B 名称、模型、职责、固定根会话和真实状态，明确选择收件人；话题创建、有限讨论、时间线、回复关联、分页和暂停/恢复/结束均复用现有 OperatorService。Host 桥接只接受严格类型业务请求，不接受路径、发送者或任意服务方法。未知响应将完整原请求及幂等键暂存本地，刷新/重开不自动重发；已明确拒绝的操作解除本地待确认标记。消息按纯文本显示。无 Schema 迁移。

自动化：128 核心测试、5 插件测试、1 原生组件 Chromium 测试、TypeScript 检查通过；Chromium 使用真实同一 React 组件、Host 桥接和命名管道，仅 RootRuntime 模拟。已验证 A/B 各一次、响应丢失后重开同键重试无重复、纯文本脚本、暂停/恢复/结束与 390px 布局。

真实 rc3 Desktop：首次加载/直接创建零推理；A 输入得到 N2_NATIVE_A_OK，replyTo 和完成 turnId 对应固定 dmn-deepseek-primary，证明缓存标识 completed/sessionMatches/validEnvelope。B 的首次人工发送因 5 分钟话题截止被拒绝，未进入模型；真实 B 与讨论验收留给 N5，不将模拟 A/B 冒充真实双模型验收。

保留失败：最初一次 A 调用读取了 DSH 旧通用凭据，SDK 终止 AUTH/401；结果隔离后通过已有只读 proof 确认 quiescent，再在停机条件下原 turnId 显式 drop，保留审计及已消费预算。现使用 DMN_DEEPSEEK_API_KEY 专用安全引用，环境 DEEPSEEK_API_KEY 作为回退，不修改用户 DSH 原凭据。环境凭据只读认证检查成功（官方 /user/balance 接口；未记录余额）。原生验收累计 2 次活动，其中 1 次失败、1 次成功，整体上限仍为 6。

限制：N3 维护入口、N4 分发与 N5 完整真实验收尚待后续里程碑；当前是原生业务界面通过，不声明完整发布。

## N3 — 诊断与受控恢复（2026-10-27）

独立维护 route 与能力令牌提供证明对账、精确 turnId/原因放弃和过期隔离；身份固定 desktop-user。读诊断仅返回队列/轮次/死信/证明类别/预算与用量，不含私有 Prompt、原文 SDK 日志或记忆。服务忙时拒绝恢复写操作。文件维护由不带模型凭据的一次性进程执行，先停止并等待拥有的服务；借用者不停止原服务。

停机备份/校验与原位恢复现已接入原生管理区。恢复持有维护屏障，先保留旧数据库/Runtime 成套数据，再发布已校验快照；中断留 restore-incomplete 隔离。旧 restoreBackup 默认仍只接受空原位，替换必须显式 preserveExisting。无 Schema 迁移。

真实 rc3 Desktop 验收：读到遗留服务 PID 已退出、blocked=true、automaticLockRemoval=false。经明确实例 ID/PID/原因归档旧登记，重连后仍为原 2 次活动（1 failed、1 completed），未重放。随后原生按钮生成备份 `<backup-id>`，Schema 7、7 个文件；校验通过，原位恢复返回 previousPairPreserved=true、inferenceStarted=false，旧数据对保留在忽略目录。

自动化：131 核心测试、7 插件测试、原生 Chromium 组件测试和类型检查通过。包括忙碌拒绝、路径/身份伪造、独立维护 header、原位恢复留旧数据、活跃客户端屏障、未知不重放、Runtime 锁阻止旧 owner 归档及审计失败恢复原登记。既有 P5 中断恢复/SDK 进程损失/审计回滚用例继续通过。

发现并记录：Desktop 对宿主依赖模块有导入缓存，源码热更新不足以验证 Host 变化，正式安装/升级要求完整退出后重启。一次服务进程离线留下登记，系统保持 fail-closed，未推断崩溃原因或强制删除 SDK 锁。

## N4 — 安装、配置、升级与卸载（2026-10-27）

交付完整源码 ZIP 发布器、Node 24.x / Desktop rc3 / SDK rc3 检查、PowerShell 安装器、官方设置页与原生首次配置。默认数据、配置和日志均在用户 DSH Home，插件升级或卸载保留数据。安装使用官方 CLI 本地链接，不修改核心或豁免旧版本插件；已有实例升级前自动停机成套备份，结果返回备份位置。配置严格校验路径、revision、凭据引用和支持模型，已有节点禁止模型路由重绑。

真实验证：已执行正式卸载/安装；候选源码包 7489f59 解压到新目录，无 node_modules，安装器完成 npm ci、构建及注册后，真实 Desktop 发现两个 sleeping 节点、空话题、0 次调用。官方设置中的 DMN 页显示协议/Schema/凭据存在状态；通过界面选择已有 native-dev 实例并保存，无手工修改配置文件。随后正常退出，用当前源码重新安装升级，生成原实例成套备份，保留已消费的 2 次活动及根历史。

候选包：209 个条目，无 .dmn/.git/node_modules/数据库/.env；带 release-manifest 和 SHA-256，候选校验值 2f85348a83f7401646cb62644afacde212860a0cb7dfe5b577d4aff0ffb55dfa。正式 N5 包将从最新提交重新生成，不能将该候选哈希当作最终版本。

真实配置切换暴露旧全局待确认记录的实例归属问题，现改为按 instanceId 保存、恢复和重试；所有业务写入/维护通过 Host 绑定实例，旧页面不能向新实例写入。旧格式记录只在匹配原话题的实例提供显式重试，不静默丢弃。新增回归覆盖外来实例待确认记录、实例变化拒绝及零额外调用。

验证：9 插件测试、原生 Chromium、类型检查通过；安装器版本检查及停机升级通过。修复 Windows PowerShell 5.1 将原生 stderr 告警当失败的问题，以及 Get-FileHash 模块自动加载缺失时的打包问题，现使用进程退出码与 .NET SHA-256。

限制：仅 Windows rc3 实测，首次安装需 registry 网络和 Node/npm；完整源码包必须保留原解压位置，不能单独发布插件子目录。真实密钥本轮经环境/官方 resolve 读取；设置页面写密钥的单元测试使用假值，未改写用户已有真实凭据。完整真实双模型、安装后故障/幂等与最终包验收继续由 N5 完成。

## N5 — 真实 Desktop 与 SDK 验收（2026-10-27）

原生 v0.1.0 核心验收通过。真实活动累计 6 次、5 completed、1 保留的 AUTH/401 failed、0 unknown。A/B 分别产生关联输入的正式回复；A→B→A 三轮讨论在 TOTAL_TURNS 停止，真实界面恢复原预算返回 BUDGET_EXHAUSTED，调用数保持 6。

每个成功轮次另用独立只读 SDK v4 日志检查器检查 receipt、根会话、路由、无工具请求及 completed 终态，未用 Accepted 代替完成。N5 四次输入仅含本节点人工审阅的合成 Identity，不含对端标记；所有输出均未泄露任何标记，跨 owner 读取被拒绝。关闭/重开原生面板保留历史和原服务 PID，未额外调用。

六次活动后的数据库和 Runtime 再次停机成套备份、校验和原位恢复，旧数据对保留；节点、话题、预算、轮次、幂等请求、消息、回复和记忆共 12 张表的行数/逻辑 SHA-256 完全相同。随后正式卸载、重新安装，逻辑摘要再次相同。公开摘要不含 Prompt、Identity 正文或原始 SDK 日志。

最终回归：131 核心离线、9 插件/进程测试、1 原生 Chromium（含丢响应/重开/跨实例/分页/正文脚本/窄屏）、3 兼容 Web Chromium、类型检查全部通过；真实只读验收验证器通过。最终源码包在 Git 仓库外的独立 npm ci / 正式安装 / 真实 Desktop 重开复核通过，见 N5 报告。

支持范围仍为 Windows rc3 和现有两个 DeepSeek 模型；不声明跨 Provider、跨平台、任意未知故障自动清锁或本轮长稳。真实费用未从估算预留推断。
