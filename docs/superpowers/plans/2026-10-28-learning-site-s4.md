# Learning Site S4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让个人资料库具备可长期使用的分类、搜索、删除恢复、GitHub/arXiv 收藏和私有下载导出流程。

**Architecture:** 沿用模块化 TypeScript API、PostgreSQL、私有 ObjectStore 与现有独立 worker。先建立资料管理和生命周期边界，再在原有任务队列中加入来源适配与网页导出；PDF 继续本机处理，网页继续复用共享清洗、SDK 和 renderer。三个交付段共享文档生命周期，按顺序验收，不另建平行账号、存储或任务系统。

**Tech Stack:** Node.js 24+、TypeScript ESM、Fastify 5.12.7、PostgreSQL、React/Vite、Zod 4.6.7、translation-core 0.4.0。沿用锁定依赖；Atom 使用已在 lockfile 中的 `saxes@6.0.0`，提升为 document-service 的直接依赖，不顺带升级依赖树。

**Spec:** [已批准的个人学习站 V1 设计](../specs/2026-10-26-personal-learning-site-design.md)，重点 §4.1–4.2、§5.1–5.3、§6.4、§8–12、S4，以及 A02/A06/A10–A14/A16。S3 基线为 `b8ca85dd6d202a456fb1047d834d9c856632b988`；[S3 已知后续项](../../learning-site-s3-validation.md)中的 N1、M5、M6 纳入相关任务。

## Global Constraints

- 各用户保存自己的数据，首版不共享。所有 owner 从会话/设备取得；管理员读取资料仍按自己的 owner，跨 owner 的集合、标签、关系、包、任务与资产引用都拒绝。
- 会话写入继续使用requireSession/requireWriteRequest的Origin/CSRF校验；设备只能调用已声明scope入口，不以Bearer失败回退Cookie。UUID用于哈希时以已授权存储行规范身份为准，parseId/Git ref保持原始大小写。
- 一个文档首版允许放入一个集合、添加多个标签和一段收藏备注。阅读状态与保存、翻译、阅读位置分别记录。
- 删除先进入回收站，默认保留 **30 天**，可手工恢复或永久删除。删除撤销读取入口并取消未完成任务；迟到结果不能重新发布资料。恢复时验证相关对象仍存在。
- 普通阅读、语言判断、上传、导出和打开旧译文不调用模型。配置保存不扫描历史资料。GitHub README 只在现有偏好与本次保存意图允许时排翻译；arXiv 下载不启动服务器 PDF 推理。
- 本机处理 PDF、服务器保存与阅读。原件、raw、source IR、已完成译文和来源版本不可原地覆盖；资料标题/备注属于可变资料头，不回写历史产物。
- 只新增迁移 `007-library-management.sql`、`008-source-adapters.sql`、`009-web-exports.sql`，**不得修改已合入的 001–006**。保留 document kind 不可变规则；不得把现有 paper/repository 改成 pdf/article。
- 升级测试/部署交接先停旧API/worker写进程，再迁移并启动匹配版本；兼容旧数据/包不代表允许旧二进制穿越迁移继续写。实际运行环境的停止/部署属于S5，不在开发验收中操作个人服务。
- 保留旧 `pagelingo-document-bundle/1` PDF 包、SDK 语义、P0 及 S2 原始 ZIP。新网页离线包独立分型，不能用伪 PDF 页码、假 parse 或模型运行字段凑旧合同。
- 全部出站请求继续校验协议、DNS、实际连接、每跳重定向、超时与字节上限。GitHub/arXiv 只取公开资源，不上传 Cookie、Authorization 或用户模型 Key，不递归抓仓库/外链。
- 当前 API/worker 独立进程、全局 **2** 槽/owner **1** 槽、30 秒租约、5 秒心跳继续有效。锁序统一为 owner → 按 UUID 排序的 document → slot → job → 对象发布锁；不在数据库事务内做网络、SDK、压缩或大对象校验。
- Web 原始 HTML/CSS 只作附件；可信预览保持不执行源脚本、表单、原始 CSS 或未授权网络。来源范围和资源缺失继续如实显示。
- 原有采集上限保持：HTML 8 MiB、资源 16 MiB、总计 64 MiB、文件 256、origin 16、草稿与 IPC JSON 16 MiB、20,000 blocks；不为修复 N1 提高上限。
- 默认 npm 检查不安装 Python/模型、不调用真实 LLM、不读取用户 `.env`/Key/生产数据库。测试只操作本次拥有的临时数据库、目录、进程；日志和真实失败证据保留。
- 延续暖灰阅读区、灰色界面、少量青绿强调、明暗主题及桌面优先布局。手机保证筛选、阅读、恢复/下载基本操作，不另建移动采集 App。

## Review Focus

1. 删除→恢复发生在旧 worker、PDF 上传、插件投递或导出中途：旧操作不能因条目重新变为 active 而发布。任务3/4/13固定回归，包含未指定目标的晚到上传。
2. 同一 owner 多次收藏改名仓库、移动分支、无版本 arXiv 或同字节不同论文版本：身份、当前原件和旧译文不混用。任务7–10固定回归。
3. 所有者切换、跨 owner 标签/集合/关系、搜索 `%_\\`、中文名称及多标签组合：数据不泄漏、分页总数一致、旧响应不恢复界面。任务2/6/10固定回归。
4. 原站不可达、README 无图片/无正文、部分译文、超大长文及导出包恶意路径/脚本：保存范围诚实、离线材料可读、读取/导出零模型请求。任务8/11–13固定回归。
5. 极长 URL 与临界 CSS 草稿、旧 IndexedDB、断网重试和服务端确认丢失：预算在完整消息上成立，未确认字节不被清掉。任务5固定真实边界回归。

## 1. 范围、交付顺序与实现方选择

交付段依次为：**A 资料组织/生命周期（0–6）→ B 来源适配（7–10）→ C 下载导出/整体回归（11–14）**。每段能独立验收；先完成共享删除围栏，后续新增资产和任务必须接入同一边界。任务数量不作为跳过中间验证的理由。

以下是实现方根据既有设计作出的具体选择，供本计划审阅，不追记为用户最初要求：

| 事项 | 本计划的决定 |
| --- | --- |
| 组织字段 | 名称先NFKC/trim后校验1–80 UTF-16字符，小写得到唯一key，保留展示大小写；新增标题编辑1–500，旧标题读取不强加新上限；纯文本备注≤10,000；每文档≤32标签。PATCH只提交改动字段。 |
| 阅读状态 | 新资料 `unread`；用户显式设 `reading/read`；普通 GET、被动恢复不改状态或进度，标记已读不跳转阅读位置。 |
| 查询 | 默认20/页、最多100，page为1–1,000,000；q≤200，literal ILIKE，搜索标题/作者/URL/域名/集合/标签；类型、来源、阅读状态、一个集合与最多16个标签（AND）组合。不做正文全文或语义搜索。 |
| 回收站重复收藏 | 同 owner 命中回收站资料返回409 `DOCUMENT_IN_TRASH`，提示恢复，不自动复活。永久清理后新操作可创建新 ID；旧操作幂等键及入站时间围栏仍拒绝重放。 |
| 真实来源 | GitHub 先支持 github.com 公开 repo；根 repo 与非根文档子页分开。arXiv 先保存固定版本元信息/PDF，不在服务器解析论文。失败保留链接和已确认元信息。 |
| 网页离线包 | 新 `pagelingo-web-document-bundle/1`，包含已保存材料及完整离线 Reader；S4提供导出/校验，不增加站点 Web ZIP 重新导入入口。PDF 包导入继续支持论文目标。 |
| S3 后续 | 本阶段修复N1、完成已确认 outbox 载荷整理M6、在来源提取中补M5。M2本地通用样本预检、M3工具升级、M4无关格式整理留待集中维护，不隐瞒为已完成。 |

## 2. 共享接口与持久化合同

### 2.1 管理 API（任务1/2/3/4）

保留既有 `DocumentSummary` 的 PDF/article/x-post payload 字段与 source 身份；组织字段单独返回，避免把可变收藏信息写入 Reader。扩展 summary 的新 repository Web / paper PDF 变体由任务1定义、任务8/9启用。

