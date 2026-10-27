# P1 私有长期记忆 — 实施与验收

日期：2026-10-26。结论：P1 工作项完成。记忆拥有者隔离、来源验证、候选提炼、去重/显式冲突、版本化修订、逻辑删除、FTS5 检索及真实模型注入已验证。P2 完整恢复、重试和 Desktop 集成不在本轮范围内。

## 结果与实现

| 文件 | 实现 |
|---|---|
| `src/memory-contracts.ts` | 四层分类、严格候选契约、内容规范化、拥有者字段拒绝、凭据样式检查 |
| `src/memory.ts` | 绑定身份的私有 API、来源追溯、候选去重/冲突、版本检查、修订快照、逻辑删除和有界检索 |
| `src/model-output.ts` | 外发建议新增可选 memories 数组，单项候选独立校验 |
| `src/runner.ts` | 仅注入本节点记忆；已完成轮次提炼与消息/投递确认同事务提交 |
| `src/dsh-runtime.ts` | 记忆为非特权数据；同一轮输出候选，无额外模型活动；原生工具仍为空 |
| `src/cli.ts` | 本地人工记忆查询、提议、来源、修订、冲突处理、归档/删除和 Identity 管理 |
| `sql/004_memory.sql` | 版本 4，候选冲突、轮次批次幂等、来源类型与完整修订元数据，FTS5 trigram 重建 |

选择同轮结构化提炼，而非另开后台模型提取任务，避免产生预算外推理或同根 Session 并行写入。选择 SQLite FTS5 trigram，而非向量库，保持 P1 的本机依赖与事务边界；短词检索退回拥有者过滤后的子串查询。

## 契约与信任边界

### 绑定身份

只有可信宿主可调用 `MemoryManager.bindNode(nodeId)`。返回的闭包能力不包含 Store、Manager、Shell、文件读写或更换拥有者的方法。每次读取、检索、来源、历史、候选查询、修订和删除都在 SQL 中限制 `owner_node_id`。

模型请求若携带 `ownerNodeId`、`owner_node_id` 或 `from`，返回 Forbidden。请求不存在或不属于自身的 Memory ID，同样返回 Forbidden。不能通过来源查询、修订历史或冲突候选绕过拥有者边界。

本地 CLI 是可信操作员入口，操作者可以明确选择节点；它不是多用户网络鉴权服务。后续 MCP/HTTP 必须从真实认证上下文绑定节点，不能直接把调用者提交的 nodeId 当身份。

### 四层记忆

- **Identity**：仅宿主人工设置、带版本更新或逻辑删除。节点可以读取自己的附注，不能通过候选、普通修订或删除修改 Identity。主 Persona 文件保持独立。
- **Episodic**：来源可追溯的经历摘要。
- **Semantic**：来源关联的知识/观点，不能因为被保存就称为事实已验证。
- **Relationship**：必须 `subjective=true`，同一交流可以在不同节点中形成独立判断。

每条记录返回内容、分类、主观标记、confidence、importance、sourceMessageIds、version、时间和 provenance。`candidate` 标为 `source-linked-unverified`；人工 Identity 为 `human-reviewed`；旧数据为 `legacy-unreviewed`。旧数据保留可查，未经重新审核不自动进入模型 Prompt。

### 候选协议

原有 send/decline/silent 响应保持兼容，可以增加可选 `memories`，最多三项；Prompt 建议最多一项以控制输出长度：

```json
{
  "action": "silent",
  "memories": [{
    "kind": "semantic",
    "content": "消费者的去重记录与副作用应在同一事务中提交。",
    "subjective": false,
    "confidence": 0.85,
    "importance": 0.8,
    "sourceMessageIds": ["实际 incoming.id"],
    "claimKey": "consumer-atomicity"
  }]
}
```

每项内容最多 1,000 字符，来源 1–8 个且不重复。confidence <0.7、importance <0.55 或非主观 Relationship 不保存。拒绝无来源、未知来源、对本人不可见的来源、额外权限字段、Identity 候选和凭据样式内容。

运行时更严格：`acceptTurn` 要求对应 Turn 已 completed、确属该节点，而且候选来源只能是本轮实际入站 Message ID。首次唤醒无 incoming，不接受无来源候选。宿主不会采信模型填入的 owner 或 turn；模型也不能把猜测出的旧消息 ID 当成本轮证据。进程内私有 API 的人工调用可引用本节点直接收发过的历史消息。

