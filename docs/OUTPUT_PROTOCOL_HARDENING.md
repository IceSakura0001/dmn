# P3-H1 — 长对话输出协议与故障诊断补强

日期：2026-10-27。用户要求拉取最新仓库后继续验证、实施。已执行 `git pull --ff-only origin main`，远端与本地均为 `ec3a6eb`，开始时工作区干净。本轮只处理 P3 遗留的长对话输出问题，没有启动 UI-M1 或 P4，没有使用 Subagent。

## 问题与决策

重新检查 2026-10-26 的原始失败记录，发现两种具体输出：一个合法消息对象之后又追加了独立记忆对象，以及消息对象末尾多了一个右括号。另一个提示冲突来自 DeepSeek 人设：它要求调用 `model_send_message`，但当前 SDK Profile 没有开放任何原生工具。

保留现有受限 DSH SDK Runtime 和严格输出契约，修正提示中的完整示例与人设冲突，不对模型返回值截取 JSON、不修补括号、不放宽 schema，也不以新模型请求修复坏输出。

已核对项目安装版本：DSH Runtime、SDK Client、SDK Protocol 均为 `0.2.1-rc.3`，Cordis `4.0.5`，Node `24.14.0`。官方 DeepSeek Chat Completions 文档提供 `response_format: json_object`，但当前 DSH Adapter 使用 Messages 接口；该接口的官方兼容表只声明 `output_config.effort`，本轮不擅自加入 `output_config.format` 或其他未经支持的配置，也没有切换 Provider 或绕过 SDK。

替代方案是以后通过已核实的原生通信工具或受支持的结构化输出传输替换文本建议。本轮不引入该运行时变更，避免扩大工具权限及单次模型调用预算。

## 实现与受影响契约

1. `src/dsh-runtime.ts` 的系统协议现在展示完整的单对象响应，包括嵌套在同一 `memories` 数组中的候选；明确禁止第二个对象、额外括号、Markdown 和控制标签。缩短建议内容长度以适配原有输出额度。提示约束仍不是服务端 JSON 格式保证。
2. DeepSeek 与未启用的 GPT 人设模板统一遵循宿主结构化输出协议，不再声称必须调用一个未开放的原生发送工具。Reviewer 人设无需修改。
3. `src/model-output.ts` 提供严格整段解码，区分 `invalid_json` 和 `invalid_envelope`；接受的 `send / decline / silent` 及字段范围保持原样，记忆候选仍在原有来源和隔离规则下独立校验。
4. Runner 继续先保存已确认的 SDK 结果，再验证业务输出。非法格式进入既有 `INVALID_OUTPUT` 死信路径，不触发重试；只有结果/完成状态缺乏证明时才隔离为 unknown。
5. 新增审计事件 `turn.output_invalid_json`、`turn.output_invalid_envelope`，只记录可信 turn ID，不记录输出、Prompt 或私有记忆。诊断按同一回合去重；即使诊断落库后死信写入失败，恢复对账也不会再次计数或调用模型。
6. `get_topic`、本地 `topic status` 共用的状态返回值增加 `outcomes`（queued/running/completed/failed/unknown）、`deadLetters`、`outputErrors`（invalidJson/invalidEnvelope）。这些是话题内计数，不包含私有正文。Waiting 表示当前无可处理待办，不等于所有任务成功，应结合这些计数判断。
7. P0/P1 真实测试的观察包装器不再因为 `JSON.parse` 抛错而吞掉已经确认的 SDK 结果；保留格式分类并将原始结果交回 Runner。P1 同时新增“所有观察均符合完整契约”和“恢复/注入回合确实完成”的断言，不能靠只增加观察数量通过。

消息总线、发送者绑定、会话根 ID、Profile 工具边界、Token/费用预留、自动化限额、记忆来源规则和公开管理工具数量均未改变。数据库保持 v6，无新增迁移，也没有改写既有运行数据库或旧验收证据。新状态字段为兼容性增加；旧记录不会被猜测性补写成格式错误事件。

## 测试与证据

先添加失败测试，再修改实现。最终结果：

| 范围 | 结果 |
|---|---|
| `npm run check` | PASS |
| `npm test` | PASS，87 项（原 83 项，新增 4 项） |
| 单对象/多对象/额外括号/代码围栏/DSML/伪造 owner 与 sender | PASS，严格拒绝非法响应 |
| 已确认坏输出保存结果、仅一条死信、无重调模型、审计不泄露正文 | PASS |
| 诊断已提交但死信失败，租约过期后恢复对账 | PASS，仍仅计一次格式错误、一次死信、一次模型调用 |
| 连续 3 轮 P0 真实复验 | 每轮 6 次主对话调用、5 条往返消息、0 failed/unknown；另有 1 次恶意消息隔离回合通过 |
| 连续 3 轮 P1 真实复验 | 每轮 4 次提取调用、3 条消息、3 条已接受的私有记忆；另有 1 次重启检索/注入回合通过 |
| 连续 3 轮真实并发复验 | 每轮两节点实际重叠运行，同节点第二次 tick 不启动，预算后停止 |
| P2 真实对账、已确认未提交失败重试 | 两项 PASS，均只调用一次模型 |
| P3 真模型 MCP：用户输入、幂等、暂停/恢复、重连 | PASS，3 次完成调用 |
| `npm audit` | PASS，0 项漏洞 |

三轮复验使用不同隔离数据库、Runtime Home 和随机测试标记；没有失败后自动重试到通过的循环。本轮共 47 次实际模型调用：P0 主对话与注入 21 次、并发 6 次、P1 提取与恢复/注入 15 次、P2 2 次、P3 3 次。所有已执行样本通过，没有放宽原有完成数、消息数、隐私或预算断言。

验收记录由维护者本地留存（见[证据说明](EVIDENCE.md)），包含各轮结果、本地证据路径与 SHA-256、回执及版本；完整运行数据库与日志仍在被 Git 忽略的 `.dmn/`。2026-10-26 的失败记录保留在原回归文档中，没有覆写为 PASS。

复现命令：

```powershell
npm run check
npm test
npm audit
# 显式真实 API 验证，会产生费用；每条命令均保留独立证据：
npm run test:live
npm run test:memory:live
npm run test:policy:live
npm run test:desktop:live
```

本轮 P3 回归使用真实 stdio MCP 和真实 SDK 模型链路，没有再次自动点击 Desktop 界面；Desktop 的画面与工具发现历史验收仍是 2026-10-26。修改会在新启动的 CLI/SDK/MCP 进程中加载；已经驻留的旧 MCP 管理进程需要重新加载，不能把源文件更新当成旧进程已热更新。

## 残留风险与下一步

三轮通过是有限样本，不能保证任意长对话都输出合法 JSON。非法输出仍可能发生，届时必须显示失败并停止相应投递；本轮补强的重点是降低提示歧义和正确区分“模型已完成但输出非法”与“执行结果未知”。后续若采用原生通信工具或新传输，仍需核对当前版本、工具权限、调用次数和故障恢复语义。

本轮未开始第三节点、跨 Provider 或生产部署。独立双智能体界面继续保持 [待实施](UI_IMPLEMENTATION_CHECKLIST.md)，按用户先前要求暂不实现。

官方依据：[DSH SDK Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[DSH DeepSeek Adapter](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.md)、[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Messages 兼容表](https://api-docs.deepseek.com/guides/anthropic_api/)。版本相关判断同时以本轮已安装类型与实际配置为准。
