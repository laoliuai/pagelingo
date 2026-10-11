# 网页 / PDF 规格审阅与修订记录

日期：2026-10-06。审阅对象为重命名后的 `web-spec.md`、新增 `pdf-spec.md` 和当前 M1.5 SDK。PDF 初始全文已保存在 [archive/pdf-spec-initial.md](archive/pdf-spec-initial.md)。以下是设计审阅与本轮修订，不代表 PDF / LaTeX 功能已实现。

## 结论

浏览器规格与现有实现基本一致，继续先做扩展 M2 / M3。PDF 的“语义重建 → 连续 HTML → 按块对照”路线合理；主要需要统一执行边界、数据协议、缓存与恢复语义。仓库按 [monorepo.md](monorepo.md) 组织，未来 LaTeX 接入同一个 Reader 和 SDK。

## 主要发现

| 优先级 | 原规格位置 | 问题及影响 | 修订 |
| --- | --- | --- | --- |
| P1 | PDF §54、§61、§153 | Python 另写翻译管线、只共享文本资源，不能保证“修改 SDK，各应用受益”；槽位协议也不同于现有 SDK | 翻译只由 TS SDK 执行，Python 限定为解析 / 重建；统一使用 SDK 编解码与结果校验 |
| P1 | PDF §14–20、§55 | Reader 的 figure / table / provenance 等结构不能直接传给现有 SDK；扁平 InlineSpan 也不能完整表达嵌套格式 | 区分 Reader IR 与 TranslationDocument，显式投影 / 回填；跨语言协议版本化，不把坐标或源码路径塞进 SDK |
| P1 | PDF §51–52、§80–83、§141 | 顺序参与 blockId 会在重解析时漂移；缓存遗漏 provider、endpoint、生成配置、源语言、上下文和保护版本；重复上传不一定零翻译 | 块身份限定在 parse run；缓存按语义与真实依赖构建，读取后重绑对象并校验；去重与可复用结果分开 |
| P1 | PDF §88–97、§145 | 只有阶段列表和 SQLite 记录不能保证恢复；缺少取消、租约、重试计数、运行版本，Job 到 Phase 9 才加入过晚 | status / stage 分开，解析开始就有持久化任务与阶段产物；迟到结果按 run ID 拒绝，SSE 可恢复或轮询兜底 |
| P2 | PDF §7、§98–105 | 同时预定 MinerU 为主解析器又要求评测后决定；未固定 backend、模型、设备与测量预算 | MinerU / Docling 为优先候选，Marker 为比较项；主解析器等 P0 实测后确定，记录代码 / 模型版本与运行条件 |
| P2 | PDF §12、§24–32、§105 | 0–1 bbox 未说明原点 / 裁剪 / 旋转；页眉删除和跨页合并启发式可能静默丢内容；confidence 不具通用概率意义 | 明确坐标变换与页索引；保留 raw 数据和归一化记录；不确定时保留结构并标记可见降级 |
| P2 | PDF §5、§95、§138 | 普通复杂多栏和 500 页缺少可测验收定义 | V1 正式范围先单 / 双栏，复杂版面作挑战集；容量上限与质量覆盖分开，补充 98% 总体正文块保留率等初始目标，P0 实测后冻结范围 / 门槛 |
| P2 | PDF §145、§154–157 | “第一个 Codex 任务”容易误导为立即开始 PDF，覆盖插件优先顺序 | 显式写明所有 PDF Phase 在浏览器阶段之后；本轮不安装解析模型或启动网站开发 |

## 已落地的组织变化

浏览器应用、配置及自身测试迁到 `apps/extension`；SDK 保留独立 workspace 和打包消费测试。根命令默认仍面向插件，产物改为 `apps/extension/dist/`。网站、文档服务、Python parser、文档协议及评测目录只记录规划。

`web-spec.md` 增加名称说明与 monorepo 链接；README 修复旧 `docs/spec.md` 引用。PDF 对冲突章节作局部修订，保留其产品体验与详细材料。LaTeX 增加草案，区分 HTML 阅读与译后源码导出 / 编译，避免将后者捆绑进第一版。

## 需要后续实证的事项

- 当前 Mock 不能证明真实翻译质量；扩展 M2 / M3 仍需模型请求、预算 / 缓存、人工术语评测及真实站点验收。
- PDF 解析器需固定代码、backend、模型权重版本、设备、OCR / VLM 开关，再用同一批论文测量质量与 CPU / GPU / 内存 / 耗时。没有跑 benchmark，不给出“最佳解析器”的结论。
- 论文来源的合法可用样本、实际硬件资源、复杂公式的可接受降级比例，在 P0 确认；文件大小上限不代表对所有 500 页论文作质量承诺。
- LaTeX 的自定义宏、主文件识别、转换后的源码定位与中文重新编译，需要单独样本验证；不能从 PDF 适配器成功推断这些已解决。

## 一手依据

- [MinerU 官方仓库](https://github.com/opendatalab/MinerU)：当前提供不同解析入口 / runtime，选型必须落到具体版本和输出能力，不能只写一个产品名。
- [Docling 官方仓库](https://github.com/docling-project/docling)：列出布局、阅读顺序、表格等能力，适合作为同批比较候选；其文档还区分代码与模型许可。
- [Marker 官方仓库](https://github.com/datalab-to/marker)：提供结构化输出和可选模型增强，评测应记录开关，避免把额外模型调用混入同一成本口径。
- [PyMuPDF 页面坐标说明](https://pymupdf.readthedocs.io/en/latest/page.html#Page.rotation_matrix)：旋转与非旋转坐标有明确区别，需要适配器转换和回归测试。
- [LaTeXML 官方介绍](https://math.nist.gov/~BMiller/LaTeXML/)：支持将 LaTeX 转为 XML / HTML / MathML，可作为 HTML 阅读路径的候选；是否保留本项目需要的来源映射仍须实测。

上述文档用于核对能力边界，候选名单和架构取舍是本项目的工程判断，不是对任一工具准确率、兼容性或部署许可的保证。
