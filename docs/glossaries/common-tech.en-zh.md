# 常见科技个人术语表：英文 → 简体中文

整理日期：2026-10-06。用于科技文章、编程文档、机器学习及强化学习论文的个人译法偏好。包含缩写、拼写变体和不同领域的同词词条，不代表所有词条都是独立概念。中文译名是建议，可按阅读习惯修改；有分歧的译名列出常见替代。

## 文件与当前使用方式

- [JSON](common-tech.en-zh.json)：纯词条数组，每项只有 `source`、`target`、`policy`、`domain`，符合现有 SDK 的 `glossaryEntrySchema`，可作为 `customGlossary` 数据使用。
- [CSV](common-tech.en-zh.csv)：同一词表，另带 `topic` 分类与 `notes` 语境说明；UTF-8 BOM 编码，便于在表格软件中编辑。维护时先修改此文件，再同步 JSON 与本阅读版。
- 本文件：分类阅读版，包含建议译名、策略和多义词说明。

插件 0.3.0 起支持在设置页导入这些 JSON / CSV 文件，确认合并并保存设置后，词条用于下一次翻译；文件不会自动加载。原词（忽略大小写与首尾空格）＋领域是键，重复导入及文件内部重复均以后面的覆盖前面的，未出现的已有词条保留。已保存词条可搜索、编辑、删除及导出 JSON。使用说明见 [词表维护](../glossary.md)。

