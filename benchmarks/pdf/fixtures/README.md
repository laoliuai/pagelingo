# 自制坐标挑战样本

`crop-rotation.pdf` 是项目自行制作的 4 页 PDF，可随源码分发，不来自用户上传文件或公开论文。每页 MediaBox 为 `[0, 0, 400, 500]`，CropBox 为 `[20, 40, 380, 460]`，旋转分别为 0 / 90 / 180 / 270 度。

正文为三行自制英文，另有红色矩形；矩形在未旋转 PDF user space 的范围为 `[60, 100, 140, 200]`。它用于检查实际 backend 的旋转 / 裁剪处理，属于挑战集，不混入科技论文平均指标。通用坐标单测另用真实 PDFium 渲染的像素位置独立校验四种转换。

```bash
npm run pdf:cli -- parse ../../benchmarks/pdf/fixtures/crop-rotation.pdf \
  --parser docling --output ../../benchmarks/pdf/runs/my-docling-coordinates
npm run pdf:cli -- parse ../../benchmarks/pdf/fixtures/crop-rotation.pdf \
  --parser mineru --output ../../benchmarks/pdf/runs/my-mineru-coordinates
```

识别到一个 bbox 不证明它与原页对齐；必须在 `debug.html` 人工核对。Docling 的非零 CropBox 原点目前明确降级为页级定位。Reader 正式接入前需要根据挑战结果校准 adapter，而不是为了让测试通过删除原始 CropBox 偏移。

2026-10-07 实测：Docling 四页都有内容，但精确 bbox 尚未校准；MinerU basic CPU 对 90 / 270 度页面没有内容块。适配器已加入 `source_text_without_blocks` 诊断，用真实样本再次运行后返回 partial / 非零退出码，并记录原文件物理页 2、4。原始解析器的 success / 页面容器不能证明识别完成，真正空白页不属于该失败。详见 [首轮报告](../first-run-report.md)。
