# Desktop-N0 契约

仅验证当前安装版本的公开扩展接口：原生 main 面板、sidebar.panellist 导航、官方 Connection 的宿主 GET 路由，以及 Loader/HMR 的加载与卸载。无模型调用、无话题写入、无进程托管、无生产库迁移，N1–N5 在 N0 门禁后顺序实施。

探针读取仓库 `.dmn/n0/probe.sqlite` 隔离实例，只返回节点 ID/模型/状态和轮次数。数据库位置由宿主安装配置绑定，不接受浏览器路径、身份或权限字段。前端按文本渲染，卸载取消未完成请求并撤下导航、面板和路由。只读探针不作为 N1 的生产服务架构。

开发验证前备份 Desktop Profile 的 manifest、lock 和 patch；不得覆盖现有插件或读取/复制凭据。使用官方 Desktop-installed CLI 注册本地 bundle，卸载后核对其他 bundle 与配置保留。实际加载、可见面板、宿主返回与卸载分别记录，编译/HTTP 回执不代替真实 Desktop 验证。