- `DocumentOrganization = {documentId,revision,lifecycleEpoch,title,collectionId:UUID|null,tagIds:UUID[],note,readingStatus:'unread'|'reading'|'read',updatedAt}`；`lifecycleEpoch`为服务端提供的正safe integer、初始1，供trash/restore的expectedEpoch使用，与metadata revision独立，不接受客户端PATCH修改。
- Portable JSON Schema负责结构/shape校验；`uniqueItems`拒绝完全相同的tag字符串，共享runtime额外按UUID身份（忽略大小写且保留原编码）拒绝逻辑重复，并继续执行身份/跨字段语义校验。
- `PatchDocumentOrganization = {expectedRevision,...非空的title/collectionId/tagIds/note/readingStatus子集}`；409 `METADATA_CONFLICT` 后读取现值，不自动覆盖。删除状态不能由 PATCH 修改。
- `GET/PATCH /api/v1/documents/:id/organization`；`GET /api/v1/library` 返回 `{items:[{document:DocumentSummary,organization:DocumentOrganization,origin:DocumentOrigin}],total,page,pageSize}`。原 documents 列表保留，统一排除回收站；筛选参数使用2.1的上限。
- `LibraryQuery` 的wire字段为page/pageSize/q/kind/origin/readingStatus/collectionId/tagIds；collectionId允许UUID或`none`（未分类），tagIds用重复查询参数，单值string/多值array进入有界normalize，不接受逗号拼接。collection/tag引用都须本人；同一请求的count/items用短的consistent DB snapshot，不在逐行ObjectStore查询中拼接状态。
- `DocumentKind = 'pdf'|'article'|'x-post'|'repository'|'paper'`；`DocumentOrigin = 'upload'|'web'|'x'|'zhihu'|'wechat'|'github'|'arxiv'`，从已验证的来源类型/URL推导，旧记录保守回填；不可由客户端伪装成可信适配成果。
- `GET/POST /api/v1/collections`、`GET/PATCH/DELETE /api/v1/collections/:id`，tags同形。列表 `{items,nextCursor}`，默认50/最多100，q≤80，游标UUID；名称重名409。删除集合/标签只解除组织关系，保留文档。
- `POST/DELETE /api/v1/document-relations` 输入 `{fromDocumentId,toDocumentId,kind:'discovered-from'|'related'}`；两个资料都须 active/同 owner，拒绝自关联，重复添加幂等。`GET /documents/:id/relations?cursor&limit` 最多50；关系不触发递归采集。related用于用户明确关联已有资料，不假称自动验证过发现来源。
- `POST /documents/:id/trash {expectedEpoch}`、`POST /documents/:id/restore {expectedEpoch}`；`GET /api/v1/trash` 只返回本人元信息、删除时间、purgeAfter、epoch，不返回可读取的资产。`DELETE /api/v1/trash/:id` 返回202的清理收据；真实完成前显示处理中。
- `assertDocumentActive(client,ownerId,documentId,expectedEpoch?):Promise<{epoch:number,kind:DocumentKind}>`；所有普通入口与异步最终提交复用。不存在、别人的、回收站资料的普通读取统一404；清理后的旧操作返回410 `DOCUMENT_PURGED`。

### 2.2 数据与生命周期（007）

- `document_organization` 一行/文档，owner/document复合外键、revision；collection复合外键，`document_tags` 与 `document_relations` 同 owner复合外键/唯一约束。迁移回填，创建资料同事务写初始组织行，GET不补写。
- documents新增 `origin,title_origin,lifecycle_epoch,deleted_at,purge_after`。`title_origin` 为 `user|url|filename|source|legacy`；旧行用legacy，来源补全仅更新url/filename/source，不覆盖user/legacy。源元信息与用户编辑分离。
- `document_search_metadata`保存当前源的有界作者/来源URL/域名等派生字段，源UUID/parse/hash绑定；发布时同步投影。旧材料由 `runMetadataBackfill({db,store,signal},{limit:20})` 在事务外读取已保存材料并CAS投影，缺少作者就留空，不推断或调用模型。查询只读SQL，不在每次搜索中读取IR文件。
- jobs/imports/有目标captures保存服务端取得的不可变 `document_epoch`。它是独立授权围栏，不改变旧语义/SDK缓存哈希；自动任务去重和唯一键增加epoch，R29 requestId的已接受请求重放仍是只读确认，不能重新排队/提升指针。
- soft delete与restore都递增epoch。删除取消排队/在途任务并使slot/lease失效；恢复不重启旧任务。缓存get/put、付费请求前、checkpoint、source/Reader发布都检查当前epoch，防止delete/restore ABA。
- canonical与最小alias属于同一逻辑资料：同一删除/恢复事务锁住该组、分别递增每行epoch；普通alias读取也校验canonical是否active。冲突条目和普通related关系不是alias，不随之删除。
- 未指定目标的 PDF/capture，在最终去重时也检查回收站及 `retired_document_identities`（owner + URL/源SHA的摘要 + 删除截止时间）。每次删除都记录截止点，恢复不擦掉它；已入站旧操作不能在恢复或永久清理后新建替身，比较数据库原始timestamp，不经JS毫秒截断。永久清理后首次入站的全新幂等键是新操作，可建立新ID；服务器不能远程清除从未送达的设备本地副本。
- 永久清理先撤销入口、持久化幂等键摘要/身份摘要tombstone和待删除object keys，再按FK依赖分批清理业务行与文件；每次最多500行/100对象。保留最小非内容收据，清掉manifest、源元信息、暂存材料、checkpoint及相应缓存，不保留原文载荷。
- retirement比较服务端入站账本时间，不相信capturedAt。UUID操作键先规范化，旧PDF不透明ASCII键保持大小写；两者再分别求摘要，避免重放绕过或误合并。
- 新增缓存文档引用；新cache get/put记录归属，最后一个引用消失才清理共享结果。旧的无法归属的本 owner cache在首次永久清理时保守清除，代价是未来新翻译可能少缓存命中，不能因此主动请求模型或删除其他Reader。
- `runDocumentMaintenance(deps,{limit:100}):Promise<MaintenanceResult>` 被worker及清理CLI复用，worker每进程最多一个maintenance promise、最多每5秒发起一次，不在200ms循环重复全量扫描；多进程用DB领取有界批次。失败持久退避1秒至60秒，稳定游标公平遍历；只删本次记录且仍无引用的key，沿用对象发布锁。新008/009表必须注册到同一purge依赖图。

- 009为临时导出增加 `registered_object_work`，同一 `object_deletion_queue` 的task_id/work_id恰好一个非空，原永久清理收据保留。临时工作记录不可变writer job/epoch/slot/lease与有界等待，排除有效写入；完成输出延至过期，目录只枚举固定层级和条目，原件与临时工作共用500项业务行变更/100次物理对象删除尝试预算。永久清理等待相关临时工作实际结束；可失效ZIP不加入原件恢复引用图。

### 2.3 来源与阅读（任务7–10，008）