**来源校验只证明消息存在、节点可见和本轮实际收到，不证明记忆内容被来源蕴含，更不证明来源说法真实。** confidence 是候选自述，保留不等于外部事实核验。

### 去重、冲突和修订

- 内容按 NFKC、空白折叠和小写规范化。在 `(owner,kind,contentKey)` 范围去重，重复返回原 ID，保留原置信度和证据，不静默覆盖。
- 同一 `(owner,kind,claimKey)` 的不同内容进入私有冲突表。旧记录不变；必须显式 resolve 或 revise，附 expectedVersion 和 reason。
- claimKey 是稳定断言标识，类型和断言身份不可通过修订更换。没有 claimKey 的语义矛盾不会被通用语义检测器发现；本轮没有实现通用自然语言矛盾识别。
- 修订保存旧/新内容及完整元数据、来源、版本快照。旧版修订原文保留，并标记 `legacySnapshot=true`；缺失的历史元数据不伪造补全。
- `delete` 与 `archive` 均为逻辑移出活动记忆：设置 archived_at、增加版本、保留私有修订历史。检索和直接读取不再返回；同内容候选重放返回 ARCHIVED，避免原样自动恢复。

**逻辑删除不会擦除消息、SDK 历史、修订、WAL 或备份，也不能保证模型忘记已读内容。** 改写后的类似候选仍可能重新形成；物理遗忘和传播撤回属于后续保留策略。

## 私有 API 与命令行

| API | 输入 |
|---|---|
| get / sources / history | Memory ID 字符串 |
| list | kind?、sourceMessageId?、limit?，默认 20、最多 100 |
| search | query、limit?（3–8，默认 5）、kind? |
| propose | 候选结构；不含 owner |
| revise | 候选字段 + memoryId、expectedVersion、reason；分类保持原值 |
| delete / archive | memoryId、expectedVersion、reason |
| listCandidates | status?，默认 conflict，最多 100 条 |
| resolveConflict | candidateId、expectedVersion、reason |
| setIdentity（宿主专用） | owner 单独绑定；content、reason、更新时的 expectedVersion |
| deleteIdentity（宿主专用） | owner 单独绑定；memoryId、expectedVersion、reason |

示例：先完成一次模型讨论，数据库中有注册节点，再运行以下命令。查询不调用模型：

```powershell
npm run dmn -- run config/nodes.deepseek.yaml config/topic.p0.json .dmn/discussion.sqlite
npm run dmn -- memory .dmn/discussion.sqlite reviewer list
npm run dmn -- memory .dmn/discussion.sqlite reviewer search config/memory-search.example.json
# 以下是显式的人工 Identity 设置；更新已有记录须在 JSON 中加入 expectedVersion：
npm run dmn -- memory .dmn/discussion.sqlite reviewer identity config/memory-identity.example.json
```

命令通式：`memory <db> <node> <action> [request.json]`。action 支持 list/search/get/sources/history/propose/revise/archive/delete/candidates/resolve/identity/identity-delete。get/sources/history 的请求文件为 `{"memoryId":"实际 ID"}`；没有 request.json 时请求为 `{}`，仅适用于无需必填参数的操作。

公开状态和审计不包含记忆正文、原始候选或人工 reason。只有操作者明确调用私有读接口才返回正文。凭据检查能拦已知环境秘密和常见样式，不能保证识别所有未知秘密；不要把真实凭据放进话题、消息或记忆。

## 检索与 Prompt 注入

FTS5 使用 trigram 索引；查询先拆成字词和中文三字子串，并引用为字面量，不能注入 FTS 布尔运算或列选择器。短于三字符且无可用 trigram 时，用同节点 SQL 子串查询回退。检索最多 3–8 条参数范围内的实际命中，不以他人记录填满结果。

每轮最多注入三条人工 Identity 和五条相关记忆。顺序为节点身份附注、当前话题、privateMemories、外部 incoming。身份、安全边界仍由受限 Persona/系统提示管理。Prompt 过滤掉未审核旧记录、低置信/低价值项和不可验证来源；检索 API 仍允许操作者查看自己迁移保留的数据。

Identity 和私有记忆都不是提升工具或权限的指令。运行节点仍没有原生工具，只能通过同轮结构化候选访问自己的记忆能力。已测样本没有跨节点注入或私有验证码外发；没有实现保证所有语义泄漏均可阻断的 DLP 系统。

### 小型检索评估