2026-10-25 增加保留本表策略的 HJFY 融合版，共 2,799 条：
[JSON](merged-tech.en-zh.json) / [CSV](merged-tech.en-zh.csv)。本参考表仍保留 367 条，
并将 accuracy / precision 调整为保留英文；融合规则及使用步骤见 [词表维护](../glossary.md#融合词表)。

## 策略含义

| policy | 含义 | 使用建议 |
| --- | --- | --- |
| translate | 固定译文 | 含义稳定且中文译法通行的术语 |
| keep | 保留英文 | 缩写、框架名、算法名；target 可只作释义，不要求输出该中文 |
| prefer-source | 优先英文 | 多义、译名不统一或易被生硬套用的词；target 是对应语境的建议释义 |
| first-bilingual | 双语术语 | 保留术语检索线索，例如“词元（token）” |

项目 V1 约定 `first-bilingual` 统一显示“中文（原词）”，而不是依赖并发顺序决定只在全文第一次出现时显示。

编程相关词条只用于正文：代码块、函数名、变量名、文件路径、模型标识符和 API 参数应继续原样保留。长词组应优先于短词匹配，例如 `access token` 优先于 `token`。匹配需要词边界，不能把 `RL` 匹配到其他单词内部。

`topic` 只是阅读分类；项目当前 `domain` 没有独立的 LLM/RL 枚举，因此机器学习、大模型、强化学习都使用 `machine-learning`。编程及软件系统使用 `software-engineering`。跨领域含义相对稳定的基础词使用 `all`，其余词不会无差别用于所有学科。设置页选择术语适用领域；所选领域及 all 词条生效，同词优先采用所选领域。SDK 只将实际命中的词条带入请求，不把整份词表当作每次请求的提示词。

## 易混淆词

| 词 | 此表采用的语境与译法 |
| --- | --- |
| token | LLM：词元；编译器 `lexical token`：词法单元；鉴权 `access token`：访问令牌 |
| agent | ML/RL：智能体；一般软件或网络语境可能是代理程序，不能全局固定译法 |
| reward / return | RL：奖励 / 回报；return 通常累积奖励，代码 return 应保持原样 |
| epoch / episode / training step | 训练轮次 / 交互回合 / 训练步，不可混用 |
| on-policy / off-policy / offline | 同策略 / 异策略 / 离线，描述的维度不同 |
| inference / reasoning | 执行模型获得输出 / 推理过程；中文资料常都用“推理”，应根据上下文区分 |
| accuracy / precision | 保留英文以区分指标；accuracy 可指准确率，precision 在数值格式中指精度、分类指标中指查准率 |
| actor / critic | Actor-Critic 中的策略部分 / 价值评估部分，采用优先英文，避免直译成演员 / 评论家 |
| concurrency / parallelism | 并发 / 并行，并发并不要求任务同时执行 |
| authentication / authorization | 身份验证 / 授权，分别涉及身份和访问权限 |
| Transformer | ML 架构名保留；电气工程中的 transformer 可以是变压器 |
| model-free | RL 中不显式依赖环境动力学模型，并不意味着没有神经网络 |

词元不一定对应完整单词，可以是子词等单元，因此此表选“词元 / 分词器”。概念核对参考 [Hugging Face 分词器课程](https://huggingface.co/learn/llm-course/zh-CN/chapter2/4)；这里的中文偏好并非声称该课程规定了唯一译名。

harness 与 RSI 的智能体语境参考 [Lilian Weng 的 Harness Engineering for Self-Improvement](https://lilianweng.github.io/posts/2026-07-04-harness/)；保留 harness 英文及采用“harness 工程”是本词表的阅读偏好。

奖励、回报及状态/观测的区分参考 [Hugging Face 强化学习框架课程](https://huggingface.co/learn/deep-rl-course/en/unit1/rl-framework)。Actor 与 Critic 的角色说明参考 [Hugging Face Actor-Critic 课程](https://huggingface.co/learn/deep-rl-course/en/unit6/advantage-actor-critic)，此表保留算法名，并采用角色含义作辅助释义。

DPO 放在“强化学习与对齐”分类，属于偏好优化相关术语，并不表示它一定需要在线 RL 采样循环；原始方法见 [DPO 论文](https://arxiv.org/abs/2305.18290)。GRPO 的名称与 PPO 变体关系核对自 [DeepSeekMath 论文](https://arxiv.org/abs/2402.03300)。软件工程中的依赖注入概念参考 [Microsoft .NET 文档](https://learn.microsoft.com/zh-cn/dotnet/core/extensions/dependency-injection/overview)。其他词条为按通行用法整理的个人建议，不是从某一官方词典整体复制。

## 分类与数量

| 分类 | 词条数 |
| --- | ---: |
| 通用技术 | 24 |
| 编程与运行时 | 61 |
| 软件工程与系统 | 60 |
| 机器学习基础 | 53 |
| 大模型与生成 | 79 |
| 强化学习与对齐 | 90 |
| 合计 | 367 |

策略分布：固定译文 236、双语术语 73、保留英文 46、优先英文 12。

## 通用技术

| 原词 | 建议译名 / 释义 | 策略 | 领域 | 语境说明 |
| --- | --- | --- | --- | --- |
| algorithm | 算法 | 固定译文 | all | — |
| latency | 延迟 | 固定译文 | all | — |
| throughput | 吞吐量 | 固定译文 | all | — |
| bandwidth | 带宽 | 固定译文 | all | — |
| scalability | 可扩展性 | 固定译文 | all | — |
| reliability | 可靠性 | 固定译文 | all | — |
| availability | 可用性 | 固定译文 | all | — |
| fault tolerance | 容错性 | 固定译文 | all | — |
| bottleneck | 瓶颈 | 固定译文 | all | — |
| benchmark | 基准测试 | 固定译文 | all | 可指测试本身或基准数据集；按上下文调整。 |
| baseline | 基线 | 固定译文 | all | 通常是对照方法或起点；RL 中也可指降低方差的基线。 |
| trade-off | 权衡 | 固定译文 | all | — |
| constraint | 约束 | 固定译文 | all | — |
| heuristic | 启发式方法 | 双语术语 | all | 作形容词时可译为启发式的。 |
| deterministic | 确定性的 | 固定译文 | all | — |
| stochastic | 随机的 | 固定译文 | all | — |
| nondeterministic | 非确定性的 | 固定译文 | all | 不一定涉及概率随机性；例如并发调度顺序不确定。 |
| approximation | 近似 | 固定译文 | all | — |
| performance | 性能 | 固定译文 | all | 讨论评测结果时也可能指模型表现。 |
| GPU | 图形处理器 | 保留英文 | all | 缩写保留；译文栏用于释义。 |
| CPU | 中央处理器 | 保留英文 | all | 缩写保留；译文栏用于释义。 |
| API | 应用程序编程接口 | 保留英文 | all | 缩写保留；译文栏用于释义。 |
| SDK | 软件开发工具包 | 保留英文 | all | 缩写保留；译文栏用于释义。 |
| JSON | JSON | 保留英文 | all | 数据格式名称保留。 |

## 编程与运行时

| 原词 | 建议译名 / 释义 | 策略 | 领域 | 语境说明 |
| --- | --- | --- | --- | --- |
| source code | 源代码 | 固定译文 | software-engineering | — |
| variable | 变量 | 固定译文 | software-engineering | — |
| constant | 常量 | 固定译文 | software-engineering | — |
| data type | 数据类型 | 固定译文 | software-engineering | — |
| type inference | 类型推断 | 固定译文 | software-engineering | — |
| type safety | 类型安全 | 固定译文 | software-engineering | — |
| type checking | 类型检查 | 固定译文 | software-engineering | — |
| type system | 类型系统 | 固定译文 | software-engineering | — |
| function | 函数 | 固定译文 | software-engineering | — |
| method | 方法 | 固定译文 | software-engineering | 指对象或类上的方法；普通叙述中也可能指研究方法。 |
| class | 类 | 固定译文 | software-engineering | 编程语境；机器学习分类语境通常译为类别。 |
| object | 对象 | 固定译文 | software-engineering | — |
| interface | 接口 | 固定译文 | software-engineering | — |
| implementation | 实现 | 固定译文 | software-engineering | — |
| inheritance | 继承 | 固定译文 | software-engineering | — |
| polymorphism | 多态 | 固定译文 | software-engineering | — |
| encapsulation | 封装 | 固定译文 | software-engineering | — |
| generic | 泛型 | 优先英文 | software-engineering | 指泛型编程；作普通形容词时可能应译为通用的。 |
| closure | 闭包 | 双语术语 | software-engineering | — |
| callback | 回调 | 固定译文 | software-engineering | — |
| recursion | 递归 | 固定译文 | software-engineering | — |
| iteration | 迭代 | 固定译文 | software-engineering | — |
| iterator | 迭代器 | 固定译文 | software-engineering | — |
| generator | 生成器 | 固定译文 | software-engineering | — |
| coroutine | 协程 | 双语术语 | software-engineering | — |
| async | 异步 | 优先英文 | software-engineering | 代码关键字和 API 标识符保留英文；正文可用异步。 |
| asynchronous | 异步的 | 固定译文 | software-engineering | — |
| synchronous | 同步的 | 固定译文 | software-engineering | — |
| concurrency | 并发 | 固定译文 | software-engineering | 多个任务在重叠时间段推进；不等于同时执行。 |
| parallelism | 并行 | 固定译文 | software-engineering | 多个任务同时执行；与并发区分。 |
| thread | 线程 | 固定译文 | software-engineering | — |
| process | 进程 | 优先英文 | software-engineering | 操作系统语境；一般叙述中可能是过程或处理。 |
| event loop | 事件循环 | 双语术语 | software-engineering | — |
| race condition | 竞态条件 | 双语术语 | software-engineering | 不等同于 data race；后者是数据竞争。 |
| data race | 数据竞争 | 双语术语 | software-engineering | — |
| deadlock | 死锁 | 固定译文 | software-engineering | — |
| mutex | 互斥锁 | 双语术语 | software-engineering | — |
| semaphore | 信号量 | 双语术语 | software-engineering | — |
| atomic operation | 原子操作 | 固定译文 | software-engineering | — |
| memory leak | 内存泄漏 | 固定译文 | software-engineering | — |
| garbage collection | 垃圾回收 | 固定译文 | software-engineering | — |
| stack | 栈 | 固定译文 | software-engineering | 数据结构或运行时语境；technology stack 应译为技术栈。 |
| heap | 堆 | 固定译文 | software-engineering | 区分内存堆与堆数据结构；两者中文都用堆。 |
| pointer | 指针 | 固定译文 | software-engineering | — |
| reference | 引用 | 固定译文 | software-engineering | 语言语义语境；论文参考文献不采用此义。 |
| ownership | 所有权 | 双语术语 | software-engineering | — |
| borrow checker | 借用检查器 | 双语术语 | software-engineering | — |
| runtime | 运行时 | 固定译文 | software-engineering | — |
| compile time | 编译期 | 固定译文 | software-engineering | — |
| compiler | 编译器 | 固定译文 | software-engineering | — |
| interpreter | 解释器 | 固定译文 | software-engineering | — |
| abstract syntax tree | 抽象语法树 | 双语术语 | software-engineering | — |
| AST | 抽象语法树 | 保留英文 | software-engineering | — |
| lexical token | 词法单元 | 双语术语 | software-engineering | 编译器语境；不是访问令牌或大模型词元。 |
| serialization | 序列化 | 固定译文 | software-engineering | — |
| deserialization | 反序列化 | 固定译文 | software-engineering | — |
| exception | 异常 | 固定译文 | software-engineering | — |
| undefined behavior | 未定义行为 | 双语术语 | software-engineering | — |
| data structure | 数据结构 | 固定译文 | software-engineering | — |
| time complexity | 时间复杂度 | 固定译文 | software-engineering | — |
| space complexity | 空间复杂度 | 固定译文 | software-engineering | — |

## 软件工程与系统

| 原词 | 建议译名 / 释义 | 策略 | 领域 | 语境说明 |
| --- | --- | --- | --- | --- |
| software architecture | 软件架构 | 固定译文 | software-engineering | — |
| design pattern | 设计模式 | 固定译文 | software-engineering | — |
| dependency injection | 依赖注入 | 双语术语 | software-engineering | — |
| inversion of control | 控制反转 | 双语术语 | software-engineering | — |
| dependency | 依赖 | 固定译文 | software-engineering | — |
| coupling | 耦合 | 固定译文 | software-engineering | — |
| cohesion | 内聚 | 固定译文 | software-engineering | — |
| abstraction | 抽象 | 固定译文 | software-engineering | — |
| refactoring | 重构 | 固定译文 | software-engineering | — |
| technical debt | 技术债务 | 固定译文 | software-engineering | — |
| backward compatibility | 向后兼容性 | 固定译文 | software-engineering | — |
| breaking change | 不兼容变更 | 双语术语 | software-engineering | 也常称破坏性变更；这里强调兼容性受影响。 |
| semantic versioning | 语义化版本 | 双语术语 | software-engineering | — |
| unit test | 单元测试 | 固定译文 | software-engineering | — |
| integration test | 集成测试 | 固定译文 | software-engineering | — |
| end-to-end test | 端到端测试 | 固定译文 | software-engineering | — |
| regression test | 回归测试 | 固定译文 | software-engineering | — |
| test coverage | 测试覆盖率 | 固定译文 | software-engineering | — |
| mock | 模拟对象 | 优先英文 | software-engineering | 可指模拟行为或对象；测试工具名称及标识符保留英文。 |
| test fixture | 测试夹具 | 双语术语 | software-engineering | 指测试所需的数据与环境设置；也常简称测试样本或固定数据。 |
| test-driven development | 测试驱动开发 | 双语术语 | software-engineering | — |
| TDD | 测试驱动开发 | 保留英文 | software-engineering | — |
| continuous integration | 持续集成 | 固定译文 | software-engineering | — |
| continuous delivery | 持续交付 | 固定译文 | software-engineering | 与 continuous deployment 的持续部署区分。 |
| continuous deployment | 持续部署 | 固定译文 | software-engineering | — |
| CI/CD | 持续集成与持续交付或部署 | 保留英文 | software-engineering | CD 的展开含义取决于原文。 |
| pull request | 拉取请求 | 双语术语 | software-engineering | 合并评审语境；PR 缩写可保留。 |
| code review | 代码审查 | 固定译文 | software-engineering | — |
| repository | 代码仓库 | 固定译文 | software-engineering | 此处针对源码仓库；其他数据仓库应按上下文调整。 |
| monorepo | 单体代码仓库 | 双语术语 | software-engineering | 多个项目共用一个仓库；不等同于单体应用架构。 |
| distributed system | 分布式系统 | 固定译文 | software-engineering | — |
| microservice | 微服务 | 固定译文 | software-engineering | — |
| RPC | 远程过程调用 | 保留英文 | software-engineering | — |
| idempotency | 幂等性 | 双语术语 | software-engineering | — |
| eventual consistency | 最终一致性 | 固定译文 | software-engineering | — |
| strong consistency | 强一致性 | 固定译文 | software-engineering | 不同系统文档对具体一致性模型的定义可能不同。 |
| transaction | 事务 | 固定译文 | software-engineering | — |
| rollback | 回滚 | 固定译文 | software-engineering | — |
| checkpoint | 检查点 | 固定译文 | software-engineering | 用于保存执行状态；ML 中同样称检查点。 |
| caching | 缓存 | 固定译文 | software-engineering | — |
| cache invalidation | 缓存失效 | 固定译文 | software-engineering | — |
| rate limiting | 限流 | 固定译文 | software-engineering | — |
| backpressure | 背压 | 双语术语 | software-engineering | — |
| exponential backoff | 指数退避 | 双语术语 | software-engineering | — |
| circuit breaker | 熔断器 | 双语术语 | software-engineering | 分布式调用语境；不是电路硬件。 |
| load balancing | 负载均衡 | 固定译文 | software-engineering | — |
| observability | 可观测性 | 双语术语 | software-engineering | — |
| telemetry | 遥测 | 双语术语 | software-engineering | — |
| authentication | 身份验证 | 固定译文 | software-engineering | 确认是谁；与 authorization 授权区分。 |
| authorization | 授权 | 固定译文 | software-engineering | 决定允许做什么；与 authentication 身份验证区分。 |
| access token | 访问令牌 | 固定译文 | software-engineering | 鉴权语境；不要译为词元。 |
| access control | 访问控制 | 固定译文 | software-engineering | — |
| least privilege | 最小权限 | 固定译文 | software-engineering | — |
| attack surface | 攻击面 | 固定译文 | software-engineering | — |
| sandbox | 沙箱 | 双语术语 | software-engineering | — |
| service worker | Service Worker | 保留英文 | software-engineering | Web 平台专用名称保留；不是普通服务端 worker。 |
| rolling deployment | 滚动部署 | 固定译文 | software-engineering | 发布语境；区别于 RL rollout。 |
| canary deployment | 金丝雀部署 | 双语术语 | software-engineering | — |
| feature flag | 功能开关 | 双语术语 | software-engineering | — |
| SQL | 结构化查询语言 | 保留英文 | software-engineering | — |

## 机器学习基础

| 原词 | 建议译名 / 释义 | 策略 | 领域 | 语境说明 |
| --- | --- | --- | --- | --- |
| machine learning | 机器学习 | 固定译文 | machine-learning | — |
| deep learning | 深度学习 | 固定译文 | machine-learning | — |
| supervised learning | 监督学习 | 固定译文 | machine-learning | — |
| unsupervised learning | 无监督学习 | 固定译文 | machine-learning | — |
| self-supervised learning | 自监督学习 | 固定译文 | machine-learning | — |
| neural network | 神经网络 | 固定译文 | machine-learning | — |
| parameter | 参数 | 固定译文 | machine-learning | — |
| hyperparameter | 超参数 | 固定译文 | machine-learning | — |
| weight | 权重 | 固定译文 | machine-learning | — |
| bias | 偏置 | 优先英文 | machine-learning | 网络参数为偏置；统计估计可能是偏差；公平性语境可能是偏见。 |
| tensor | 张量 | 固定译文 | machine-learning | — |
| embedding | 嵌入 | 双语术语 | machine-learning | 可指表示或映射；具体向量可称嵌入向量。 |
| latent space | 潜在空间 | 双语术语 | machine-learning | — |
| feature | 特征 | 固定译文 | machine-learning | ML 特征；软件功能应按软件工程语境翻译。 |
| label | 标签 | 固定译文 | machine-learning | — |
| training set | 训练集 | 固定译文 | machine-learning | — |
| validation set | 验证集 | 固定译文 | machine-learning | — |
| test set | 测试集 | 固定译文 | machine-learning | — |
| data augmentation | 数据增强 | 固定译文 | machine-learning | — |
| data leakage | 数据泄漏 | 固定译文 | machine-learning | 训练或选择模型时使用了本不应可用的信息。 |
| overfitting | 过拟合 | 固定译文 | machine-learning | — |
| underfitting | 欠拟合 | 固定译文 | machine-learning | — |
| generalization | 泛化 | 固定译文 | machine-learning | — |
| regularization | 正则化 | 固定译文 | machine-learning | — |
| loss function | 损失函数 | 固定译文 | machine-learning | — |
| objective function | 目标函数 | 固定译文 | machine-learning | — |
| gradient descent | 梯度下降 | 固定译文 | machine-learning | — |
| stochastic gradient descent | 随机梯度下降 | 固定译文 | machine-learning | — |
| SGD | 随机梯度下降 | 保留英文 | machine-learning | — |
| backpropagation | 反向传播 | 固定译文 | machine-learning | — |
| forward pass | 前向传播 | 固定译文 | machine-learning | — |
| learning rate | 学习率 | 固定译文 | machine-learning | — |
| batch size | 批大小 | 固定译文 | machine-learning | — |
| mini-batch | 小批量 | 双语术语 | machine-learning | — |
| epoch | 训练轮次 | 双语术语 | machine-learning | 完整遍历训练集一次；不等同于一个优化器更新步骤。 |
| training step | 训练步 | 固定译文 | machine-learning | — |
| optimizer | 优化器 | 固定译文 | machine-learning | — |
| gradient clipping | 梯度裁剪 | 固定译文 | machine-learning | — |
| gradient accumulation | 梯度累积 | 固定译文 | machine-learning | — |
| checkpoint | 检查点 | 固定译文 | machine-learning | 可含模型与优化器状态；区别于泛指权重文件。 |
| inference | 推理 | 固定译文 | machine-learning | 指运行模型得到输出；与 reasoning 推理过程区分。 |
| distillation | 蒸馏 | 固定译文 | machine-learning | — |
| quantization | 量化 | 固定译文 | machine-learning | — |
| pruning | 剪枝 | 固定译文 | machine-learning | — |
| mixed precision | 混合精度 | 固定译文 | machine-learning | — |
| accuracy | 准确率 | 保留英文 | machine-learning | 保留英文以区分评测指标；target 仅作释义，普通叙述也可能指准确性。 |
| precision | 精度 / 查准率 | 保留英文 | machine-learning | 保留英文；数值格式语境为精度，分类指标语境为查准率，避免与 accuracy 混淆。 |
| recall | 召回率 | 固定译文 | machine-learning | 也常译为查全率；此词表统一采用召回率。 |
| F1 score | F1 分数 | 固定译文 | machine-learning | — |
| ablation study | 消融实验 | 固定译文 | machine-learning | — |
| out-of-distribution | 分布外 | 双语术语 | machine-learning | — |
| OOD | 分布外 | 保留英文 | machine-learning | — |
| PyTorch | PyTorch | 保留英文 | machine-learning | 框架名称保留。 |

## 大模型与生成

| 原词 | 建议译名 / 释义 | 策略 | 领域 | 语境说明 |
| --- | --- | --- | --- | --- |
| harness | 智能体运行系统 | 保留英文 | machine-learning | 智能体工具调用、上下文与执行流程的系统层；在该语境保留英文，普通英语另议。 |
| harness engineering | harness 工程 | 固定译文 | machine-learning | 个人偏好保留 harness；如偏好全英文，可改为 keep。 |
| recursive self-improvement | 递归自我改进 | 双语术语 | machine-learning | AI 自我改进的反馈循环；缩写 RSI 保留。 |
| RSI | 递归自我改进 | 保留英文 | machine-learning | recursive self-improvement 的缩写；该规则限于机器学习语境。 |
| large language model | 大语言模型 | 固定译文 | machine-learning | — |
| LLM | 大语言模型 | 保留英文 | machine-learning | — |
| foundation model | 基础模型 | 双语术语 | machine-learning | — |
| pretraining | 预训练 | 固定译文 | machine-learning | — |
| pre-training | 预训练 | 固定译文 | machine-learning | 常见拼写变体。 |
| post-training | 后训练 | 固定译文 | machine-learning | — |
| fine-tuning | 微调 | 固定译文 | machine-learning | — |
| supervised fine-tuning | 监督微调 | 固定译文 | machine-learning | — |
| SFT | 监督微调 | 保留英文 | machine-learning | — |
| instruction tuning | 指令微调 | 固定译文 | machine-learning | — |
| instruction following | 指令遵循 | 固定译文 | machine-learning | — |
| alignment | 对齐 | 双语术语 | machine-learning | LLM 行为与目标或偏好对齐；其他领域可能指文本或几何对齐。 |
| preference optimization | 偏好优化 | 固定译文 | machine-learning | — |
| prompt | 提示词 | 固定译文 | machine-learning | 全文输入或输入模板也常称提示；代码标识符不翻译。 |
| prompt engineering | 提示词工程 | 固定译文 | machine-learning | — |
| system prompt | 系统提示词 | 固定译文 | machine-learning | — |
| prompt injection | 提示词注入 | 固定译文 | machine-learning | — |
| context window | 上下文窗口 | 固定译文 | machine-learning | — |
| token | 词元 | 双语术语 | machine-learning | LLM 语境；编译器词法单元和鉴权令牌不能套用此译法。 |
| tokenizer | 分词器 | 双语术语 | machine-learning | 输出的单元不一定是完整词；也存在字符和字节级分词。 |
| tokenization | 词元化 | 双语术语 | machine-learning | 中文资料也常称分词；此处不暗示按完整单词切分。 |
| vocabulary | 词表 | 固定译文 | machine-learning | — |
| subword | 子词 | 固定译文 | machine-learning | — |
| byte pair encoding | 字节对编码 | 双语术语 | machine-learning | — |
| BPE | 字节对编码 | 保留英文 | machine-learning | — |
| autoregressive | 自回归的 | 固定译文 | machine-learning | — |
| next-token prediction | 下一词元预测 | 固定译文 | machine-learning | — |
| causal language model | 因果语言模型 | 双语术语 | machine-learning | 因果掩码建模语境；不等同于因果推断模型。 |
| Transformer | Transformer | 保留英文 | machine-learning | 模型架构名称保留；电气语境的 transformer 是变压器。 |
| attention | 注意力 | 固定译文 | machine-learning | — |
| self-attention | 自注意力 | 固定译文 | machine-learning | — |
| cross-attention | 交叉注意力 | 固定译文 | machine-learning | — |
| multi-head attention | 多头注意力 | 固定译文 | machine-learning | — |
| positional encoding | 位置编码 | 固定译文 | machine-learning | — |
| rotary position embedding | 旋转位置嵌入 | 双语术语 | machine-learning | — |
| RoPE | 旋转位置嵌入 | 保留英文 | machine-learning | — |
| KV cache | 键值缓存 | 双语术语 | machine-learning | 注意力机制的 key/value 缓存；不同于一般应用缓存。 |
| prefill | 预填充 | 双语术语 | machine-learning | 处理提示词输入的推理阶段；与逐词元解码阶段区分。 |
| decoding | 解码 | 固定译文 | machine-learning | — |
| greedy decoding | 贪心解码 | 固定译文 | machine-learning | — |
| beam search | 束搜索 | 双语术语 | machine-learning | — |
| top-k sampling | top-k 采样 | 固定译文 | machine-learning | — |
| top-p sampling | top-p 采样 | 固定译文 | machine-learning | 也称 nucleus sampling 核采样。 |
| temperature | 温度 | 双语术语 | machine-learning | 控制采样分布的参数；不是硬件温度。 |
| logit | logit | 优先英文 | machine-learning | 模型输出未归一化分数；统计语境可指对数几率。 |
| log probability | 对数概率 | 固定译文 | machine-learning | — |
| perplexity | 困惑度 | 双语术语 | machine-learning | — |
| chain of thought | 思维链 | 双语术语 | machine-learning | — |
| CoT | 思维链 | 保留英文 | machine-learning | — |
| reasoning | 推理过程 | 优先英文 | machine-learning | 与运行模型的 inference 区分；不意味着输出一定正确。 |
| test-time compute | 测试时计算 | 双语术语 | machine-learning | 也常称推理时计算；注意与训练计算区分。 |
| in-context learning | 上下文学习 | 双语术语 | machine-learning | — |
| few-shot learning | 少样本学习 | 固定译文 | machine-learning | — |
| zero-shot learning | 零样本学习 | 固定译文 | machine-learning | — |
| retrieval-augmented generation | 检索增强生成 | 固定译文 | machine-learning | — |
| RAG | 检索增强生成 | 保留英文 | machine-learning | — |
| vector database | 向量数据库 | 固定译文 | machine-learning | — |
| reranking | 重排序 | 固定译文 | machine-learning | — |
| hallucination | 幻觉 | 双语术语 | machine-learning | 模型生成不受事实或给定上下文支持的内容。 |
| tool calling | 工具调用 | 固定译文 | machine-learning | — |
| function calling | 函数调用 | 固定译文 | machine-learning | LLM 调用工具接口的语境；普通编程中也使用函数调用。 |
| AI agent | AI 智能体 | 固定译文 | machine-learning | — |
| agent | 智能体 | 双语术语 | machine-learning | ML/RL 语境；网络代理或软件代理应按相应语境处理。 |
| agentic workflow | 智能体工作流 | 双语术语 | machine-learning | — |
| multimodal | 多模态的 | 固定译文 | machine-learning | — |
| mixture of experts | 混合专家 | 双语术语 | machine-learning | — |
| MoE | 混合专家 | 保留英文 | machine-learning | — |
| parameter-efficient fine-tuning | 参数高效微调 | 固定译文 | machine-learning | — |
| PEFT | 参数高效微调 | 保留英文 | machine-learning | — |
| LoRA | 低秩适配 | 保留英文 | machine-learning | — |
| QLoRA | 量化低秩适配 | 保留英文 | machine-learning | 保留方法名；并非任意量化后使用 LoRA 的统称。 |
| speculative decoding | 推测解码 | 双语术语 | machine-learning | — |
| continuous batching | 连续批处理 | 双语术语 | machine-learning | — |
| time to first token | 首词元延迟 | 固定译文 | machine-learning | — |
| TTFT | 首词元延迟 | 保留英文 | machine-learning | — |

## 强化学习与对齐

| 原词 | 建议译名 / 释义 | 策略 | 领域 | 语境说明 |
| --- | --- | --- | --- | --- |
| reinforcement learning | 强化学习 | 固定译文 | machine-learning | — |
| RL | 强化学习 | 保留英文 | machine-learning | — |
| deep reinforcement learning | 深度强化学习 | 固定译文 | machine-learning | — |
| environment | 环境 | 固定译文 | machine-learning | 智能体交互的环境；软件开发环境不采用 RL 含义。 |
| state | 状态 | 固定译文 | machine-learning | — |
| observation | 观测 | 固定译文 | machine-learning | 观测与完整状态不一定相同。 |
| action | 动作 | 固定译文 | machine-learning | — |
| state space | 状态空间 | 固定译文 | machine-learning | — |
| action space | 动作空间 | 固定译文 | machine-learning | — |
| reward | 奖励 | 固定译文 | machine-learning | 通常是某一步的反馈；与 return 累积回报区分。 |
| reward function | 奖励函数 | 固定译文 | machine-learning | — |
| return | 回报 | 优先英文 | machine-learning | 仅 RL 中通常表示累积奖励；普通叙述与代码 return 不强制套用。 |
| expected return | 期望回报 | 固定译文 | machine-learning | — |
| discounted return | 折扣回报 | 固定译文 | machine-learning | — |
| discount factor | 折扣因子 | 固定译文 | machine-learning | 常记为 gamma；符号保持原样。 |
| episode | 回合 | 双语术语 | machine-learning | 从开始到终止的交互回合；不等同于训练 epoch。 |
| trajectory | 轨迹 | 固定译文 | machine-learning | — |
| rollout | 轨迹采样 | 优先英文 | machine-learning | 可指执行过程或采样结果；可能是完整回合或截断片段；不是滚动发布。 |
| horizon | 时域长度 | 双语术语 | machine-learning | 指决策时间跨度；具体语境也可称规划时域。 |
| policy | 策略 | 固定译文 | machine-learning | RL 中从状态或观测到动作的规则或分布；软件安全语境不是此义。 |
| policy network | 策略网络 | 固定译文 | machine-learning | — |
| policy gradient | 策略梯度 | 固定译文 | machine-learning | — |
| policy optimization | 策略优化 | 固定译文 | machine-learning | — |
| value function | 价值函数 | 固定译文 | machine-learning | — |
| state-value function | 状态价值函数 | 固定译文 | machine-learning | — |
| action-value function | 动作价值函数 | 固定译文 | machine-learning | — |
| Q-function | Q 函数 | 固定译文 | machine-learning | — |
| advantage function | 优势函数 | 固定译文 | machine-learning | — |
| actor | 策略网络 | 优先英文 | machine-learning | Actor-Critic 中通常为策略部分；不硬译为演员；其他智能体架构可能含义不同。 |
| critic | 价值评估器 | 优先英文 | machine-learning | Actor-Critic 中用于价值估计；可具体称价值网络；其他 LLM 评审器语境另议。 |
| actor-critic | Actor-Critic | 保留英文 | machine-learning | 保留算法族名称；正文解释为结合策略学习和价值估计。 |
| exploration | 探索 | 固定译文 | machine-learning | — |
| exploitation | 利用 | 双语术语 | machine-learning | 利用已有知识选择动作；不要在 RL 中译为剥削。 |
| exploration-exploitation trade-off | 探索与利用的权衡 | 固定译文 | machine-learning | — |
| on-policy | 同策略 | 双语术语 | machine-learning | 也常译为在策略；描述采样与学习策略的关系。 |
| off-policy | 异策略 | 双语术语 | machine-learning | 也常译为离策略；与离线学习 offline 区分。 |
| online reinforcement learning | 在线强化学习 | 固定译文 | machine-learning | — |
| offline reinforcement learning | 离线强化学习 | 固定译文 | machine-learning | 通常从固定数据集学习；不是 off-policy 的同义词。 |
| model-based | 基于模型的 | 双语术语 | machine-learning | RL 中的模型通常指环境动力学模型；不是泛指使用神经网络。 |
| model-free | 无模型的 | 双语术语 | machine-learning | 不显式依赖环境动力学模型；可以使用神经网络。 |
| Markov decision process | 马尔可夫决策过程 | 固定译文 | machine-learning | — |
| MDP | 马尔可夫决策过程 | 保留英文 | machine-learning | — |
| POMDP | 部分可观测马尔可夫决策过程 | 保留英文 | machine-learning | — |
| Bellman equation | 贝尔曼方程 | 固定译文 | machine-learning | — |
| temporal difference | 时序差分 | 双语术语 | machine-learning | — |
| TD error | 时序差分误差 | 双语术语 | machine-learning | — |
| bootstrapping | 自举估计 | 优先英文 | machine-learning | TD 学习中利用已有估计更新估计；统计学自助采样和软件引导需另行判断。 |
| Monte Carlo | 蒙特卡洛 | 固定译文 | machine-learning | — |
| replay buffer | 经验回放缓冲区 | 固定译文 | machine-learning | — |
| experience replay | 经验回放 | 固定译文 | machine-learning | — |
| target network | 目标网络 | 固定译文 | machine-learning | — |
| behavior policy | 行为策略 | 固定译文 | machine-learning | — |
| target policy | 目标策略 | 固定译文 | machine-learning | — |
| importance sampling | 重要性采样 | 固定译文 | machine-learning | — |
| entropy bonus | 熵奖励项 | 双语术语 | machine-learning | 鼓励策略保持一定随机性的正则项。 |
| credit assignment | 信用分配 | 双语术语 | machine-learning | 也常称贡献归因；确定哪些状态或动作促成了结果。 |
| reward shaping | 奖励塑形 | 双语术语 | machine-learning | — |
| reward hacking | 奖励投机 | 双语术语 | machine-learning | 利用奖励机制漏洞；奖励高不代表实现了真正目标。 |
| sparse reward | 稀疏奖励 | 固定译文 | machine-learning | — |
| sample efficiency | 样本效率 | 固定译文 | machine-learning | — |
| imitation learning | 模仿学习 | 固定译文 | machine-learning | — |
| behavior cloning | 行为克隆 | 固定译文 | machine-learning | — |
| inverse reinforcement learning | 逆强化学习 | 固定译文 | machine-learning | — |
| Q-learning | Q 学习 | 双语术语 | machine-learning | — |
| DQN | 深度 Q 网络 | 保留英文 | machine-learning | — |
| REINFORCE | REINFORCE | 保留英文 | machine-learning | 算法名称保留；不按普通动词翻译。 |
| proximal policy optimization | 近端策略优化 | 固定译文 | machine-learning | — |
| PPO | 近端策略优化 | 保留英文 | machine-learning | — |
| trust region policy optimization | 信赖域策略优化 | 固定译文 | machine-learning | — |
| TRPO | 信赖域策略优化 | 保留英文 | machine-learning | — |
| SAC | Soft Actor-Critic | 保留英文 | machine-learning | 保留缩写与方法名；soft 指熵正则化目标。 |
| generalized advantage estimation | 广义优势估计 | 固定译文 | machine-learning | — |
| GAE | 广义优势估计 | 保留英文 | machine-learning | — |
| reinforcement learning from human feedback | 基于人类反馈的强化学习 | 固定译文 | machine-learning | — |
| RLHF | 基于人类反馈的强化学习 | 保留英文 | machine-learning | — |
| RLAIF | 基于 AI 反馈的强化学习 | 保留英文 | machine-learning | — |
| reward model | 奖励模型 | 固定译文 | machine-learning | — |
| preference data | 偏好数据 | 固定译文 | machine-learning | — |
| reference model | 参考模型 | 固定译文 | machine-learning | — |
| KL divergence | KL 散度 | 双语术语 | machine-learning | — |
| KL penalty | KL 惩罚项 | 固定译文 | machine-learning | — |
| direct preference optimization | 直接偏好优化 | 固定译文 | machine-learning | 偏好优化方法；不要求在线 RL 采样循环。 |
| DPO | 直接偏好优化 | 保留英文 | machine-learning | — |
| group relative policy optimization | 组相对策略优化 | 固定译文 | machine-learning | 方法名；不要与 DPO 混淆。 |
| GRPO | 组相对策略优化 | 保留英文 | machine-learning | — |
| verifiable reward | 可验证奖励 | 固定译文 | machine-learning | 例如基于可执行测试或答案校验获得的奖励；仍取决于校验器质量。 |
| RLVR | 基于可验证奖励的强化学习 | 保留英文 | machine-learning | — |
| process reward model | 过程奖励模型 | 固定译文 | machine-learning | — |
| PRM | 过程奖励模型 | 保留英文 | machine-learning | — |
| outcome reward model | 结果奖励模型 | 固定译文 | machine-learning | — |