- `SourceDetails` 以kind=`link|github|arxiv`判别，公共字段为documentId、url、`resolution:self|alias|conflict`、canonicalDocumentId（可空）、fetchJobId（可空）、状态 `link-only|metadata-saved|source-saved|partial-resources|fetch-failed`、errorCode（可空）、warnings和latestAttempt。link无current；github/arxiv的current为下述对应修订或null。`GET /documents/:id/source-details` 纯读。
- `SourceAssetInfo={assetId,sha256,bytes,mediaType,filename}`，不含object key/owner。`GithubSourceRevision={kind:'github',id,sourceVersionId:UUID|null,repository:{id:string,owner,name,description:string|null,url},commitSha:string|null,readme:{path,blobSha,raw:SourceAssetInfo,renderedHtml:SourceAssetInfo|null}|null,capturedAt}`；`ArxivSourceRevision={kind:'arxiv',id,baseId,version,title,authors:string[],summary,publishedAt,updatedAt,capturedAt,sourceVersionId:UUID|null,pdf:SourceAssetInfo|null}`。无可读投影时可保留raw附件，须明确预览不可用，不造空Reader。
- 当前详情绑定选中的来源/Reader，最新请求另列 `latestAttempt:{jobId,status,requestedRef,resolvedRevision,errorCode}|null`，不能把失败的新版本元信息拼到仍可读的旧原件上。`GET /documents/:id/source-versions` 默认20/max50、UUID游标，返回独立来源修订id；`source-details?revisionId=UUID` 查看该修订；可附 `readerVersionId=UUID`，先校验Reader属于本人及该资料，再解析其真实来源。两个参数同时提供时须验证配对；paper只使用显式论文绑定，GitHub使用实际capture/fetch/translation关联，只有唯一候选时允许source-only回退。歧义返回current=null及有界警告，不能靠显式revision绕过歧义回退；真实多候选映射可由用户显式选择。未登记配对、其他资料或他人Reader返回404。该GET始终纯读。同字节论文的修订id不同，即便sourceVersion相同；游标边界在SQL按原行比较。
- source-versions响应为 `{items:(GithubSourceRevision|ArxivSourceRevision)[],nextCursor:UUID|null}`。`GET /documents/:id/source-assets/:assetId` 只下载已登记且已验证的本资料来源材料，强制attachment/nosniff/no-store；PDF inline/Range仍使用原件路由，不把此入口变成任意asset/object-key代理。
- GitHub身份为稳定数字repository id；每次保存记录 owner/name、原URL、canonical repo URL、采集时间、完整40位commit SHA、README path/blob SHA、实际raw/HTML SHA256。arXiv身份为base id；`arxiv_versions`分别保存每个固定version的题目/作者/摘要/时间、实际PDF SHA/bytes与sourceVersion。不同字节用不同源；同一论文内字节完全相同可共享既有不可变PDF源，以 `paper_reader_bindings` 保留各版本与Reader的验证关联，不能只靠sourceVersion猜论文版本。
- `github_versions`是不可变修订，允许元信息已存但README/源为空；相同实际metadata/raw/HTML/config摘要可复用修订。`arxiv_versions`在首次确认元信息时固定版本/元信息，可将尚为空的PDF绑定填入一次；一旦绑定，后续同版本不同PDF必须报SOURCE_VERSION_CONFLICT，不能覆盖。当前原件/Reader只在材料验证后切换；元信息先到的状态通过latestAttempt独立展示。
- 并发首次保存GitHub旧/新名称可能先产生两个链接记录。数字ID解析冲突时，未被用户编辑/附加材料的临时条目仅变成同owner alias，默认库只显示canonical；原job/请求身份不换绑，也不把材料写到另一document。用户在canonical条目显式更新才能取得新快照。有用户编辑或材料则保留冲突条目并提示已有资料，不能静默合并丢数据。alias无链/环，清理canonical时包含其最小alias记录；普通关系不这样级联。
- `POST /documents/:id/source-refresh` 使用UUID Idempotency-Key和 `{ref?:string,translationIntent:'auto'|'none'}`。ref表示GitHub ref或arXiv带版本ID，由类型严格区分；同key同输入返回原任务，改输入409；新主动操作新key，不用配置变化触发。
- 仍用 `web_jobs.kind='fetch-link'`，source请求账本和immutable acquisitions记录实际材料。paper只允许fetch；repository允许fetch/translate。不另建一套排队/租约。`runSourceFetchJob(lease:JobLease,deps:SourceFetchDependencies):Promise<void>` 从现有fetch dispatcher调用。
- `SourceFetchDependencies = {db:Database,store:ObjectStore,config:RuntimeConfig,signal:AbortSignal,sourceTransport?:SourceTransport}`；production禁止传入替代transport，test的新来源用例须显式注入。`SourceReference` 是 `{provider:'github',owner,repo,requestedRef?:string,url}` 或 `{provider:'arxiv',baseId,version:number|null,url}`。
- `SourceTransport.readSmall(url,{accept,maxBytes,signal}):Promise<Response>` 返回有界实际响应；`downloadPdf<T>(url,{maxBytes,signal},consume:(body:AsyncIterable<Uint8Array>,response:{status,url,headers})=>Promise<T>):Promise<T>` 在callback结束后关闭资源。仓库/commit/Atom响应1MiB，含base64的README descriptor响应2MiB，实际raw README1MiB、HTML8MiB；repo材料总量64MiB。arXiv的PDF遵守maxPdfBytes（默认256MiB），另加≤1MiB元信息；流式写入，120秒总限/20秒首字节及idle，不缓存整份PDF到Buffer。
- arXiv请求使用专属PG session advisory锁 `(204716,40)`，不持有SQL事务；整个响应完成/失败清理后至少3秒才发下一次请求。未获许可时任务持久next_request_at并释放slot，不占连接睡眠；跨两个worker保持单连接，尊重更长Retry-After。
- `PaperPdfDocumentSummary` 保持PDF summary的source/reader字段，但kind为paper并附url；paper未下载时仍是link变体。`isPdfReadableDocument(value)` 是共享type guard；路由、Reader、进度、原件及导入按实际能力分派，不靠URL扩展名。
- PDF导入增加可选 `targetSourceVersionId`（须有targetDocumentId）及 `targetPaperVersion`（paper目标必填），仅在提供时进入请求身份；验证论文版本→源ID→实际PDF SHA/bytes。旧包/旧请求身份保持，已导入另一目标的package不能换绑，可由用户关联已有条目；旧版本原件可按已登记asset读取。导入非当前论文版本只登记其绑定，不提升当前指针；同字节的跨版本复用也必须记录版本关联。

### 2.4 导出（任务11–13，009）

- PDF沿用既有 `GET /api/v1/documents/:id/readers/:versionId/bundle` 返回原ZIP，字节不重建；原PDF用 `GET /api/v1/documents/:id/source?download=true`。当前和历史版本的实际source asset都必须能按所属版本下载。
- `POST /documents/:id/web-exports` 输入 `{readerVersionId}`，UUID Idempotency-Key；`GET /documents/:id/web-exports/:exportId` 返回状态；`GET .../:exportId/file` 为私有附件。GET不创建任务。
- `WebExport = {id,packageId,documentId,readerVersionId,status:'queued'|'running'|'completed'|'failed'|'cancelled'|'expired',bytes:number|null,sha256:string|null,expiresAt:string|null,errorCode:string|null}`。packageId与展示标题在接受一次导出操作时固定；新导出可产生新包，不把同Reader的可变资料标题混入同一包身份。
- 已完成附件读取按当前会话、账号与active本人资料及期限授权，不与产物创建时auth版本/epoch比较；创建时授权只约束入站与异步发布。旧会话、回收站和过期文件仍被拒绝。
- 新增现有队列kind `export-web`，不可变输入固定source/parse/Reader/catalog/epoch；profile/glossary/requestId为空，唯一请求账本在web_exports。沿用全局2/owner1 slot，不解密Key、不进入翻译finalizer、不改current Reader。文件有效24小时，过期同key只返回旧收据，新生成需新key。
- `createWebStaticFilePlan(input:WebStaticPlanInput):WebStaticFilePlan`，input为 `{ir:WebReaderIR,translation:WebTranslation|null,index:WebReaderIndex,chunks:readonly WebReaderChunk[],capture:WebCaptureManifest,assets:readonly WebOfflineAsset[],previews?:readonly WebOfflinePreview[],previewImages?:readonly WebOfflinePreviewImage[]}`；`WebOfflinePreview={fileId:string,html:string}` 为严格UTF-8解码的实际归档预览；`WebOfflinePreviewImage={fileId:string,data:Uint8Array}` 为实际登记raster图片。生成器重验role/bytes/hash及既有预算，opaque file sandbox预览使用派生data:image和可信内联样式；缺少输入明确不可用，不以IR冒充快照，不放宽浏览器安全设置。`WebOfflineAsset={id,path,mediaType,bytes,sha256}` 的path是已验证包内路径，不伪装成安装包TrustedAsset。返回WebStaticFilePlan复用StaticFilePlan形状：rendererVersion/rendererSha256、仅运行时/字体的trustedAssets、惰性generatedFiles。`validateWebBundle(input:BundleFileSource,options:BundleOptions):Promise<ValidatedWebBundle>`、`writeWebBundle(input:BundleFileSource,destination:string,options:BundleOptions):Promise<BundleIdentity>` 复用安全路径/ZIP流式机制，独立验证Web合同。
- Web包保留原capture manifest/文件、IR、真实可空译文、可信完整离线Reader和来源/缺失说明。新manifest固定 `pagelingo-web-document-bundle/1`，带packageId、source/IR/translation/runtime实际hash及完整files；不伪造PDF字段或模型记录。原始HTML/CSS惰性保存。
- `WebDocumentBundleManifest = {schemaVersion,packageId,createdAt,title,source:{manifestPath:'source/manifest.json',manifestSha256,snapshotSha256,contentFingerprint},parse:{id,readerIrSha256},translation:{path:'translation.json',sha256,status,generationKind}|null,renderer:{version,codeSha256},files:BundleFile[]}`。固定入口 `render/index.html`、IR `source-ir.json`，原件放source/下并保留原capture内部相对路径；Reader数据/预览/资源只引用已登记包内路径。title是本次导出的资料头快照，不重写原IR标题。
- 首个Web包格式支持可重现的 `web-projector/1` / `defaultCaptureLimits` 投影；未存实际参数的历史收紧配置或未知projector明确返回 `BUNDLE_UNSUPPORTED_SOURCE`，不从hash猜配置、不重写原parse身份。站点导出显示终止错误，原资料继续保留；不声称任意历史自定义配置均可导出。
- 沿用defaultBundleLimits：ZIP256MiB、展开1GiB、manifest2MiB、IR/译文各32MiB、provenance单件128MiB、其他单件64MiB及readerContractCeilings。配置只读复用，不提高旧预算；每个流重新计数/hash、原子不覆盖输出。
- Web源manifest/IR仍受原16MiB限制，不能用bundle的32MiB替代原Web ceiling。相同已保存图片可由多个本地ID引用同一登记路径，不用重复字节或符号链接凑闭包。

## 3. 文件职责

