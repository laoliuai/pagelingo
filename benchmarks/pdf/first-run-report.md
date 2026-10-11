# PDF P0 首轮实测报告

日期：2026-10-07。本轮已完成两份用户 PDF 与三篇固定版本论文的 Docling / MinerU 解析比较；两本书均做了抽样和全文测试。已实现可运行的解析入口、原始输出留存、公共评测格式、来源映射和离线检查页，尚未实现 PDF 翻译网站。

**本轮是 CPU 基线，正式主配置暂不冻结。** MinerU 在本轮提供了结构化行内公式，但长书 CPU 耗时与内存明显更高。Docling 本轮未启用公式增强，因此结果不能代表它的全部公式能力。旋转挑战还发现了 MinerU 的漏内容问题，需纳入支持范围与失败检测。

用户阅读反馈后，后续明确优先效果，比较 MinerU standard / advanced 的代表页，并使用一致的语义渲染视图。已从本轮 raw 导出可离线原文预览，改善 `debug.html` 的普通文本展示；这不改变本报告的解析基线，也不证明增强配置已验收。当前机器处理、服务器保存阅读以及完整静态包的边界见 [处理设计](../../docs/pdf-processing.md)。

本轮不是完整 P0 验收：现有 5 份输入，尚未达到规格要求的 20–50 份 corpus / 至少 10 份人工 golden IR。正文留存率、阅读顺序正确率和公式准确率保持 `null`，不能用字符数、块数或页面数代替。机器结果见 [first-run-summary.json](first-run-summary.json)，抽查记录见 [smoke-observations.json](smoke-observations.json)。

## 输入与运行条件

| 输入 | 原 PDF 页数 | 本轮用途 |
| --- | ---: | --- |
| Foundations of Large Language Models，用户提供的 v3 文件 | 317 | 12 页抽样、全文、公式 / 图表 / 代码与长文资源挑战 |
| The Little Book of Reinforcement Learning，用户提供的文件 | 154 | 12 页抽样、全文、图注 / 提示框 / 策略梯度公式 |
| Attention Is All You Need，1706.03762v7 | 15 | 单栏论文全文 |
| Mamba，2312.00752v2 | 36 | 单栏论文全文，图表与附录 |
| BERT，1810.04805v2 | 16 | 双栏正文全文 |

输入 hash、来源与抽样页在 [corpus.json](corpus.json)。页号均为 PDF 物理页号，不是印刷页码。每个候选的五份全文共 538 页；这表示请求与输出页面覆盖，不表示每段内容已经正确识别。用户原文件没有被修改。

机器为 WSL2 Linux、Intel i7-12700K、20 个逻辑 CPU、47.0 GiB RAM。本轮完全使用 CPU；GPU 未评测。候选串行启动，申请 4 个计算线程，每次新起进程，模型已准备、系统缓存未强制清空。依赖由 [uv.lock](../../services/document-parser/uv.lock) 固定，模型由 [models.lock.json](models.lock.json) 固定到 commit / 文件指纹。

| 候选 | 本轮实际配置 |
| --- | --- |
| Docling 2.134.0 | Python 3.12.2，PyPDFium backend，Heron，TableFormer accurate，Torch 2.8.0 CPU；OCR / formula enrichment / code enrichment / VLM 关闭 |
| MinerU 4.0.10 | Python 3.12.2，DocVortex 0.5.10，basic，CPU ONNX，`parse_mode=txt`，image analysis 开启，明确请求 `page_range=all`；VLM 关闭 |

MinerU 的 `txt` 不表示完全没有 OCR，运行日志包含区域 OCR 和公式识别。权重经过文件校验，子进程使用离线本地模型；未调用翻译 LLM，也没有把 PDF 上传到远程解析服务。安装与复现命令见 [parser README](../../services/document-parser/README.md)。

## 全文资源实测

以下耗时为监控器记录的 **workerSeconds**，包含新进程初始化、推理与上游结果导出，便于用同一边界比较。它不包含模型下载、控制器的 hash 预检、公共投影和原页渲染。`parseSeconds` 也保存在 JSON，但两种 SDK 的计时边界不同：MinerU 包含原生 sidecar 保存，Docling 的导出位于该计时段之后，不直接将它们作为公平的端到端耗时。