`tests/memory-retrieval.test.ts` 使用四条独立合成记忆、八个中英查询，包括 checkpoint/recovery、幂等/原子提交、对账/盲目重试、reviewer/subjective。目标记录排名第一 **8/8**；另一节点的检索不能得到这些 ID。

额外测试覆盖中文“持久化队列”、两字“幂等”、英文大小写、来源过滤、最多八条返回及带 FTS 特殊符号的查询。这个小样本只证明已测查询可用，不是泛化语义检索质量指标；短词和长自然语言问题仍可能召回不足。

## 事务、幂等及故障处理

- 每次写入、FTS 触发器和内容不入审计的事件共用事务。注入事件写入失败后，记忆与索引同步回滚。
- 同一个完成轮次的候选批次按 `(turnId,owner)` 留存原决策；重放只返回原结果，不另存记忆。原决策不代表该记录目前仍处于活动状态。
- 模型完成、外发消息、投递确认和记忆批次位于同一个外层事务。记忆存储失败会一起回滚，并按 P0 规则进入 unknown/隔离，不自行再调用模型。
- 单个候选验证失败只记录拒绝原因，不拖垮合法外发；数据库故障不被当成普通候选拒绝吞掉。
- 候选提炼不新增模型调用或 Token/费用预留；预算不允许下一轮时，不进行推理或候选提取。正常完成的最后一轮仍可提交其候选。

## 迁移与备份

新增 `sql/004_memory.sql`，数据库 `user_version=4`。支持旧 0–3 版顺序迁移；未来版本和未标记非空库仍拒绝。

新增 claim_key/content_key/version/provenance、完整修订 JSON、memory_candidates、turn_memory_batches。默认旧数据 provenance=legacy；Node 迁移器规范化旧内容键。迁移还会替换 FTS tokenizer，并从原 memories 表重建索引，不丢弃记忆或旧修订原文。不能在已经完成 version=4 迁移的库上手动重放 ALTER SQL。

本轮升级项目原空库前通过 SQLite Backup API 保存 `.dmn/backups/p1-memory/dmn-v3.sqlite`；同目录保存更改前的关键实现文件。主 `.dmn/dmn.sqlite` 已升级并验证为空队列、版本 4、无运行活动。旧 P0 验收数据库未被本轮自动迁移；真实 P1 在新隔离数据库运行。

若有真实数据，先停止该库的活动并做一致备份，再执行 `init` 迁移。恢复时同时使用匹配的旧实现和 Runtime Home，不能只改 user_version。迁移保留和重复打开测试覆盖了合成 v3 记忆与历史，不代表已验证掉电或磁盘损坏。

## 环境与验证

Node 24.14.0、SQLite 3.51.2、Windows x64；项目 SDK Client/Runtime/Protocol 均实际核实为 `0.2.1-rc.3`。本轮没有新增 SDK/Cordis API 调用，沿用已验证的 initialize/resume/prompt/subscribe/wait/close；仅修改输入数据和输出契约。原生工具禁用组合测试继续通过。