新增合同位于 `packages/document-contracts/src/{library-management,source-details,web-bundle,web-exports}.ts`，统一导出并用现有generator生成portable schemas。服务端按功能放 `document-management/`（organization/taxonomy/query/relations）、`document-lifecycle/`（guards/trash/restore/purge/maintenance）、`source-adapters/`（identity/network/rate-limit/receipts/github/arxiv）、`web-exports/`；不把新增流程塞入app.ts。

前端继续用现有library/document/Reader页面，新增管理控件、回收站、来源与导出面板；组织、来源、Reader query keys分开并带owner/auth epoch。扩展的消息预算与outbox payload分仓独立于后台来源适配。新增单元/DB/Playwright测试随所属模块；复用 `tests/helpers/{app,session,web-capture,readers,worker-process,pinned-wire}.ts`，不模拟掉要验收的数据库/跨进程边界。

## 4. 实施任务

### Task 0: 冻结 S3 Reader 兼容基线

**Files:** 新建 `packages/document-renderer/compat/s3-0.2.0/`、`src/compat/s3-0.2.0/catalog.ts`、`packages/document-bundle/tests/fixtures/s3-final/`；修改renderer的 `src/catalog-registry.ts`、`src/static.ts`、`scripts/generate-static-catalog.mjs`、`packages/document-bundle/src/static-assets.ts`、`tests/bundle-validation.test.ts`、`apps/document-service/Dockerfile`、相关package.json/lockfile。
**Interfaces:** 保留当前renderer0.2.0 SHA `f856f4104ebcf8a90528faeb2f5bafc01dc3745468b6f53253ad0e420bcb8a73` 的实际目录与许可；保留现有s2-0.1.0。后续当前renderer新版本独立登记，不能以相同版本/新hash顶掉已发布目录。
- [x] **Step 1:** 在改源码前用现有自有synthetic PDF/IR生成一次S3固定包并记录字节hash，同时留存当时catalog/runtime/许可证；新增测试 `retains S2 and S3 packages after current renderer evolves`，断言旧包校验成功、源/分片/资源相同、未知catalog仍拒绝。
- [x] **Step 2:** 将当前renderer版本切到尚未发布的0.3.0并同步workspace精确引用，暂不登记S3 compat；运行 `npm run build:renderer` 及 `npm run test --workspace @pagelingo/document-bundle -- tests/bundle-validation.test.ts`，确认旧0.2包因缺少兼容目录失败，保留RED。
- [x] **Step 3:** 用Step1留存的实际目录/许可证登记S3 compat，不从改过的源码反算旧hash。原始5份S2 ZIP只读，不改旧schemas/P0；自有fixture使用明确测试目录，不能强制加入运行日志/个人材料。
- [x] **Step 4:** 运行上述测试及现有 `check-s2-compat.mjs` 的固定/原始包声明用法；实际输入前后SHA一致，S3固定包在登记后通过。
- [x] **Step 5:** 自检并提交 `chore: preserve S3 reader bundle compatibility`。

### Task 1: 严格管理、来源与查询合同

**Files:** 新建 `packages/document-contracts/src/{library-management,source-details}.ts` 和 `tests/{library-management,source-details}.test.ts`；修改同包 `src/{documents,web-api,index}.ts`、`scripts/generate-reader-schemas.mjs`、schemas、workspace package.json/lockfile，以及现有Web端summary通用分派处。
**Interfaces:** 实现2.1/2.3的DTO与 `documentKindSchema`、`documentOrganizationSchema`、`patchDocumentOrganizationSchema`、`libraryQuerySchema`、`libraryPageSchema`、`sourceDetailsSchema`、`sourceRefreshRequestSchema`、`paperPdfDocumentSummarySchema`、`isPdfReadableDocument`。保存请求的可选 `organization:{collectionId,tagIds}` 与 `discoveredFromDocumentId` 省略时保留原编码。
- [x] **Step 1:** 新增测试 `keeps old summaries while distinguishing paper PDF and repository Web`、`rejects invalid organization and pagination`：断言旧PDF/Web不变、paper link/PDF正确分派、reader与source一致、未知字段/ownerId/重复或33个tag/越界revision拒绝，JSON Schema与runtime一致。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-contracts -- tests/library-management.test.ts tests/source-details.test.ts`，确认因缺少新合同失败。
- [x] **Step 3:** 实现严格schema、类型与portable输出，contracts进入0.4.0并同步workspace精确引用；同时把已有通用summary消费者改用共享能力guard，不能留到任务10才修编译。不改PDF Reader/bundle v1，不把管理信息加入历史IR。SourceRefresh ref长度1–200，论文version为正safe integer，未知source URL保持普通链接语义。
- [x] **Step 4:** 运行contracts全部测试及根 `npm run typecheck`，旧source/进度/包fixtures通过，新变体非法混用被拒绝；后续尚未启用来源时当前代码仍可构建。
- [x] **Step 5:** 自检并提交 `feat: define library management and source contracts`。

### Task 2: 组织信息、分类、关系与个人搜索 API

**Files:** 新建 `apps/document-service/migrations/007-library-management.sql`、`apps/document-service/src/document-management/{repository,service,routes,query,names,relations,metadata-projection}.ts`；修改documents/library与创建入口、app注册；测试 `apps/document-service/tests/integration/library-management.test.ts`。
**Interfaces:** `createDocumentManagementService({db})`、`registerDocumentManagementRoutes(app)` 实现2.1；创建资料调用 `insertInitialOrganization(client,ownerId,documentId,hints?)`。query全在DB执行，读取不写行/不读ObjectStore。007同时声明2.2所需生命周期字段/表，后续任务接入口。
- [x] **Step 1:** 写 `isolates organization and combines filters without duplicate rows`、`protects concurrent metadata edits and user titles`、`only relates two owned active documents`：两用户+管理员、PDF/Web/链接混合；`total===items去重后的匹配数`、跨owner引用404、`%_\\` literal匹配、tag AND、中文名称/重名、过期revision409、GET零模型/零写入。旧超长合法标题可读取/只改备注，来源更新不覆盖user标题，backfill晚到不索引错误源。
- [x] **Step 2:** 运行 `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/library-management.test.ts`，确认新路由/表尚不存在而失败。
- [x] **Step 3:** 实现007、CAS、分页查询和关系；名字唯一key由共同纯函数生成。删除分类解除关系而不删除资料。实现源绑定的search metadata投影/有界旧材料补齐，来源更新竞态只提交仍选中的源。显式title编辑标user；异步来源只改善fallback标题。新组织提示只初始化新条目，重复收藏不覆盖旧组织信息。
- [x] **Step 4:** 运行上述DB文件、documents旧文件及service typecheck；验证001–006升级后旧owner/源/Reader/进度不变。
- [x] **Step 5:** 自检并提交 `feat: organize and search the private library`。

### Task 3: 删除状态、读取边界与异步发布围栏

**Files:** 新建 `apps/document-service/src/document-lifecycle/{guards,trash,retired-identities}.ts`；修改该服务documents/{library,repository,service}、readers/{repository,service,progress}、web-readers/{repository,service}、bundle-imports/{repository,service,publication}、web-captures/{repository,service,publication,fetch-runner}、web-jobs/{repository,service,lease,profile,cache,publication,state-store,finalize}及worker/finalizer-schedule；测试 `apps/document-service/tests/integration/document-lifecycle.test.ts`。
**Interfaces:** 实现 `assertDocumentActive`、`trashDocument(actor,id,expectedEpoch)`；JobLease及入站操作携带不可变document epoch。普通历史版本读取只要求文档active，不能用创建时旧epoch阻止恢复后读取保留材料；旧操作继续写入则必须精确epoch。
- [x] **Step 1:** 写 `revokes all read and publication paths when trashed`、`rejects delete-restore ABA publication`、`fences an untargeted upload across retirement`：覆盖PDF/Web、GET/HEAD/Range/原始文件/版本/chunk/进度/导出；`expect(response.statusCode).toBe(404)`，独立worker已在途→删除→恢复后 `expect(currentVersion).toBe(before)`、`expect(newPublishedRows).toBe(0)`，跨owner仍404。
- [x] **Step 2:** 运行 `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/document-lifecycle.test.ts`，确认删除无效或迟到提交的RED；保留原始日志，不放宽超时。
- [x] **Step 3:** 接入统一active检查和007 epoch约束；soft delete在owner/document锁内递增epoch、取消任务/导入/有目标采集、撤销slot及requested指针。大对象读取后和最终提交前复检；source获取、缓存、付费调用的500ms主动中止也包括删除。终态旧epoch任务不再进入finalizer重试循环。
- [x] **Step 4:** 用临时DB运行 `document-lifecycle.test.ts`、既有 `web-job-settings.test.ts`、`web-jobs.test.ts`、`web-job-restart.test.ts`、`bundle-imports.test.ts`、`web-captures.test.ts`、`reader-routes.test.ts`、`web-reader-routes.test.ts` 及service typecheck，检查slot/profile/checkpoint/partial publication围栏仍有效。
- [x] **Step 5:** 自检并提交 `feat: fence deleted documents across readers and workers`。

### Task 4: 回收站恢复、到期永久清理与最小收据

**Files:** 新建 `apps/document-service/src/document-lifecycle/{repository,routes,restore,purge-plan,maintenance}.ts`、`apps/document-service/src/cli/cleanup-documents.ts`；修改worker/main、cleanup-staging、cache适配；测试 `apps/document-service/tests/integration/document-trash.test.ts`、`apps/document-service/tests/unit/document-purge-plan.test.ts`。
**Interfaces:** `restoreDocument(actor,id,expectedEpoch)`；`requestDocumentPurge(actor,id)` 返回清理id；`runDocumentMaintenance`按2.2工作。007的 `document_purges,object_deletion_queue,retired_operations,retired_document_identities,web_cache_document_refs` 均为owner边界内数据。
- [x] **Step 1:** 写 `restores retained versions without restarting jobs`、`keeps missing originals in trash`、`purges owned content but retires old operation keys`、`continues cleanup after one object fails`：实际文件缺失/坏hash→409仍在回收站；30天前/后临界、删除期间恢复竞争、已打开导出流、三类入站重放；断言另一owner/同owner其他资料及sentinel字节不变、无模型调用、旧key410、新入站新key可新建不同ID。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-service -- tests/unit/document-purge-plan.test.ts` 及 `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/document-trash.test.ts`，确认缺少恢复校验/真实清理的RED；只用本次创建的ObjectStore/schema。
- [x] **Step 3:** 对仍被引用的真实材料在事务外核对hash/bytes，再以epoch CAS恢复；缺少分类只解除失效组织引用，不冒充缺少原件。永久清理先提交可恢复的清理账本与retirement摘要，再按FK依赖删除最多500行/100对象；请求幂等键只留摘要。所有新增表必须纳入purge图；阻止其他资料关系级联删除；worker同样调度Task2有界metadata backfill。
- [x] **Step 4:** 运行新测试、documents/bundle/web捕获回归。真实注入一次文件删除失败后重启worker，检查剩余对象最终清理、最小收据可重复查询、旧终态结果不可重新发布。保留锁序与对象发布锁，旧不可变UPDATE触发器不被关闭。
- [x] **Step 5:** 自检并提交 `feat: restore and purge documents from the private trash`。

