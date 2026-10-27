# 最终修复的实际证据

对应 I1 / I2 / I3 / M1；当前 renderer code SHA-256：
`3bfbbf4ce02a787185643792d617f80cb960261d108ad0ce224b0909ea4d47c3`。
所有新包从 Task12 已验证的 ready run / 译文快照导出；未重新推理或改善 parser。

- [当前包身份、全部离线遍历结果与初始几何](acceptance-summary.json)
- [站点390×844两主题正文/段落实测](site-geometry.json)
- [本轮检查结果与沿用范围](verification.json)
- [证据文件SHA-256](evidence-sha256.json)
- [完整验证范围与沿用旧证据说明](../../../../../learning-site-s2-validation.md)

站点图使用真实 API 导入 fixture；文件名含 entry / restore / conflict 的移动截图为390×844 viewport，
没有外层滚动或临时 CSS。warnings 截图保留303条中的可见段，列表本身在20vh内滚动，全部字符串有断言。
桌面 reader 截图来自同轮56用例通过的真实 PDF.js 画布验证。

离线图来自四个当前包的实际 file:// 入口（1440×1000，断网）。initial 图在用户导航之前捕获；
其余图按界面操作切换正文、只滚动正文窗格。标题、partial/mock、警告入口、视图与原件下载保持可见。
初始分栏左侧 headless PDF 插件空白不构成原件栅格验证；原PDF本地响应/hash和站点PDF.js/原区域像素证据分开记录。
模拟 echo 译文不代表中文语义质量，所有原有源内容回退/公式预算/未选择提示继续保留。

已目视检查：站点移动 entry / restore / conflict两主题、warnings；四包 initial；LLM中段0159、提示0017、
角色0110与RL中段0078。正文、源图、图注、提示颜色、SYSTEM/USER、公式和源内容提示可辨。
其余截图随全量分片/资源断言生成，未逐张另作质量评分。

## N1 警告继承属性修正

初始警告解释表的原型继承查找曾使合法 `__proto__:block` 导致渲染失败。后续使用自有属性检查，
`__proto__`、`constructor`、`toString` 与其他未知代码只显示原始消息。扩展后的307条真实API
警告用例及账号隔离2/2通过；直接组件5种代码渲染与web构建/typecheck通过。
新 [307条警告实际截图](s2-n1-mobile-warnings.png) 已目视检查：展开后计数、普通未知消息与继承名称
保持字面文本，正文仍可见；旧303条截图保留为前轮证据。renderer26个输入hash不变，四包 / Docker
及其他未改动通过项沿用。此修正不声称重复了此前56用例或其他全量套件。

## 截图索引

- [attention-chunk-0001.png](attention-chunk-0001.png)
- [attention-chunk-0005.png](attention-chunk-0005.png)
- [attention-chunk-0008.png](attention-chunk-0008.png)
- [attention-chunk-0015.png](attention-chunk-0015.png)
- [attention-image-chunk-0003.png](attention-image-chunk-0003.png)
- [attention-initial-viewport.png](attention-initial-viewport.png)
- [attention-math-chunk-0002.png](attention-math-chunk-0002.png)
- [bert-chunk-0001.png](bert-chunk-0001.png)
- [bert-chunk-0002.png](bert-chunk-0002.png)
- [bert-chunk-0009.png](bert-chunk-0009.png)
- [bert-chunk-0016.png](bert-chunk-0016.png)
- [bert-image-chunk-0003.png](bert-image-chunk-0003.png)
- [bert-initial-viewport.png](bert-initial-viewport.png)
- [bert-math-chunk-0004.png](bert-math-chunk-0004.png)
- [llm-foundations-chunk-0001.png](llm-foundations-chunk-0001.png)
- [llm-foundations-chunk-0003.png](llm-foundations-chunk-0003.png)
- [llm-foundations-chunk-0017.png](llm-foundations-chunk-0017.png)
- [llm-foundations-chunk-0159.png](llm-foundations-chunk-0159.png)
- [llm-foundations-chunk-0317.png](llm-foundations-chunk-0317.png)
- [llm-foundations-image-chunk-0005.png](llm-foundations-image-chunk-0005.png)
- [llm-foundations-initial-viewport.png](llm-foundations-initial-viewport.png)
- [llm-foundations-math-chunk-0013.png](llm-foundations-math-chunk-0013.png)
- [llm-foundations-role-chunk-0110.png](llm-foundations-role-chunk-0110.png)
- [rl-little-book-chunk-0001.png](rl-little-book-chunk-0001.png)
- [rl-little-book-chunk-0004.png](rl-little-book-chunk-0004.png)
- [rl-little-book-chunk-0014.png](rl-little-book-chunk-0014.png)
- [rl-little-book-chunk-0078.png](rl-little-book-chunk-0078.png)
- [rl-little-book-chunk-0154.png](rl-little-book-chunk-0154.png)
- [rl-little-book-image-chunk-0001.png](rl-little-book-image-chunk-0001.png)
- [rl-little-book-initial-viewport.png](rl-little-book-initial-viewport.png)
- [rl-little-book-math-chunk-0014.png](rl-little-book-math-chunk-0014.png)
- [s2-final-mobile-conflict-dark.png](s2-final-mobile-conflict-dark.png)
- [s2-final-mobile-conflict-light.png](s2-final-mobile-conflict-light.png)
- [s2-final-mobile-entry-dark.png](s2-final-mobile-entry-dark.png)
- [s2-final-mobile-entry-light.png](s2-final-mobile-entry-light.png)
- [s2-final-mobile-restore-dark.png](s2-final-mobile-restore-dark.png)
- [s2-final-mobile-restore-light.png](s2-final-mobile-restore-light.png)
- [s2-final-mobile-warnings.png](s2-final-mobile-warnings.png)
- [s2-reader-desktop-dark.png](s2-reader-desktop-dark.png)
- [s2-reader-desktop-light.png](s2-reader-desktop-light.png)
