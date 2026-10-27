# Agent 与 Skill 的使用说明

## 1. 两种“Agent”必须区分

1. **DMN Model Node（运行时节点）**：DeepSeek/GPT 等模型持有自己的身份、根 Session 和私有记忆。它们不是 Subagent。
2. **开发辅助角色（模板）**：`templates/agents/*.md` 是供你在**一个独立开发会话中手动选择**的工作提示词。没有注册子代理，也没有自动 Agent 调用能力。

本包不会创建 `.dsh/agents/` 这类未经核实的自动发现配置，也不会声明这些角色能被 DSH 自动加载。项目级通用开发约束使用 DSH 支持的 `AGENTS.md`。

## 2. 推荐开发辅助角色

| 文件 | 职责 | 适用时机 |
|---|---|---|
| `templates/agents/system-architect.md` | 校验总体架构、领域模型与版本边界 | 需求变更、跨模块设计 |
| `templates/agents/runtime-integrator.md` | DSH SDK/Profile、会话唤醒、模型路由 | P0/P3 Runtime 接入 |
| `templates/agents/memory-engineer.md` | 私有记忆、索引、置信度与遗忘 | P1 |
| `templates/agents/verification-engineer.md` | 契约测试、故障注入、验收 | 各阶段交付前 |

每次手动进入一个角色，只处理该角色的问题；不能为了模拟多角色会话而自动启动子代理。

## 3. DSH 原生 Skill

DSH 的 `dsh-skill-filesystem` 可以发现项目 Git 根目录的：

```text
.dsh/skills/<skill-name>/SKILL.md
```

这些文件有包含 `name` 与 `description` 的 YAML frontmatter，属于 DSH 可加载的原生 Skill 模板。要求实际 Profile 已装载 `dsh-skill`、`dsh-skill-filesystem`，模型使用 Skill Catalog 时还需 `dsh-tool-skill`。如果你的 Profile 使用其他技能提供器，应按实际配置调整。

| Skill | 主要动作 |
|---|---|
| `dmn-architecture` | 用设计检查表评估职责和信任边界 |
| `dmn-messaging` | 实现消息与投递、幂等、状态机、唤醒 |
| `dmn-memory` | 私有记忆检索、提炼、修订和删除 |
| `dmn-testing` | 验收与故障注入，验证无 Subagent |
| `dmn-operator` | Desktop 通过 MCP 执行用户明确授权的有界话题操作；节点不可使用 |

**使用方式**：把解压后包内 `.dsh/skills` 的内容复制/合并到目标仓库 Git 根目录下的 `.dsh/skills`，不要多套一层 `dmn-detailed-design-kit/`；将 `AGENTS.md` 置于同一 Git 根目录。然后在 DSH 项目会话中查看技能目录并按名称调用，或直接在任务描述中指定技能。具体加载行为取决于已启用的 DSH 插件，不因文件存在就必然自动加载。

## 4. 运行时 Persona

`templates/personas/deepseek-node.md` 与 `gpt-node.md` 是**模型节点身份模板**，用于 Runtime Adapter 给独立根 Session 注入系统/身份约束；它们不是开发角色，也不具备访问工具、别人的记忆或无限交流的授权。

Persona 中所述限制仍必须由 Topic Manager、Message Bus 和 Memory Manager 在服务端强制执行，不能只靠 Prompt。

## 5. 推荐组合

- 设计修改：手动选择 `system-architect` + 加载 `dmn-architecture`。
- 写消息服务：手动选择 `runtime-integrator` + 加载 `dmn-messaging`。
- 做记忆：手动选择 `memory-engineer` + 加载 `dmn-memory`。
- 回归/验收：手动选择 `verification-engineer` + 加载 `dmn-testing`。

这些组合都是**同一会话中的角色与技能**，不是 Agent→Subagent 调用。

## 6. 参考

- [DSH Skill Filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)
- [DSH Tool Skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md)
- [DSH Agent Instructions](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md)