### Task 5: 完整消息预算和已确认 outbox 载荷整理

**Files:** 新建 `apps/extension/src/archive/{delivery-budget,outbox-payloads}.ts`、`apps/extension/tests/unit/{archive-delivery-budget,archive-payloads}.test.ts`；修改collector/page-controller、archive/database/outbox、popup/capture-panel及原归档tests；更新extension-site-capture说明。
**Interfaces:** `fitCaptureDelivery(grant:CaptureGrant,draft:CaptureDraft):CaptureDraft` 在保存可信资源选择映射/发送前，以完整 `{type,grant,payload}` 的实际UTF-8 JSON计费；`compactCompletedEntry(binding,id)` 在同一IDB事务保留收据、删除payload。数据库升级使用逐行cursor，失败升级保留原库。
- [x] **Step 1:** 将S3 N1的自有有效PNG/6030字符URL/两份CSS边界写成永久回归，断言 `expect(deliveryBytes).toBeLessThanOrEqual(16*1024*1024)`；另测JSON转义、无可裁CSS的明确链接回退、三模式同原文与过期grant。写旧v1库升级、quota中止、已确认完成/ACK丢失/取消未知/换账号/重启用例，断言只有确认完成payload清掉，其他真实字节可继续提交且UUID不变，升级失败原库不损坏。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/extension -- tests/unit/archive-delivery-budget.test.ts tests/unit/archive-payloads.test.ts`，以及 `npm run test:e2e --workspace @pagelingo/extension -- tests/e2e/archive-upload.test.ts`，确认原边界或未清理载荷的RED；保留截图/context。
- [x] **Step 3:** 实现完整封装预算，CSS降级带警告且重建同一最终草稿的资源授权；仍超限则诚实回退。IDB把header与draft/request/files分仓，状态列表按partition游标最多50条，不加载全部payload。只在原有授权/ACK围栏通过后compact completed；pending/retry/取消未知保留，取消条目仅用户明确移除本地记录时清理。
- [x] **Step 4:** 运行extension所有归档unit和 `archive-source.test.ts`、`archive-upload.test.ts`；验证丢ACK、原生worker终止与账号隔离仍通过。类型检查/build通过，后台16MiB拒绝仍存在，未增加通用资源fetch权限。
- [x] **Step 5:** 自检并提交 `fix: bound capture envelopes and compact confirmed outbox payloads`。

### Task 6: 资料管理界面与收藏分类入口

**Files:** 新建 `apps/web/src/features/library/{organization-panel,taxonomy-controls,library-filters,relations-panel,trash-page}.tsx` 与相邻hooks；修改library/detail/router及extension capture面板/站点请求；测试 `apps/web/tests/e2e/library-management.test.ts`、`document-trash.test.ts` 和extension归档测试。
**Interfaces:** 使用2.1 DTO。新增 `GET /api/v1/capture-options?kind=collections|tags&q&cursor&limit`，默认50/max100，仅返回本人id/name，使用已有 `preferences:read`（会话也可读）；这是本计划明确增加的收藏选项读取用途，不开放文档/备注/内容。新创建资料的organization提示进入原请求幂等身份，省略时保持旧编码。
- [x] **Step 1:** 写 `organizes documents across devices and preserves filters`、`does not apply late metadata to another account`、`restores and permanently removes only the selected item`：真实API两浏览器、CAS冲突、键盘/明暗/375px、删除关系不删目标。插件测试选分类→断网/丢ACK重试同请求、分类中途删除后原件仍保存并明确警告。
- [x] **Step 2:** 运行 `node scripts/with-test-postgres.mjs -- npm run test:e2e --workspace @pagelingo/web -- tests/e2e/library-management.test.ts tests/e2e/document-trash.test.ts` 和Task5归档unit，确认管理行为缺失的RED。
- [x] **Step 3:** 在现有布局增加组织信息、组合筛选、阅读状态、关系和回收站；仅永久删除/丢弃未确认本地载荷要求明确用户操作。保存提示只初始化新资料，重复收藏不覆盖已有分类；accepted之后分类被删除，保存原件并返回有界警告。旧设备/旧请求不被追加未声明字段，所有选项、payload和晚到响应随owner/auth epoch清除。
- [x] **Step 4:** 运行目标文件及旧library/account-isolation/reader-progress/web-progress回归；确认被动阅读0PUT、管理操作不改变Reader/译文。保存真实桌面/手机明暗截图，检查可读性和焦点，不写CSS镜像测试。
- [x] **Step 5:** 自检并提交 `feat: manage collections tags reading state and trash`。

### Task 7: 来源身份、实际材料账本与受控网络

**Files:** 新建 `apps/document-service/migrations/008-source-adapters.sql`、`apps/document-service/src/source-adapters/{types,url,identity,repository,network,rate-limit,service,routes,receipts}.ts`；修改links分类、worker lease、job DB约束及purge依赖图；测试 `apps/document-service/tests/integration/source-adapters.test.ts`、`apps/document-service/tests/unit/source-network.test.ts`。
**Interfaces:** `classifySourceUrl(url):SourceReference|null` 在url.ts解析两类源；`createSourceAdaptersService({db})` 的 `details(actor,id):Promise<SourceDetails>` / `refresh(actor,id,input,key):Promise<DocumentLinkResult>`；`SourceTransport`。008新增 `document_source_identities,document_source_aliases,source_requests,source_acquisitions,external_request_limits,github_versions,arxiv_versions,paper_reader_bindings`。acquisition每份材料都对应实际registered asset/SHA，不使用假的会话身份；provider runner/dispatcher入口在任务8/9接入，不能导入尚不存在的模块。
- [x] **Step 1:** 写 `classifies repository roots and versioned arxiv identities`、`keeps one canonical identity without retargeting old jobs`、`retains first acquired bytes across worker restart`、`serializes arxiv requests across processes`：两worker/重定向改host/privateIP/超时/超限/403与429，断言网络零Cookie/Auth、GitHub固定版本header存在、arXiv实际并发≤1且完成后间隔≥3秒；有用户编辑的身份冲突不丢资料。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-service -- tests/unit/source-network.test.ts` 及 `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/source-adapters.test.ts`。复用pinned-wire/worker-process，保留真实DB节流/网络能力缺失的RED，不用fetch mock冒称DNS验证。
- [x] **Step 3:** 实现来源请求幂等账本、alias规则与immutable acquisitions，输入来自当前租约；来源账本按owner/document/authVersion/key唯一。不同逻辑kind即使URL相同也不换绑，已有article快照保留。获取与派生在事务外，登记/选择版本/依赖复检在短事务内。008替换web_jobs文档kind校验函数：fetch允许paper/repository，translate只允许实际Web来源；不解除FK/immutable约束。尚未接入runner的来源明确未支持，不用空实现返回成功。
- [x] **Step 4:** 新网络cap只给api.github.com注入固定 `X-GitHub-Api-Version:2026-03-10`，不把请求头白名单泛化为透传。PDF流结束/中止后关闭agent；arXiv session锁先关闭HTTP再更新3秒冷却/释放连接，不占SQL事务睡眠。运行新测试、`tests/unit/capture-fetch.test.ts`、`tests/integration/web-jobs.test.ts` 与service types。
- [x] **Step 5:** 自检并提交 `feat: add durable source identities and bounded acquisition`。