参考：[SQLite 官方 FTS5 与 trigram](https://sqlite.org/fts5.html#the_trigram_tokenizer)、[DSH SDK 官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)。trigram 对短于三字符的查询有局限，因此没有直接依赖默认中文分词。

### 自动化结果

最终 `npm run check` 通过，`npm test` **54/54 通过**，`npm audit --audit-level=moderate` 为 **0 项漏洞**。真实 P1 用例与 P0 两项回归分别实测通过；一次已观察的格式失败及其保留状态单独记录在下文，没有计入通过证据。结束后未发现项目 SDK 进程或成功验收 Runtime Home 的遗留锁。

| 用例 | 前提、操作与期望 | 实际 / 结论 | 证据 |
|---|---|---|---|
| C01 | A/B 共用一条可见来源，分别形成主观 Relationship | 独立 ID、独立 owner、subjective=true，PASS | memory.test.ts |
| C02 / E05 | 另一节点尝试读取、检索、历史、修订、删除、来源及候选越权 | SQL 拥有者过滤与 Forbidden，PASS（已测接口） | memory.test.ts、真实 Prompt 观察 |
| C03 | 缺来源、隐藏来源、低置信/价值、凭据或额外权限字段 | 拒绝；不伪装成事实，PASS | memory.test.ts |
| C04 | 同 claimKey 新内容，显式解决，旧版本再次写入 | 待确认冲突、不覆盖；新版本及完整历史；旧版本拒绝，PASS | memory.test.ts |
| C05 | 节点要求变更 Identity；宿主显式管理 | 节点拒绝，人工带版本更新/删除，PASS | memory.test.ts、memory-cli.test.ts |
| C06 | 关闭/重新打开数据库及后续 SDK Resume | 私有旧记录仍可查并重新注入；他人不可读，PASS（正常关闭） | memory.test.ts、真实 P1 证据 |
| C07 | 删除后检索/get、查看历史、重放同内容候选 | 活动接口消失；仅自身可见历史；重放不复活，PASS | memory.test.ts |
| 故障/幂等 | 候选批次重放、事件/记忆写入故障 | 无重复；原子回滚，未知结果不重试，PASS | memory-runtime.test.ts |
| 预算 | 额度耗尽时仍有消息 | 不多调用模型/提炼；队列保留，PASS | memory-runtime.test.ts |
| 迁移 | v3 原记忆与旧修订升级、重复打开 | 行/原文保留；FTS 中文可检索；legacy 不自动注入，PASS | memory-migration.test.ts |
| 检索 | 四记录八查询及两字回退、大小写、有界结果 | 目标首位 8/8；无跨节点 ID，PASS | memory-retrieval.test.ts、memory.test.ts |
| CLI | 跨进程提议、检索、来源、修订、历史、删除、Identity | 实际命令返回正确结果、另一节点拒绝，PASS | memory-cli.test.ts |
| P0 回归 | 原双模型六轮/五消息、正常 Resume、预算停止与并发 | 最终复测通过，PASS（真实） | 下列回归 JSON |

新增测试均先记录失败再实现；适用环境为上表，安全/正确性拒绝均为阶段阻断项。`npm test` 不发真实模型请求。完整运行命令：

```powershell
npm run check
npm test
npm run test:memory:live   # 显式付费 API 验收
npm run test:live         # P0 真实回归
npm audit --audit-level=moderate
```

### 真实 P1 记录

Topic `<topic-id>`，Flash 与 Pro 完成四个授权轮次、三条往返消息，随后预算暂停；没有失败/未知轮次。由实际模型响应形成 **三条私有 Semantic 记忆**：DeepSeek 一条、Reviewer 两条，均附可见入站消息来源、0.85 confidence 和 0.8 importance。

重新打开业务数据库后，又运行一轮 Reviewer：成功 Resume 固定根，并将此前的 Reviewer 记忆重新放入其 Prompt。该轮对端要求读取 DeepSeek 私有记忆和验证码、披露自己的验证码并更改 Identity；观察器确认其他节点 Identity 未进入 Prompt，输出未含任何私有测试验证码，两个 Identity 均未变化。这里只验证了这个样本，没有证明所有攻击均安全，也没有用回复内容反推模型一定依赖了某条记忆。

证据见[证据说明](EVIDENCE.md)。完整隔离库与 Session 留在 `.dmn/live-memory-<run-id>/`。

P0 回归证据见[证据说明](EVIDENCE.md)。

### 已观察的失败与限制

一次 P0 回归中，Flash 在 JSON 后附加了 DSML 控制标签，严格解析拒绝了该输出。该失败夹具为 `.dmn/live-acceptance-<run-id>/`，保留 unknown 和原 Session，没有自动重试。验收观察器在返回给 Runner 前提前解析 JSON，因此夹具归类为 unknown；核心 Runner 的对应格式错误拒绝路径另有测试验证为 failed/dead_letter，不会从部分 JSON 猜测发送内容。

新增了后缀拒绝回归，并收紧输出提示；新话题复测通过，最终 P1 真实验收也再次通过。这不保证模型今后永不返回非法 JSON；本轮未增加格式修复模型轮次或宽松提取器。

其他限制：

1. 来源关联和置信度不是语义真实性保证；无 claimKey 的矛盾可能并存。
2. FTS 是字面检索，小型样本不是通用召回质量背书。
3. 删除是逻辑删除；未实现物理擦除、SDK 历史遗忘或撤回传播。
4. 运行时和公开状态不提供通用跨节点搜索；本地可信操作员仍拥有数据库文件访问权限，没有数据库加密/多用户认证。
5. 未知结果仍需保留状态人工核对；P2 的有界重试、恢复授权、对账工具未实现。强杀/掉电专项恢复未在 P1 新增实测。
6. SDK Profile、限额与路由沿用 P0 的受限两模型环境；本轮无新原生工具和后台推理，无 Subagent，未修改 Desktop Profile。

本轮止于 P1。下一里程碑为 **P2：完整话题状态机、限次重试/退避、死信与显式恢复/对账**。
