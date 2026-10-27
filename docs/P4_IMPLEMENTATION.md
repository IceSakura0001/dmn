# P4 — 双节点交互产品闭环

2026-10-27 本地原型实现与技术验收完成，未进入 P5–P8。将 `codex/p4-dual-node-ui-20261027`（`cfd2f206`）合并至含 P3-H1 的 main（`966c38a`）；保留严格全响应 JSON 校验、格式诊断与未知执行对账。路线以合并后的 P4 计划为准。

## 实现与契约

采用复用 OperatorService 的回环 Web 服务及原生 HTML/CSS/JavaScript；保留 Desktop/MCP。没有 Subagent、第三节点或新增模型工具权限。

- `start_topic` 增加 `mode: discussion | direct`，默认 discussion。旧讨论请求的幂等序列化保持兼容；mode 属于原请求，不能用旧键变更模式。
- direct 创建不 seed、不推理；只有用户发送才唤醒指定参与节点。Runner/Gateway 均拒绝 direct 的节点间发送，消息正文不能改变授权。
- `reply_user` 仅包含 `action/content/memories`，严格拒绝模型填写身份、话题和回复链。宿主从实际 operator 输入及完成轮次绑定节点、收件用户、replyTo、turnId；无 operator 输入不得使用此动作。
- `user_replies` 单独持久化节点→用户消息，不产生 Delivery，不唤醒对端。replyTo、turnId 分别唯一。最后一个已获预算的轮次可以回复用户，不能追加模型调用。
- 回复、轮次完成及记忆处理同事务；沿用独立 `runtime_results` 检查点。故障后按持久证明对账，不重新调用模型。epoch、截止时间和人工停止继续隔离旧轮次效果。
- `get_messages` 保留 `messages/operatorMessages`，新增 `userReplies`。operatorMessages.state 表示最新尝试：queued/running/retry/unknown/failed/silent/decline/replied/suppressed；节点消息增加 Delivery 的 state。新增字段不含私有 Prompt、推理或完整 SDK 历史。
- 用户输入当前不自动形成长期记忆，operator 来源候选会被拒绝并审计；完整治理留 P7。

界面提供双节点身份/模型/职责与真实状态、明确收件人、定向记录筛选、三种消息方向、节点投递状态、各节点预留额度、完成/失败/未知/死信计数、截止时间及暂停/恢复/结束。刷新和重连只查询，不能授权推理。

未确认写请求的摘要及幂等键保留于当前标签页 sessionStorage，不保存正文；刷新后重新填写相同输入会复用键。确认成功但查询失败时提示刷新查询，不误报需重发；HTTP 明确拒绝与网络结果未知分别提示。失效的旧数据库话题选择会清空。

## 数据迁移与回滚

`sql/007_user_replies.sql` 将 v6 升为 v7：增加话题模式、轮次动作/效果隔离字段、用户回复表及绑定触发器。旧话题默认 discussion，历史不重写；重复打开不重复迁移，v6 历史保留及重开测试通过。

**本轮没有升级用户原有 `.dmn/dmn.sqlite`，全部验收使用隔离数据库。** 升级已有实例前，停止使用该数据库及 Runtime Home 的 CLI/MCP/Web，完整备份数据库、存在的 WAL/SHM 与配套 `.runtime/`，保留旧版代码，再执行 `npm run dmn -- init <数据库>`。不要在进程运行中复制数据库充当一致备份。

回滚时停止进程，恢复匹配旧代码与整套升级前备份。没有逆向 SQL；不要仅修改 user_version，也不要用旧版读取 v7。新版本产生的数据需要另行保留。

## 启动

在项目目录执行（Node >=24.14.0）：

```powershell
npm ci
npm run check
npm test
# 先通过安全凭据机制提供 DEEPSEEK_API_KEY，不写入文件：
npm run web -- .dmn/p4-dev.sqlite 4310
```

打开 `http://127.0.0.1:4310`，默认选择定向聊天；创建话题后分别选择 deepseek/reviewer 发送。创建与发送的 Accepted 仅表示入库，正式回复需等待时间线。明确选择节点讨论才允许节点间交流。Ctrl+C 停止服务；重启不自动恢复推理，待显式操作或 CLI pump。

仅监听 `127.0.0.1`。Host/Origin/sec-fetch-site 校验、随机写令牌、JSON 大小限制、无 CORS、CSP 及 textContent 保护本地浏览器路径。这是受信任单用户本地边界，不能防同机恶意进程，不支持公网、多用户或远程鉴权。

## 可复现验收