### Task 8: GitHub repo 与固定 README 阅读流程

**Files:** 新建 `apps/document-service/src/source-adapters/{github,github-publication,capture-resources,dispatch}.ts`；修改 `packages/web-capture/src/node.ts`、source/web publication及library投影；测试 `apps/document-service/tests/integration/github-repository.test.ts`、`packages/web-capture/tests/source-metadata.test.ts`。
**Interfaces:** `runGithubFetchJob(lease:JobLease,deps:SourceFetchDependencies):Promise<void>` 与 `runSourceFetchJob` dispatcher在此接入；其内部acquisition/prepared类型定义在source-adapters模块中。repo source与Reader继续使用真实Web IR/SDK；可信内部来源证明单独绑定repository ID/commit/path，不放宽公共capture接口的URL/kind校验。
- [x] **Step 1:** 写 `pins metadata raw README and rendered HTML to one commit`、`keeps metadata when README is absent or resources fail`、`preserves explicit titles when fetch completes late`、`reuses a known repo across rename without merging edited records`：分支中途移动、raw blob SHA不符、README404/过大、私有repo/限流、恶意HTML/SVG、实际图片、旧Reader打开期间新commit；断言不可变版本/真实hash、缺失原因及未改current opened版本。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/web-capture -- tests/source-metadata.test.ts` 及 `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/github-repository.test.ts`，确认repo仍links-only的RED。
- [x] **Step 3:** 匿名GET仓库元信息→解析目标ref到完整commit→以该commit取得README metadata/raw/HTML；校验raw的Git blob SHA1和独立实际SHA256。上游JSON只提取已知字段并允许其他上游字段，不把完整响应merge进业务DTO；验证repo ID/commit/path，unsafe整数ID不舍入。raw上限1MiB、HTML8MiB，保存响应再清洗。图片沿受控网络/真实图片检查及原16/64MiB等预算；不可取的资源显式missing，源raw/HTML不执行。
- [x] **Step 4:** 发布到当前repo自身已绑定的Web源/Reader，合法偏好才调用既有publication scheduler。无README只显示元信息，不造空Reader。普通博客M5从同一次Readability结果提取有界title/author/date，保留用户title，不再fetch。更新旧S3的GitHub仅链接阶段断言，同时保留未支持GitLab的链接回退测试；运行目标DB、`apps/web/tests/e2e/web-reader.test.ts` 相关来源用例、Web capture/render/SDK保护及types/build。
- [x] **Step 5:** 自检并提交 `feat: archive versioned GitHub repository readmes`。

### Task 9: arXiv 固定版本 PDF 与明确目标导入

**Files:** 新建 `apps/document-service/src/source-adapters/{arxiv,arxiv-atom,arxiv-publication}.ts`、`apps/document-service/src/documents/pdf-validation.ts`；修改documents/repository/service/source-response、readers、bundle-imports、共享paper summary投影与008约束；测试 `apps/document-service/tests/integration/arxiv-paper.test.ts`、`apps/document-service/tests/unit/arxiv-atom.test.ts`。
**Interfaces:** 复用Task7的source URL parser，再以真实Atom确认ID/版本，不维护第二套URL规则；`runArxivFetchJob(lease:JobLease,deps:SourceFetchDependencies):Promise<void>` 接入dispatcher，产出固定version与实际PDF asset。source metadata选中版本，PDF Reader仍使用原有IR/bundle合同。
- [x] **Step 1:** 写 `resolves latest once then resumes the fixed version`、`keeps v1 translation separate from a changed v2 PDF`、`records separate paper versions for identical PDF bytes`、`imports a bundle into the explicitly selected paper source`：现代/旧ID、同字节两版保留各版本绑定/可复用原件、不同字节新source等待本地处理；伪PDF/Atom错误entry/DTD/超深XML、下载中断、坏hash/跨owner/包已在另一条目。断言旧Reader源不变、不同原件的新summary为awaiting-local-processing、0服务器推理/模型请求。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-service -- tests/unit/arxiv-atom.test.ts` 及 `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/arxiv-paper.test.ts`，确认paper不能登记PDF/导入的RED。
- [x] **Step 3:** SAX解析≤1MiB Atom，拒绝DOCTYPE/实体声明，深度32/节点5000/作者1000/摘要20,000字符；验证唯一entry与请求ID/版本，再构造匹配的HTTPS PDF地址。提取现有PDF流校验供上传/下载共用，不复制宽松验证器。保存feed与流式PDF后发布固定source；恢复复用材料，不把无版本请求再次解析成更新版本；IR不能覆盖论文来源元信息。
- [x] **Step 4:** 原kind保持paper；放开008中对应source/parse/Reader能力且保留PDF强FK，验证targetSourceVersionId及targetPaperVersion的配对。只复用本论文内字节确实相同的源/Reader并记录版本关联；不同current source不保留旧Reader，导入历史版本不提升当前指针。历史source资产按登记身份读取。运行目标DB及现有PDF documents/reader/bundle/progress回归，验证旧v1包/请求hash不变。
- [x] **Step 5:** 自检并提交 `feat: collect fixed arxiv papers and bind local reader imports`。

### Task 10: 来源详情、插件入口与明确关联收藏

**Files:** 新建 `apps/web/src/features/library/{source-details,source-refresh,source-versions}.tsx`；修改document-page/row、PDF/Web分派、link-dialog及extension来源选择与capture面板；测试 `apps/web/tests/e2e/source-adapters.test.ts` 和extension来源原生用例。
**Interfaces:** 只消费SourceDetails/实际阅读能力。已知GH repo根路径与arXiv abs/pdf/html由插件交给站点适配器；GH非根文档可另存article。来源卡展示固定commit/版本、真实材料、警告与更新操作，不在GET自动取新版本。
- [x] **Step 1:** 写 `collects repo and paper links through the actual extension`、`reads fixed sources after origin disappears`、`links an explicitly selected discovered document`：真实API/独立mock worker、旧窗口固定版本、alias明确导航/冲突保留编辑、选择来源外链时添加owned关系；新旧账号晚到响应不能串状态，错误版本包明确拒绝。
- [x] **Step 2:** 运行 `node scripts/with-test-postgres.mjs -- npm run test:e2e --workspace @pagelingo/web -- tests/e2e/source-adapters.test.ts` 及 `npm run test:e2e --workspace @pagelingo/extension -- tests/e2e/archive-source.test.ts`，确认入口/展示缺失的RED。
- [x] **Step 3:** 接入repo/paper来源视图、版本/导入/原件入口和稳定请求UUID；并发重复的alias只导航到本人canonical，冲突不自动丢编辑。已存在资料给出已有条目，更新需要显式操作；X/文章外链由用户点选保存/关联，不自动抓全站。资料组织与被动阅读保持独立。
- [x] **Step 4:** 运行目标site、library、web-reader、PDF reader/progress、extension archive回归；检查375px/桌面明暗截图和键盘操作，不能用mock截图替代真实UI。公开来源手工样本记录URL/时间/hash，拿不到的真实来源如实未验证。
- [x] **Step 5:** 自检并提交 `feat: browse versioned sources and related collections`。

### Task 11: 可信 Web 离线 Reader 与静态资源目录

