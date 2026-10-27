---
name: dmn-architecture
description: DMN system design and architecture checks for independent root sessions, message bus, memory isolation and semi-autonomous topic boundaries.
---

# DMN Architecture Skill

当任务涉及总体架构、组件接口、节点边界或 DSH 接入决策时使用。

## 执行流程

1. 完整阅读 `docs/DETAILED_DESIGN.md` 的相关章节与本次变更需求。
2. 检查节点定义是否为独立根 Session，而非 Subagent；跨节点互动是否经由消息总线。
3. 明确每个组件的输入、输出、可信身份来源、可写状态及超时处理。
4. 检查会话历史与私有长期记忆是否混淆，记忆是否跨节点泄露。
5. 对照 `docs/IMPLEMENTATION_PLAN.md` 判断是否提前引入不必要的复杂性。
6. 输出架构决策记录：方案、替代方案、理由、影响、风险、验收测试。

## 关键检查表

- [ ] 仅独立根 Session，无 Subagent。
- [ ] 发送者身份不由模型输入决定。
- [ ] Topic Manager 能强制终止自动对话。
- [ ] 同一节点 Session 单写者。
- [ ] 私有记忆的拥有者在服务端强制过滤。
- [ ] 已区分官方 DSH 功能与 DMN 自研功能。

## 相关资料

- `docs/DETAILED_DESIGN.md`
- `docs/AGENTS_AND_SKILLS.md`
- 官方 DSH Architecture / SDK / Session 文档（见 README）。