| 全文输入 | Docling worker | MinerU worker | Docling 峰值 RSS | MinerU 峰值 RSS |
| --- | ---: | ---: | ---: | ---: |
| LLM Foundations，317 页 | 269.0 s（4.5 分钟） | 1062.8 s（17.7 分钟） | 2.59 GiB | 7.37 GiB |
| RL Little Book，154 页 | 125.7 s（2.1 分钟） | 309.2 s（5.2 分钟） | 2.87 GiB | 4.86 GiB |
| Attention，15 页 | 27.3 s | 47.6 s | 1.90 GiB | 4.17 GiB |
| Mamba，36 页 | 53.6 s | 108.5 s | 2.42 GiB | 5.13 GiB |
| BERT，16 页 | 28.9 s | 37.7 s | 1.82 GiB | 4.59 GiB |

| 相同 12 页抽样 | Docling worker / RSS | MinerU worker / RSS |
| --- | ---: | ---: |
| LLM Foundations | 24.5 s / 2.14 GiB | 64.8 s / 4.09 GiB |
| RL Little Book | 17.4 s / 1.90 GiB | 31.2 s / 3.31 GiB |

RSS 为每 200 ms 采样的候选进程树总和，共享页可能重复计数，也可能漏过更短的峰值；它不是整机或生产服务内存预算。长书不能只按少量抽样页线性推算。基于当前数据，服务器首版适合先限制为一个解析任务并发，再测包含 API、数据库和渲染的整机峰值；这是一项部署建议，尚非部署验收结果。

## 内容与结构抽查

- **行内与独立公式：** MinerU 全文 raw 中，LLM 书有 1297 个 `equation_inline` span，RL 书有 409 个。公共格式保留原始类型和 LaTeX；这些是结构计数，不是识别准确率。LaTeX 可能含 OCR 错误，始终保留原页 / 区域。Docling 当前配置的行内数学多为普通文本，独立公式使用原图兜底；原图保留不能算作公式识别成功。
- **跨页段落：** LLM 书物理页 49–50 的一个段落，Docling 原始结果已合并并保留两页来源；MinerU 保留分块及 `continues_prev=true`。P2 应依据阅读流与这个线索重建，同时保留所有来源，避免仅凭句尾标点合并。
- **图内文字与图注：** Docling raw 本身有正确的 `picture.children`。最初是我们公共适配器丢了 `parentId`，将图内标签提升成正文。已修复并添加回归测试，七份 Docling 结果从 raw 重新投影；这是本项目的错误，不能归为 Docling 的问题。检查页展开的子项仍保留父子关系，不是普通正文段落。
- **双栏：** 抽查 BERT 开头，两个候选都先读取左栏摘要 / 正文再读右栏，未见按行跨栏穿插。这是局部人工检查，不能据此声称阅读顺序达到 98%。
- **图表、代码与提示框：** 两个候选都保留可回到原页的视觉区域，但图 / 表分类和说明关系仍需语义重建。例如书中的网络结构图可能被判为 table。未知类型、原 payload 和 sidecar 均保留，不能用投影文字直接进入翻译 SDK。
- **普通来源定位：** 本轮五份全文的可翻译顶层块均有来源。Docling LLM 全文有 4 个无效 bbox，已降为页级来源并警告；MinerU 无这类 bbox 警告。没有警告不等于定位全部经过人工验收。

Docling 的修正结果在 `docling-projected/`，其推理时间和资源数值明确继承原始 `docling-full/` / smoke 运行；原记录未覆盖，也没有把重投影计为新推理测试。

## 旋转 / CropBox 挑战

[自制 4 页 PDF](fixtures/crop-rotation.pdf) 的 CropBox 原点非零，旋转分别为 0 / 90 / 180 / 270°，每页有相同的三行原生文字与红色矩形。这份挑战不混入科技论文质量指标。

Docling 输出了四页的内容，但当前 adapter 尚未校准非零 CropBox 的 bbox，11 个块来源明确降为页级；部分旋转页的行分组 / 顺序也不同，不能宣称精确定位与阅读顺序通过。MinerU 的 0° / 180° 图框在原页上能够对应，90° / 270° 两页却没有内容块；raw 有页面容器，解析器仍报告 success。

