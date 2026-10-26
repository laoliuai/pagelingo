# 文档服务（规划）

尚未实现，也未注册为 npm workspace。[个人学习站 V1 设计稿](../../docs/superpowers/specs/2026-10-26-personal-learning-site-design.md)已于 2026-10-27 获批，当前制定 S1 实现计划：使用 TypeScript 实现管理员手工开通账号、各用户独立资料与 API 配置、持久化任务和共享翻译 SDK 调用。后续再接入站内助手。账号、任务、原件与资源读取采用同一用户隔离边界。

API 与 worker 可属于同一个包、使用不同入口；重解析和重译都有独立 run ID。PDF 解析调用 `services/document-parser` 的独立进程，不重写 Python 翻译引擎。具体协议、取消与恢复约束见 [PDF 规格](../../docs/pdf-spec.md) 和 [架构](../../docs/monorepo.md)。

允许本机处理后导入服务器：处理机导出原件、版本化 IR / 译文、阅读快照与资产 manifest；服务校验文件 / checksum 后写入 ObjectStore、登记 PostgreSQL，重复导入幂等。后续可通过任务接口拆分 GPU worker 与阅读服务器。静态 HTML 是可重建产物，业务依据仍为 IR / 译文与运行数据；见 [处理设计](../../docs/pdf-processing.md)。导入与快照服务尚未实现。

本机与服务器统一使用 PostgreSQL 保存文档、运行、任务 / 检查点、按块译文 / 缓存、术语、对话与阅读位置；数据库访问集中在 repository，schema 用版本化迁移管理。PDF、raw parser 输出、完整 source IR 与图表资产通过 ObjectStore 保存，首版 LocalObjectStore 使用可配置的持久化目录，后续 S3 adapter 必须验证同一读写 / checksum 合同。

存储 backend、对象 key 与 checksum 留在服务内，前端只使用文档 / 资产 ID；绝对路径与数据库凭据不进入 Reader 协议或 SDK。对象校验完成后再提交数据库引用；任务有 lease / epoch、版本与取消条件，防止重启后旧结果覆盖新运行。完整设计见 [存储边界](../../docs/pdf-spec.md#84-storage)。

部署规划为 Compose 中的独立 API / worker 入口、PostgreSQL 与持久卷。`DATABASE_URL`、`PAGELINGO_DATA_DIR` 及加密主密钥在运行时注入；各用户 API Key 加密保存，排除日志、快照及普通 settings 响应。parser 子进程采用环境变量白名单。服务器使用 HTTPS、会话与可撤销设备授权；备份包含数据库、引用对象及恢复所需的密钥材料，并验证在空环境 / 另一台主机上的恢复。当前尚无 Dockerfile、Compose、数据库迁移或运行服务。
