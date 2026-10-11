# PDF 解析评测：P0 首轮

使用用户提供的两本书，另加固定版本的 Attention、Mamba、BERT 论文。输入、SHA-256、来源、页数和抽样页见 [corpus.json](corpus.json)。大书为 317 / 154 页，抽样与整本结果分开保存。BERT 为双栏正文，另外两篇为单栏对照；书中双栏索引不替代双栏正文测试。

2026-10-07 首轮已完成：每个候选对五份输入完成 538 页全文解析，并保存两本书的 12 页抽样。结论、检查页链接与资源口径见 [首轮报告](first-run-report.md)，可机器读取的运行记录见 [汇总](first-run-summary.json)，人工抽查见 [记录](smoke-observations.json)。MinerU 旋转挑战的漏内容明确记为 partial，见 [自制挑战说明](fixtures/README.md)；它不混入论文质量指标。

安装见 [parser README](../../services/document-parser/README.md)。仓库根目录显式获取公开样本并评测：

```bash
npm run pdf:cli -- fetch-corpus
npm run pdf:cli -- benchmark --parser docling --parser mineru \
  --mode smoke --output ../../benchmarks/pdf/runs/my-smoke --timeout 1800
npm run pdf:cli -- benchmark --parser docling --mode full \
  --sample llm-foundations --sample rl-little-book \
  --output ../../benchmarks/pdf/runs/my-full --timeout 1800
```

`fetch-corpus` 只下载 manifest 中显式列出的 arXiv PDF；用户上传文件缺失时给出路径，不从别处寻找同名版本。下载后校验 hash。评测不隐式下载模型或论文。命令工作目录为 `services/document-parser`；默认 corpus / 模型位置由工具按仓库路径解析。

每次保存 input / 代码 / schema / 依赖锁 hash、请求页集合、原页映射、模型 commit 与权重指纹、实际 backend / OCR / VLM 配置、缓存口径、耗时、进程树 RSS、raw / normalized JSON、定位图和失败日志。候选逐个运行；失败留档后继续其他文件。`complete + sample` 是抽样成功，不能当作全文成功；页缺失或解析器 partial 返回非零退出状态。

`debug.html` 左侧保留内容，右侧原页 / 框选 / 阅读顺序编号，可直接在浏览器打开。原页截图是保留兜底，不算独立公式识别成功。大型 PDF、模型、`runs/` 产物不提交源码仓库；源码保留输入 manifest、锁、说明与人工结论。

检查页不排版行内公式 / 表格，不能作为正式阅读效果的依据。另有 [原文静态预览工具](tools/README.md)，从同一 raw 生成按 PDF 页切换的语义 HTML 与预排版公式，图 / 表直接保留原 PDF 高清区域，完整资源打 ZIP 可离线打开。旧版单页预览留档，新版以有上限的活动 DOM 改善长书阅读，详见工具说明与逐页验证记录。阅读快照与本机处理后导入服务器的方向见 [处理设计](../../docs/pdf-processing.md)；standard / advanced 仍待实测。

本轮为 3–5 份 smoke 与长文资源实测，**不是完整 P0 验收**。20–50 份 corpus、至少 10 份人工 golden IR 及正文留存率 / 相邻阅读顺序正式指标仍需扩展。未标注时质量指标为 `null`；计数、字符长度与页覆盖是诊断，不能把 PDFium 字符比值当作正文完整率。

详细要求见 [pdf-spec.md](../../docs/pdf-spec.md)。