**Files:** 新建 `packages/document-renderer/src/{web-static,web-static-catalog}.ts`、`packages/document-renderer/static/{web-offline-runtime.js,web-reader.css}`、`packages/document-renderer/scripts/generate-web-static-catalog.mjs`；修改renderer exports/package scripts及两类catalog源文件选择；测试 `packages/document-renderer/tests/web-static.test.ts`、`apps/web/tests/e2e/web-offline.test.ts`。
**Interfaces:** 实现2.4的 `WebStaticPlanInput/WebStaticFilePlan`、`createWebStaticFilePlan`、`resolveTrustedWebCatalog(version,codeSha256):TrustedWebRendererCatalog`（未知则拒绝）；catalog的generateFiles接收WebStaticPlanInput，不复用PDF ReaderBuild签名。返回确定性generated files和所需可信assets；保留0.1/0.2历史目录。
- [x] **Step 1:** 写 `opens all Web reading modes from file without the origin`、`keeps long documents within three mounted chunks`、`never executes archived HTML CSS or payload scripts`：20k预算内块、表格context、公式、代码、原型名image IDs、source-only/partial译文、源节点快照和原生图片解码失败提示。Chrome直接file://打开并阻断所有HTTP，断言资源/所有分片可用或有真实缺失原因，0出站、0源脚本执行、最多3分片/1预览。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-renderer -- tests/web-static.test.ts` 和Step4的单文件离线browser命令，确认Web离线计划缺失或file://数据不可读的RED。
- [x] **Step 3:** 使用共享 `renderWebChunk`/绑定保护预生成三种模式的可信分片HTML，按已有模式用classic runtime/data脚本加载，避免file:// fetch/ESM的CORS依赖，不加关闭安全检查的Chrome参数。派生JS数据与入口严格转义脚本边界；快照用白名单资源重写的单个scriptless sandbox预览。PDF/Web两个catalog都排除会包含自身hash的生成输出模块，避免递归指纹。
- [x] **Step 4:** 运行renderer单元、`node scripts/with-test-postgres.mjs -- npm run test:e2e --workspace @pagelingo/web -- tests/e2e/web-offline.test.ts`、PDF static及Task0旧包回归；替换runtime/data.js/路径/未知catalog会失败。连续两次无源码变化build的catalog完全相同；保存mobile/light/dark真实截图。不可用原始资源仍显示缺失，不冒称来源完整。
- [x] **Step 5:** 自检并提交 `feat: build trusted offline Web readers`。

### Task 12: Web 包合同、完整闭包校验与流式 ZIP

