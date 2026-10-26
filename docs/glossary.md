# 个人词表维护与批量导入

插件和 SDK 0.3.0 起，个人词条参与网页标题、正文及选中内容的实际 API 翻译。词表保存在当前浏览器的扩展设置中；SDK 的匹配和还原规则也可用于将来的 PDF / LaTeX 适配器。

## 用文件维护

1. 在 [CSV](glossaries/common-tech.en-zh.csv) 或 [JSON](glossaries/common-tech.en-zh.json) 中维护词条。分类阅读版见 [Markdown](glossaries/common-tech.en-zh.md)，目前 367 条。
2. 打开插件设置的“个人术语表”，选择“导入词表文件”。也可以展开“从表格粘贴批量导入”。
3. 查看新增、覆盖数量，点击“确认合并词表”。词条立即出现在下方列表，可搜索原词或译文、逐条编辑和删除；每页最多显示 50 条。
4. 选择“术语适用领域”，点击页面底部“保存设置”。下一次翻译使用已保存的词表。已有页面上的译文需要点击“重新翻译”更新。
5. 后续修改文件，再次导入、确认、保存即可。可点击“导出 JSON 词表”备份当前列表。

键为 `source.trim().toLowerCase()` 与 `domain` 的组合。例如同领域的 `token`、` TOKEN ` 是一个键。文件内和历次导入均采用最后一条；手工添加或编辑后也会覆盖同键已有词条。同词不同领域继续共存。

导入是合并：文件未包含的已有词条保留。在文件中删除一行不会删除浏览器中的词条，需要在设置页删除并保存。

## 融合词表

自用融合版提供 [JSON](glossaries/merged-tech.en-zh.json) 与带来源列的
[CSV](glossaries/merged-tech.en-zh.csv)，共 **2,799 条**：保留 PageLingo 的 367 条，
补充 HJFY 的 2,432 条，其中 10 条拼写变体沿用我们的策略，另有 3 条人工校正。
使用支持 5,000 条的插件 0.4.5 或以上版本，重新加载扩展并刷新文章页，再按上述步骤导入；
术语适用领域选择“机器学习 / 大模型 / RL”。文件不会自动加载。

融合时按英文原词忽略大小写匹配，已有原词使用我们的领域和策略，不另加更高优先级的
机器学习版本。空格、连字符等拼写变体显式新增为别名，沿用原词的译法和领域。
HJFY 的其余新增词条限定在 `machine-learning`，原词与译文仅大小写不同的采用 `keep`。
不把 HJFY 的 `case` 列解释为保留英文；当前引擎仍不区分大小写。

`accuracy` 和 `precision` 均保留原文，中文栏分别为“准确率”和“精度 / 查准率”，只作释义。
`mixed precision` 等已有完整词组仍优先按词组处理。修正 `PCA → PAC` 为保留 PCA、释义主成分分析，
并保护 Actor-Critic Algorithm / Method，避免较长词组引入“演员 / 评论员”。
其余词条沿用来源译法，尚未逐条完成语义审校。

导入融合文件时，同键覆盖规则照常适用：若已有 367 条参考词表，无需清空，确认导入即可；
你在浏览器中手工修改过的同键词条也会被融合文件覆盖，建议先导出 JSON 备份。
以后可直接维护融合 CSV，再次导入；若重新运行生成器，手工修改应先同步到参考词表或生成规则。

开发时复现融合结果（原 HJFY CSV 留在本机，不随代码复制）：

```bash
npm run glossary:merge -- --hjfy temp/HJFY-parsed/data/MachineLearningTerminology.csv
npm run glossary:merge -- --hjfy temp/HJFY-parsed/data/MachineLearningTerminology.csv --check
npm run test:glossary
```

[来源清单](glossaries/merged-tech.en-zh.manifest.json) 记录输入 SHA-256、条目分布、校正与输出校验值。
`--check` 仅比对生成结果；日常测试不依赖本机 HJFY 文件，也不访问外部服务。

## 文件格式

JSON 是纯词条数组：

```json
[
  { "source": "harness", "target": "", "policy": "keep", "domain": "machine-learning" },
  { "source": "harness engineering", "target": "harness 工程", "policy": "translate", "domain": "machine-learning" },
  { "source": "RSI", "target": "递归自我改进", "policy": "keep", "domain": "machine-learning" }
]
```

CSV / TSV 有表头，必须包含 `source`、`target`，可额外包含 `policy`、`domain`。`topic`、`notes` 等其他列作为维护资料保留在文件中，导入时忽略。支持 UTF-8 BOM、CSV 引号、引号内逗号及换行。

```csv
source,target,policy,domain
harness,,keep,machine-learning
harness engineering,harness 工程,translate,machine-learning
RSI,递归自我改进,keep,machine-learning
```

CSV / TSV 省略策略时，有译文默认 `translate`，无译文默认 `keep`；省略领域默认 `all`。JSON 必须提供四个字段。最多 5,000 个不同键、8 MiB；不合法文件整体拒绝，不修改已有词条。固定译文必须非空；引擎保留的 `⟦`、`⟧` 分隔符不能出现在原词及固定输出中。

## 生效范围与策略

默认适用领域为机器学习 / 大模型 / RL，可切换为软件工程、物理、一般科技或通用。所选领域及 `all` 词条生效；同一原词优先采用所选领域。选择“通用”时只启用 `all` 词条。

- `keep`：原词保留英文及原有大小写；`target` 仅作释义。
- `translate`：使用固定译文。
- `first-bilingual`：统一输出“中文（原词）”，不依赖全文首次出现位置。
- `prefer-source`：提供优先英文的语境偏好，由模型结合上下文判断。

匹配忽略大小写，检查词边界，采用能够完整匹配的最长词组。当前词组匹配限于连续自然文本，不跨强调/链接的格式边界、代码或公式。已识别的代码、公式和其他保护对象不参与术语替换。保留英文、固定译文和双语术语由 SDK 槽位保护并在本地还原，缺失或重复槽位的结果不用于渲染。

一次任务固定词表快照。更新词条后再次翻译，命中的相关块缓存失效；未依赖该词条的块继续复用缓存。0.3.0 调整了提示词版本，首次升级后的旧版缓存会重新计算。

## SDK 使用

```ts
import { parseGlossaryFile, mergeGlossaryEntries } from '@pagelingo/translation-core';

const glossary = mergeGlossaryEntries(existingEntries, parseGlossaryFile(fileText, 'csv'));
for await (const batch of engine.translate(document, {
  targetLanguage: 'zh-CN', glossary, glossaryDomain: 'machine-learning',
})) {
  // Existing document adapters consume batch.translations as before.
}
```

SDK 不读取文件或浏览器设置，调用方传入文本和词条即可。解析、合并、匹配、保护及相关缓存依赖由同一个 SDK 管理。

本文覆盖个人词表维护。自动领域识别、内置词表自动加载、文档上下文分析、动态词表与人工质量评测仍待继续。
