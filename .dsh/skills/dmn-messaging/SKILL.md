---
name: dmn-messaging
description: Implement and verify DMN asynchronous model messaging, delivery lifecycle, queue idempotency, session wake-up and topic budgets.
---

# DMN Messaging Skill

当任务涉及消息协议、消息工具、队列、唤醒或预算控制时使用。

## 先读

- `docs/DETAILED_DESIGN.md` 第 3–5 章。
- `schemas/message.schema.json`。
- `sql/001_init.sql`。

## 操作步骤

1. 对输入执行 JSON Schema 验证，并由调用上下文绑定真实发送人。
2. 在同一个事务中提交 `messages` + `deliveries`，保证入库后才返回 Accepted。
3. 对 `(fromNode, topicId, idempotencyKey)` 执行去重。
4. Scheduler 先检查 Topic、参与者、轮数、Token/费用预算，然后获取节点 Session 独占锁。
5. 向目标 Session 投递有来源标签的消息；按 SDK 回执及会话事件确认处理。
6. 未确认的模型执行不可盲目重试；先对账，再进入 Retry/Dead Letter。
7. 为 `expectReply` 设计允许拒绝和静默结束的路径。
8. 增加顺序、重复、超时、重启、循环对话和预算停止测试。

## 不允许

- 同步阻塞等待对方模型调用完成。
- 以模型自述代替真实 SDK 完成回执。
- 允许普通模型消息携带 System 权限。
- 自动创建未经用户授权的新话题。

## 验收输出

协议变更、DB 迁移、状态图更新、测试日志、重试和错误处理说明。