**Files:** 新建 `packages/document-contracts/src/web-bundle.ts`、`packages/document-contracts/tests/web-bundle.test.ts`、`packages/document-bundle/src/{web-manifest,web-validate,web-zip-writer}.ts`、`packages/document-bundle/tests/web-bundle-validation.test.ts`；按需提取同包私有zip-output.ts，修改index/schema生成，不放宽PDF validateBundle。
**Interfaces:** 实现 `webDocumentBundleManifestSchema`、`ValidatedWebBundle`（manifest/source/IR/真实可空translation/build/files/实际身份）及2.4的validate/write。共用BundleFileSource/BundleOptions/BundleIdentity，Web payload不能进入PDF入口冒充source.pdf。
- [x] **Step 1:** 写 `roundtrips an original-only and partial Web package`、`rejects missing assets hostile paths and untrusted runtime bytes`：hash/字节/来源指纹/SDK proof、缺文件/重复路径/目录逃逸/符号链接/压缩炸弹/未知运行时、非文件引用的__proto__/constructor/toString本地ID；跨类型包互相拒绝，原输入前后SHA一致。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-contracts -- tests/web-bundle.test.ts`、`npm run test --workspace @pagelingo/document-bundle -- tests/web-bundle-validation.test.ts`，确认格式缺失的RED；schema形状通过不代表资源闭包通过。
- [x] **Step 3:** 先验证全部实际文件，再用共享Web投影/SDK校验/renderer重建比较可信派生内容。未匹配或不完整的译文保持源状态或拒绝冲突，不把未证明文字当译文。流式写出重新计数/hash，临时目录/失败中止只清本次文件，原子不覆盖目标；PDF写出路径仍先走原validateBundle。
- [x] **Step 4:** 运行contracts/bundle/renderer tests与离线Chrome回归，固定S2/S3包仍通过；在最大路径/JSON深度/单文件/总量边界断言明确错误，普通校验/导出0模型请求。
- [x] **Step 5:** 自检并提交 `feat: validate and write complete Web reading bundles`。

### Task 13: 私有下载、可恢复导出任务与界面

**Files:** 新建 `apps/document-service/migrations/009-web-exports.sql`、`apps/document-service/src/web-exports/{repository,service,routes,runner}.ts`、`packages/document-contracts/src/web-exports.ts`、`apps/web/src/features/library/export-panel.tsx`；修改worker dispatcher/lease/reconcile、job合同、purge图、版本下载按钮；测试 `apps/document-service/tests/integration/web-exports.test.ts`、`apps/web/tests/e2e/document-downloads.test.ts`。
**Interfaces:** 实现2.4路由/DTO。`runWebExportJob(lease,deps):Promise<void>` 绑定当前授权但固定所选Reader，压缩/对象读取在事务外；生成后只有当前doc epoch/lease仍有效才能登记附件。job的kind明确export-web，不走translation finalizer。
- [x] **Step 1:** 写 `exports the selected immutable version with no model calls`、`recovers lost create acknowledgement and worker restart`、`rejects a late export after deletion or account change`：当前Reader更新不换选中版本、source-only/partial、期限前后、他人/管理员的GET/HEAD/Range404、无账号401、下载断开/磁盘失败/坏对象、purge时文件最终清理。PDF导出与原ZIP `expect(actualBytes).toEqual(retainedBytes)`。
- [x] **Step 2:** 运行 `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/web-exports.test.ts`、`node scripts/with-test-postgres.mjs -- npm run test:e2e --workspace @pagelingo/web -- tests/e2e/document-downloads.test.ts`，确认导出或围栏缺失的RED，保留文件故障证据。
- [x] **Step 3:** 接入009和现有2/1槽队列，claim/reconcile以 `kind==='translate'` 判断profile要求，fetch/export不需要Key；finalizer只处理translate。Web导出采用受控隔离worker，120秒总限、768MiB Node heap、256MiB临时ZIP上限，随取消释放本次资源。过期文件进入同一durable清理队列。
- [x] **Step 4:** 实现显式POST→有界状态读取→私有附件下载；旧版本有独立原件/包入口，link-only不造空包。UI状态按owner/auth epoch清除，按实际源能力展示PDF与Web动作。运行新DB/site及旧Reader/source/private assets回归，下载名/header沿用现有安全编码，导出内容无站点会话/Key/运行机绝对路径字段。
- [x] **Step 5:** 自检并提交 `feat: download original assets and private offline exports`。

### Task 14: S3→S4 升级、来源与管理全链路验收

**Files:** 新建 `scripts/check-site-s4.mjs`、`tests/fixtures/site-s4/samples.json`、`docs/learning-site-s4-validation.md` 与精选真实截图/机器可读摘要；更新安装、extension-site-capture、site指南和root script。
**Interfaces:** `npm run check:site:s4 -- --samples <declaration.json> --output <new-dir>`；声明 `pagelingo-site-s4-samples/1`、UTF-8≤1MiB/≤32项，每项synthetic/cached-public/live-public、URL、固定版本/实际输入hash/时间/预期范围，resources≤256。先stat并校验路径/类型/总输入≤512MiB与各既有单文件限额；样本顺序流式读取，不整体载入内存。声明与只读输入/输出别名先检查，再创建临时服务，不能默认读用户环境或生产数据。
- [ ] **Step 1:** 固定全链路用例：收藏→分类/搜索→关系→私有读取→删除→恢复→导出→离线读取→永久清理；两浏览器/两owner/独立worker；GitHub根repo与文档子页、arXiv两版本与本地包目标绑定、旧S2/S3包、N1临界和旧IDB。每项有实际身份/hash/字节/状态，不用合成夹具冒充真实站点。
- [ ] **Step 2:** 在本次独立DB先应用001–006并导入已有PDF/Web、进度、标签前基线，再升级007–009；保留卷重建API/worker/DB后检查原资料、元信息、私有权限与下载。故障注入断在purge/export/acquisition各一次，重启后只恢复合法剩余工作，无重复付费请求。
- [ ] **Step 3:** 冻结最终运行时/合同/静态目录后顺序执行 `npm ci`、`npm run check`、`npm run check:site`、声明的S4全链路、S2/S3兼容和 `npm audit --json`；每次记录实际命令/退出码/来源与mock边界。失败先保留raw/context/trace再修正并运行覆盖改动的检查，不因无变化反复跑整套。Python未改不重复安装/跑parser。
- [ ] **Step 4:** 至少各一份公开GitHub repo和固定arXiv真材料补充匿名验收，保存实际响应/时间/hash；拿不到则明确未验证及原因，不能宣称来源全部通过。X/知乎/公众号真实登录与真实BYOK语义质量留在S5的专门验收；检查默认用mock，不在后台顺手发真实模型请求。
- [ ] **Step 5:** 保存来源矩阵、未验证范围、未解决Minor、截图和升级/中断证据；自检提交 `docs: document S4 collection management and source validation`。随后按保留的执行方式做任务/整分支审查，修正复核后才标最终完成；合入/推送依用户最终集成选择，保留宿主管理worktree。

## 5. 计划自检与交接

需求映射：A02→1–4/6–10/13–14；A06的明确外链收藏→2/6/10；A10导入与重复身份→0/7–9/12/14；A11→7–10；A12删除/取消/迟到结果→3–4/7/13–14；A13组织/阅读状态/回收站→2/4/6/10；A14→0/11–14；A16→各任务目标检查与14。S5保留公网部署、空环境备份恢复、全来源真实会话和真实模型质量整体验收。

实施前使用新隔离工作区，从此计划所在提交创建；不得复用或删除已交付S3的宿主管理worktree。计划已由用户确认，执行方法沿用此前SDD，每项先测试失败、实现、覆盖验证、提交与任务审查；当前在 `feat/learning-site-s4` 独立分支持续实施。

计划审阅重点是：固定来源与论文目标版本、30天回收与真实永久清理、插件分类权限用途、明确Web离线包暂不提供ZIP重导入入口、旧缓存清理对后续命中的影响。实现方选择已列在第1–2节，未把它们冒称为用户最初指示。

2026-10-28 计划自检：已逐项核对上述需求映射、十五项任务顺序、共有类型/路由/版本标识、五类Review Focus及当前仓库入口。自检修正了PDF下载真实路由、同字节论文的版本关联、旧长标题读取、生成catalog相互指纹、README descriptor的base64预算，以及新类型提前影响旧消费者的编译依赖。本段保留编制时的计划自检记录；实施进度与验证范围见下方执行记录及任务复选框。

### 当前执行进度（2026-10-29）

任务0–13已完成并通过独立任务审查与必要的修正复核，交付段A资料组织/生命周期和B来源适配完成，C的离线Reader、完整阅读包校验/写出与私有下载已完成。当前支持GitHub固定README、arXiv固定版本原件、历史来源与Reader配对、论文目标导入及明确关联收藏；任务14继续推进升级、中断恢复、真实公开材料与整体回归验收。

| 任务 | 结果与提交 |
| --- | --- |
| 0 | S3运行时/合成包冻结、旧包可信验证；`80daef8`。已有静态分派、资产验证和Docker compat COPY经检查可直接复用，记录为无需代码改动的例外。 |
| 1 | 严格管理/来源合同、论文PDF能力分派；`53956e8`。 |
| 2 | 集合、标签、关系、组合搜索、源绑定投影与公平补齐；`33bd2e4`、`33a71f9`。 |
| 3 | 读取、上传、任务、缓存与发布生命周期围栏；`55db4c2`。 |
| 4 | 材料校验恢复、真实永久清理、退休收据、缓存引用和有界维护；`572c783`、`70eb81a`。 |
| 5 | 完整采集消息预算、分页轻量记录、已确认载荷整理及本地清理失败恢复；`0af612d`、`2ec2900`。 |
| 6 | 管理/筛选/关系/回收站界面、插件分类、完整导入提示与请求重试边界；`78282cd`、`d7f1dac`。 |
| 7 | 稳定来源身份、不可变采集账本、受控出站与跨进程限流；`68c4120`、`506b6ce`。 |
| 8 | GitHub固定提交README、实际资源与Web Reader、同次提取博客元信息；`7d0b17a`。日期非法日历值的Minor修正仍须在任务14完成。 |
| 9 | arXiv固定版本元信息/PDF、同字节论文版本绑定、明确目标导入和历史原件；`f63f527`、`619dcb2`。 |
| 10 | 来源/历史界面、插件已知来源入口、发现链接与论文导入重试状态、来源配对验证；`75ed0a4`、`2268119`。 |
| 11 | 独立可信Web目录、三模式本地阅读、真实无脚本快照、资源失败提示与有界长文；`0119517`。 |
| 12 | 独立Web完整包、原件/SDK/可信执行文件闭包校验、原子流式写出与普通离线浏览器往返；`c4af15c`。 |
| 13 | 所选版本私有导出、共享租约/槽与临时工作清理、24小时附件、稳定重试与历史PDF下载；`0192a8b`、`0e19866`。 |

任务4保留309项服务端完整集成快照；最终恢复引用修订通过42项相关回归，预算与维护错误修正通过23项回收站回归、139项单元测试及类型检查/构建。任务5的最终修正通过91项归档单元测试、14项原生浏览器测试及类型检查/构建，验证真实IndexedDB失败回滚与确认后仅本地重试；不冒称物理磁盘耗尽验收。

任务6的冻结根检查通过939项单元测试和70项插件浏览器测试。其初次广泛站点/服务检查分别为65/68与316/317，失败记录保留；旧接口测试、确认后载荷测试和窄屏布局已由独立专项修正关闭。最终导入边界修正通过42项API测试、16项浏览器测试及类型检查/构建，移动阅读/管理对齐另有5项专项通过和真实明暗截图。上述结果属于各自提交快照，不合并重复计数；S4最终冻结后的根检查与站点全量验收仍由任务14完成。

任务7–10分别保留来源身份/限流、GitHub投影、arXiv跨进程恢复和实际浏览器验证。任务8冻结检查为498项通过；任务9的169项单元测试通过，171项集成初次为168通过、3项旧断言失败，随后3项相关用例及1项强化传输用例修正通过，不记为全量171项重跑。任务10核心API41项、来源单元31项、插件归档单元41项和原生浏览器16项通过；初次站点检查为38/52，PDF原件路由与导入重试修正后42项相关浏览器检查通过。最终专项修正另有4项API、16项浏览器及构建/类型检查通过，保留原失败记录，不累加重叠计数。

任务10使用匿名受控传输实际取得公开GitHub固定提交材料与arXiv固定版本元信息/PDF，记录URL、时间与hash；这只证明材料获取，完整真实来源到界面的验收仍在任务14。历史截图输出复用的范围已扩展核对：任务6有11个路径被后续运行重写，任务5另有7个路径的原始PNG出处无法完整核实。已保留所见字节、hash/mtime、追加更正与独立原始日志/trace；不将新截图冒充原图。站点3处循环已改为独立输出，插件7处路径须在任务14任何根/原生检查前修正。M5非法日历日期修正、最终全量检查和输出警告核对仍待任务14。

任务11通过92项Renderer测试、5项普通file://浏览器测试、PDF静态检查及两个固定旧包验证；初次类型检查中的负向测试类型写法已修正，最终类型检查及1项单元/1项浏览器专项通过。生产/运行时字节在测试修订前后相同，两次无源码变化构建的PDF/Web目录逐字节一致。系统深色首次主题切换与浏览器诊断分类两项Minor须在任务14冻结前修正。完整ZIP闭包与替换文件拒绝由任务12实现，不把未验证脚本的自我检查当作完整性保证。

任务12冻结检查通过109项合同测试、92项Renderer测试、6项普通离线浏览器用例及三个包的类型检查。包测试为180/181，唯一失败是旧S2/S3兼容用例的5秒超时；未改源码的单项复验通过，360份冻结文件哈希一致。该记录保留为超时后专项通过，不写成全量181项重跑，也不认定并发负载已被证明是唯一原因。最终根/站点验收仍在任务14。

任务13冻结结果为服务399/401、站点110/115，原始失败全部保留。迁移/旧预期与实际窄屏布局修正后，60项服务专项通过，跨类型断言补强后单项通过；浏览器专项8/9后仅定位器修正的单项通过。独立审查另发现改密后完成附件被创建auth版本挡住，修正后23项导出集成及构建/类型检查通过，专项复审关闭。以上不宣称最终全量401/115重跑；最终当前代码的完整验收仍由任务14执行。精选当前界面：[桌面导出](../../assets/learning-site-s4/exports/web-export-desktop.png)、[375px导出](../../assets/learning-site-s4/exports/web-export-mobile-375.png)、[深色阅读](../../assets/learning-site-s4/exports/web-reader-mobile-dark.png)。

实施中的接口补齐、验证裁定及其影响另见[实施裁定记录](../../learning-site-s4-decisions.md)，最终分支审查后继续核对。

四份原始S2大样本ZIP在当前环境缺失；新增旧包兼容验证使用仓库固定S2/S3合成包，真实大样本验证沿用既有验收记录，不记作本轮重跑。逐任务失败、修正和验证原始证据保留在本工作区的ignored执行目录。

## 6. 外部接口依据

- [GitHub repository contents / README](https://docs.github.com/en/rest/repos/contents)：固定ref、raw/HTML媒体类型和公开资源匿名访问；[API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)：显式固定2026-03-10，不依赖默认版本。
- [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html)：id_list与明确版本、Atom元信息；[arXiv API limits](https://info.arxiv.org/help/api/tou.html)：全部署共享单连接、三秒间隔。本计划采用响应完成后再等三秒的保守实现。
- 本地authority为已批准V1设计、已合入S1–S3合同、`defaultCaptureLimits/defaultBundleLimits/readerContractCeilings` 及现有受控网络/SDK公开入口。外部文档只说明适配协议，不扩大产品范围。
