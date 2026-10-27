# S2 实际阅读截图与校验摘要

全部截图来自 Linux Chromium 的真实 `file://` 正式包，1440×1000 viewport，没有图像编辑或临时 CSS。
`initial-viewport` 是 runtime 自动定位后、用户操作前的实际分栏画面；正文截图通过原界面收起目录、切换正文模式和定位目标片。
原 PDF 的可获取性由本地响应、完整字节 hash、独立原区域像素及站内 PDF.js 回归分别验证；离线分栏截图中的空白 PDF 插件面板不作为原 PDF 栅格质量证明。

正文可读，图注与原图分开保留；提示框颜色、SYSTEM / USER 源角色、符号图、列表与公式可见。
LLM 中段存在明确 LaTeX 排版预算回退提示；RL 首 / 末片保留未生成正文提示和原图 / 版权内容，不推断缺失原文。
所有包标明部分完成 / 模拟译文；未选择块的提示如实显示。R42 把292条等诊断收进原生详情控件，全部内容仍可展开。

## 逐图索引

### llm-foundations（317 页）

- [initial-viewport.png](llm-foundations-initial-viewport.png)
- [chunk-0001.png](llm-foundations-chunk-0001.png)
- [chunk-0003.png](llm-foundations-chunk-0003.png)
- [image-chunk-0005.png](llm-foundations-image-chunk-0005.png)
- [math-chunk-0013.png](llm-foundations-math-chunk-0013.png)
- [chunk-0017.png](llm-foundations-chunk-0017.png)
- [role-chunk-0110.png](llm-foundations-role-chunk-0110.png)
- [chunk-0159.png](llm-foundations-chunk-0159.png)
- [chunk-0317.png](llm-foundations-chunk-0317.png)

### rl-little-book（154 页）

- [initial-viewport.png](rl-little-book-initial-viewport.png)
- [chunk-0001.png](rl-little-book-chunk-0001.png)
- [image-chunk-0001.png](rl-little-book-image-chunk-0001.png)
- [chunk-0004.png](rl-little-book-chunk-0004.png)
- [chunk-0014.png](rl-little-book-chunk-0014.png)
- [math-chunk-0014.png](rl-little-book-math-chunk-0014.png)
- [chunk-0078.png](rl-little-book-chunk-0078.png)
- [chunk-0154.png](rl-little-book-chunk-0154.png)

### attention（15 页）

- [initial-viewport.png](attention-initial-viewport.png)
- [chunk-0001.png](attention-chunk-0001.png)
- [math-chunk-0002.png](attention-math-chunk-0002.png)
- [image-chunk-0003.png](attention-image-chunk-0003.png)
- [chunk-0005.png](attention-chunk-0005.png)
- [chunk-0008.png](attention-chunk-0008.png)
- [chunk-0015.png](attention-chunk-0015.png)

### bert（16 页）

- [initial-viewport.png](bert-initial-viewport.png)
- [chunk-0001.png](bert-chunk-0001.png)
- [chunk-0002.png](bert-chunk-0002.png)
- [image-chunk-0003.png](bert-image-chunk-0003.png)
- [math-chunk-0004.png](bert-math-chunk-0004.png)
- [chunk-0009.png](bert-chunk-0009.png)
- [chunk-0016.png](bert-chunk-0016.png)

## 证据文件

- [范围 / hash / 容量 / 全部 warning / 离线断言](acceptance-summary.json)
- [原 ZIP、来源 schema、原图像素与提示框字符](legacy-package-validation.json)
- [原预览 7 页结构 / Mock / exact restore](legacy-structure-validation.json)
- [四旋转独立像素 oracle](rotation-oracle.json)

语义译文质量未验证。更完整命令、原 P0 / release 的完整路径和执行诊断保留在 ignored Task12 report / logs；PDF 和 ZIP 不提交。

新上下文只执行 goto 的[初始定位诊断](initial-viewport-diagnostic.json)：scrollY=303、headerTop=-303、headerHeight=149。runtime 的 `load(0)` / `paint()` 自动对首块执行 scrollIntoView；此观察进入控制方整分支可用性分级，不在本任务另改行为。
