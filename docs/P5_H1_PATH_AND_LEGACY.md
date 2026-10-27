# P5-H1 — Desktop-N 前置安全修复

2026-10-27。已审查并快进合入 `docs/native-desktop-plan-20261027` 的 `de7872a`。该提交只有原生插件计划，没有面板代码。本轮依照一次一个里程碑的约束，完成计划列出的两项 P5 前置修复；Desktop-N0–N5、P6 尚未启动。

## 路径身份契约

- 先用 lstat 检查数据库叶子，不以 existsSync 作为链接存在性的前提；悬空链接也拒绝，检查失败不创建数据库目标或客户端登记。
- 数据库文件硬链接（nlink > 1）拒绝，不能用另一名称逃过客户端维护检查；Runtime 根叶子也不能是链接或普通文件。
- 父目录 junction/symlink 可以作为入口别名，但数据库、客户端登记和 SDK Runtime 必须先解析为同一个物理位置。不存在的后缀从最近可解析祖先展开，不预先创建目录。
- DmnStore 公开可信的只读 `path/runtimeRoot`，实际 SQLite 使用该 path。CLI、MCP、Web 从 store.runtimeRoot 启动 SDK；Runtime Adapter 本身也规范化配置根目录。CLI status 采用相同的只读 Store 边界。
- 固定 Session ID、节点记忆 owner、预算和模型权限不变。没有新 SDK/Cordis API，仍使用安装的 SDK/Runtime 0.2.1-rc.3、Cordis 4.0.5；核对了安装类型及[官方 SDK 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)。lstat 的链接语义见[官方文件系统说明](https://nodejs.org/api/fs.html#fslstatsyncpath-options)。

这不是针对恶意同机进程的文件系统沙箱；检查后路径被外部替换的竞态仍属本地信任边界。历史 SDK 日志若使用旧别名 cwd，不改写日志、不伪造 Resume；无法匹配的历史仍保持未知，需另行核对。

## 旧 Schema 与运行状态

备份创建对 v1–v7 全部检查 running，不再只检查 v3 以后。校验与恢复同样拒绝历史成品中遗留的 running，即使文件哈希和 SQLite 完整性通过也不能当作静止实例。

v1–v4 没有精确 host input snapshot。升级至 v7 时，在同一迁移事务中处理旧 running/unknown：

1. 保留轮次、回执、Session ID 和原预算，状态转 unknown，节点 cooling；相关 Delivery 转 unknown。
2. 建立或保留对应 node_lock，设 quarantined，不清 Runtime marker、不重新排队。
3. 记录 `turn.legacy_quarantined`、来源版本和 turnId；重开不重复记录。不生成输入快照、SDK 结果或虚构尝试历史。
4. 同节点有多个未决旧轮次，或锁指向另一轮次时，整笔迁移回滚并要求人工审查，不选择其中一个。

这类旧轮次缺乏宿主输入证明，对账/drop 继续返回 LEGACY_INPUT_UNAVAILABLE；新泵不会重放。v5–v7 的现有运行态仍遵守既有租约与对账规则，不把正常活跃 SDK 执行当作升级失败。

无新增 SQL Schema 版本；变更是已有 v1–v7 升级路径内的隔离处理。旧实例必须先停机并保留数据库、存在的 WAL/SHM 与 Runtime 整套现场，再由 init 升级。旧库仍有 running 时，不能绕过备份拒绝去伪造“成品备份”；先离线保留现场并人工核实。用户原有业务库本轮没有升级或改动。

## 验证与范围

- 类型检查：PASS。
- 全量离线：124 PASS，保留 P5 的备份、故障恢复、预算、记忆隔离与提示注入回归。
- 新增 17 项路径/旧库回归：v1–v7 running 拒绝、旧成品校验/恢复拒绝、v1–v4 隔离与重开幂等、歧义迁移回滚、旧锁保留、硬链接和父目录 junction 身份一致。
- 真实浏览器 + 模拟模型：3 PASS，不因读取而推理。
- 真实模型恢复演练：PASS，预定最多 4 次、131072 输入/4096 输出 Token、估算 $1；对账不重调、备份恢复保留原双根、重复输入不重执行，最终预算停止。估算不是实际账单上限。
- 当前 Windows 不允许非特权创建文件 symlink（EPERM）：原生文件 symlink 创建场景 NOT_RUN；采用真实悬空 junction 验证同一 lstat 拒绝分支，原生硬链接/父目录 junction 验证通过。没有修改系统权限或请求提权。
- 本轮没有重复 5 分钟耐久测试、没有加载/卸载原生插件；P5 的历史耐久结果仍只代表历史代码，N0 真实 Desktop 门禁尚未执行。

摘要及源码哈希见[证据说明](EVIDENCE.md)。接下来才进入 N0：记录实际 Desktop 版本、核对正式面板/设置/宿主通信接口，并验证零模型调用的最小插件加载/卸载。不得直接跳到 N1 或 N2。
