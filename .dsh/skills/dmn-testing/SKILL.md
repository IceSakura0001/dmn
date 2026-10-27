---
name: dmn-testing
description: Test DMN message delivery, independent sessions, memory privacy, semi-autonomous stopping rules, crash recovery and injection resistance.
---

# DMN Verification Skill

当任务涉及测试、验收、故障排查或发布前检查时使用。

## 顺序

1. 阅读 `tests/ACCEPTANCE.md` 并划定当前里程碑的适用用例。
2. 静态校验：JSON Schema、SQL 迁移、Node/Topic 状态变迁。
3. 功能验证：双模型至少 5 轮、消息有独立 ID、节点保留固定 Session。
4. 并发验证：同节点禁止同时 Running，不同节点可并发。
5. 安全验证：伪造发送者、跨节点记忆读写、提示注入、权限绕过均失败。
6. 稳定性验证：超时、重试、重复消息、SDK 与 DB 崩溃、Resume。
7. 自动化限额：总轮数/单节点轮数/时长/Token/费用硬性停止。
8. 输出逐条通过/失败/未运行和可复现证据，绝不推断未执行测试成功。

## 格式

每条记录：用例 ID、环境版本、前提、步骤、预期、实际、日志引用、结论、严重性。