| 项目 | 本轮结果 | 命令/证据 |
|---|---|---|
| 类型与离线测试 | PASS，95 项 | `npm run check` / `npm test` |
| 依赖审计 | PASS，0 漏洞 | `npm audit --omit=dev` |
| 浏览器 + 模拟运行时 | PASS | `npm run test:ui`；A/B 定向、丢响应后刷新重试、XSS、暂停/恢复/关闭、旧选择清理、读写失败区分、节点双向讨论、手机宽度 |
| 两个真实模型定向回复 | PASS，2 次调用 | `npm run test:p4:live`；两个固定根、零节点消息 |
| 浏览器→HTTP→队列→DSH→真实模型 | PASS，两轮各 4 次 | `npm run test:ui:live`；每节点两次并恢复原根、4 条关联回复、刷新不推理、预算后拒绝、零对端广播 |
| P0 与并发基线 | 初测及提示补强后均 PASS | `npm run test:live`；六轮五消息、注入、两根并发、同节点互斥 |
| P1 记忆基线 | 初测 FAIL；补强后两轮各 5 次 PASS | `npm run test:memory:live`；提炼、重开、恢复检索、私有身份及跨节点注入隔离 |
| P2 故障基线 | 初测对账 FAIL、重试 PASS；补强后两项 PASS | `npm run test:policy:live`；真实 SDK 日志对账无重调、提交前失败有限重试 |
| P3 真模型 MCP | 初测 FAIL；明确转发请求后 PASS | `npm run test:desktop:live`；三次调用、幂等、暂停/恢复/关闭、重连 |
| 自定义 CA 证书链 | NOT_RUN | 仅白名单传递单测通过；本机未设置额外 CA |
| 用户主观操作体验 | 待用户确认 | 已检查真实桌面与模拟手机截图，不代替用户体验反馈 |

浏览器测试使用已安装的 Chrome/Edge/Chromium，不自动下载。支持 Windows 常见安装位置和 Linux/macOS 默认路径，其他位置设置 `CHROMIUM_PATH`；本轮实际验证 Windows Chrome 155。模拟测试不调用 API；真实命令显式执行并计费。

`test:p4:live` 预设最多 2 次、65536 输入/2048 输出 Token、估算 $0.50；`test:ui:live` 每轮最多 4 次、131072 输入/4096 输出 Token、估算 $1。先确定次数与额度再运行；费用预留不是提供商账单硬上限。本轮两次浏览器实测分别在测试增加后执行，保留各次结果。其他回归使用各自测试文件的固定预算。

验收摘要由维护者本地留存（见[证据说明](EVIDENCE.md)）。原始日志、数据库及 SDK 事件保存在被忽略的 `.dmn/`，摘要包含各次状态、输出哈希和最终源码哈希，不上传私有 Prompt、凭据或运行库。

## 失败诊断与限制

本轮合并后第一次 P1 第四轮出现正文内 ASCII 引号未转义；完整 JSON 被拒绝，未自动重试。P2 第一次模型对 peer 输入误用 reply_user，SDK 日志对账恢复该实际输出后被宿主拒绝，未伪造成功或发送消息。P3 旧验收只发送模糊补充输入，模型选择回复用户，未出现预期的对端转发，等待超时；新验收明确要求在已授权 discussion 中转发。上述 FAIL 均保留于证据，不用后续 PASS 覆盖。

先添加会失败的提示/浏览器断言，再明确动作选择优先于角色风格、对 peer/null 禁止 reply_user，并建议正文采用中文引号或正确 JSON 转义。严格全响应解析、未知隔离和硬预算保持不变；对账证明执行完成不等于输出获准执行。

核对了已安装 DSH SDK/Runtime `0.2.1-rc.3`、Cordis `4.0.5`、包 README/类型与官方 [SDK 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[Messages 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)、[JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode/)。当前 DSH DeepSeek Messages 配置未发现可用的 response_format/JSON Schema 字段，未杜撰参数或切换传输。代理/CA 环境按白名单传递；本机 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 存在时真实调用通过，但不能由此证明所有代理或自定义证书均兼容。

有限样本不能保证长对话始终输出合法 JSON；非法输出仍停止并可见。私有记忆查询按 owner 隔离，但模型可能在合法正文复述已知信息，不承诺绝对语义防泄露。当前每类查询最多 100 条；分页、长期运行、备份演练与对账管理 UI 留 P5，远程权限留 P8。未重装或重启用户 Desktop，当前验证是独立 Web 与真实 MCP 客户端路径。