已新增 `source_text_without_blocks` 检测：原页有非空原生文字、结果没有任何来源块时，公共结果为 **partial**，CLI 返回非零退出码并保留原件 / 日志。真正空白页不判失败。用同一真实挑战再次运行后，正确报告物理页 2、4；这是检测失败，尚未修复上游旋转识别。两本书和三篇论文没有出现此问题。

检查 [MinerU 挑战结果](runs/2026-10-07/mineru-coordinates-checked/debug.html) / [诊断 JSON](runs/2026-10-07/mineru-coordinates-checked/run.json)，以及 [Docling 挑战结果](runs/2026-10-07/docling-coordinates/debug.html)。通用坐标转换另通过了四种旋转的实际 PDFium 像素单测，但这不替代 ML backend 校准。目前主评测范围仍为正常方向的 born-digital 文档，旋转页面属于已知挑战。

## 查看产物

下载 / 复制源码时，大型 PDF、模型与 `runs/` 被忽略；以下链接仅指当前工作区真实产物。用浏览器打开 `debug.html`：左边是内容块、子项与保留图，右边是原页与编号框，点击编号可定位到对应块。这是解析检查页面，不是已完成的翻译 Reader。

| 用户 PDF | Docling 修正检查页 | MinerU 全文检查页 |
| --- | --- | --- |
| LLM Foundations | [打开](runs/2026-10-07/docling-projected/docling-llm-foundations/debug.html) | [打开](runs/2026-10-07/mineru-full/mineru-llm-foundations/debug.html) |
| RL Little Book | [打开](runs/2026-10-07/docling-projected/docling-rl-little-book/debug.html) | [打开](runs/2026-10-07/mineru-full/mineru-rl-little-book/debug.html) |

每份目录都有 raw / normalized JSON、PDF 原件、全部请求页的截图、区域图、配置 / 资源记录与文件 SHA-256 manifest。MinerU 原生图片引用已落盘；raw 引用能解析回原 payload。公开论文同样有全文检查页，路径列于机器汇总。

## 复现与许可记录

Docling 的代码为 MIT；本轮 Heron 权重 metadata 为 Apache-2.0，TableFormer 为 CDLA-Permissive-2.0。代码和模型许可分别记录，见 [Docling LICENSE](https://github.com/docling-project/docling/blob/main/LICENSE) 与 [模型锁](models.lock.json)。

MinerU 4.0.10 wheel 的 `License-Expression` 为 `LicenseRef-MinerU-Open-Source-License`，基于 Apache-2.0 加附加条件，包括向第三方提供在线服务时的署名，以及 MAU 超过 1 亿 / 月总收入超过 2000 万美元的商业许可门槛。不能简单写成纯 Apache-2.0。见 [官方 LICENSE.md](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)。

MinerU ONNX 模型集合的统一 license metadata 缺失，故锁中保持 `null`；已下载的固定 revision README 明确保留原模型许可 / attribution，manifest 列出上游来源与文件指纹。见 [固定模型仓库](https://huggingface.co/opendatalab/MinerU-4_models_onnx/tree/358310b4f64b95f9fefc372ad899356e4111f376)。这不是逐个第三方权重许可已审查完毕的声明，正式选型继续补齐。

## 验证与后续

已通过 36 项 Python 测试和 Ruff 检查、现有 npm TypeScript 类型检查。测试包含真实进程失败 / 超时、密钥隔离、路径与 symlink、实际 PDFium 坐标像素、层级保留、缺页 / 空白页区分与重投影证据篡改。离线检查页已在 Chromium 验证编号链接、原页 / 图片加载及无脚本异常。

接下来先扩展 corpus 与人工 golden，补齐公式 / 双栏 / 跨页 / 来源指标、模型许可和主配置资源上限，再冻结正式 Reader IR。随后 P1 建立 PostgreSQL schema / migrations、LocalObjectStore、上传与独立 API / worker、租约 / 恢复 / 取消；P2 接入语义重建与英文 Reader；P3 再接入现有翻译 SDK，后续接共享助手和部署验收。P0 文件目录只服务于评测，不作为未来业务数据库。详见 [PDF spec](../../docs/pdf-spec.md) 和 [monorepo 设计](../../docs/monorepo.md)。
