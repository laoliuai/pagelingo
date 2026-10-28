# S3 执行裁定记录

对应已批准的 [S3 计划](superpowers/plans/2026-10-27-learning-site-s3.md)。本记录汇总执行期间的全部 R1–R31，保留原因及判断错误时的返工范围；原始裁定附于后文，避免仅存在临时会话记录中。

这不是新增范围批准，也不代表真实登录态来源或译文语义质量已验收。最终能力与证据边界见 [验收记录](learning-site-s3-validation.md)。

| 编号 | 最终决定 | 原因 | 判断错误时的代价 |
| --- | --- | --- | --- |
| R1 | URL 规范化由 web-capture 实现，合同测试先验证字段保留。 | 避免依赖尚未存在的后续模块。 | 移动一项测试。 |
| R2 | 采集设备可读无敏感保存偏好；修改仍限会话。 | 让 preferences:read 权限有实际用途。 | 调整权限与回归。 |
| R3 | 数学内容使用现有 protected 绑定和 Web 元数据。 | 复用 SDK，避免改变 PDF 保护类型。 | 修改 Web 适配合同。 |
| R4 | 失败 S2 样本诊断集中到交付工具阶段补齐；现已完成。 | 成功兼容已有证据，诊断归属交付工具。 | 交付前失败报告信息较少。 |
| R5 | 手动源语言和所选块进入不可变任务身份；自动判断不调用模型。 | 支持短文、混合及不确定语言。 | 请求与任务身份的有限调整。 |
| R6 | 使用版本化、源绑定的导入译文候选，服务端重放验证。 | 客户端尚无服务端 IR/parse 身份。 | 调整候选 DTO 和消费者。 |
| R7 | 投影异步验证真实字节；预览构建返回索引与实际 HTML 文件。 | 真实 SHA 和资源预算需要完整输入。 | 修改局部异步调用接口。 |
| R8 | 显式传递资源重放上下文与 image/css 角色。 | 清洗后不能从热链或缺失文件猜测资源。 | 调整资源合同与清洗重放。 |
| R9 | previewId 可空，通过已登记索引和源节点定位。 | 渲染阶段不拥有预览索引。 | 调整定位消费者。 |
| R10 | 重复表格上下文以 contextBlockIds 标记。 | 保留语义并排除重复进度、目录和翻译单元。 | 调整分片合同和消费者。 |
| R11 | Web 单独保存实际 headingLevel。 | 逻辑深度不能还原标题跳级。 | 调整 Web 元数据和投影。 |
| R12 | 源文 Reader 可不带译文；无伪造任务、配置或哈希。 | 实现原文先保存与无 Key 阅读。 | 调整可空引用和渲染接口。 |
| R13 | 跨行单元格可作为标记上下文保留。 | 保留裁切表格几何。 | 调整上下文布局解释。 |
| R14 | 允许派生的无来源空格单元格，不能冒充作者内容。 | 避免缺列导致表格移位。 | 调整派生布局。 |
| R15 | Web 模型译文与导入译文分型，导入不伪造模型任务。 | 导入的可信候选没有模型预算与配置。 | 调整 Web 合同、渲染与未发布006。 |
| R16 | 导入预算溢出采用最多两轮规划，定点剔除不可表示证明。 | 保留原文及其他有效译文。 | 调整局部规划助手。 |
| R17 | 仅资源定位器支持受限 data/blob，绑定当前文档和授权。 | 原批准资源采集需要此能力。 | 调整资源合同、清洗和指纹。 |
| R18 | 草稿候选允许尚无资源指纹；最终上传必须完整验证。 | 资源获取完成前不能诚实生成最终指纹。 | 调整草稿类型和最终化。 |
| R19 | 翻译前省略空 sectionPath；不改写历史译文证明。 | 使 DOM 源与投影源完全一致。 | 调整局部提取和缓存身份。 |
| R20 | 任务7后先10，再8、9、11–13。 | 扩展链接回退需要真实链接 API。 | 只调整执行顺序。 |
| R21 | 已取得 blob 按来源 origin 和实际文件指纹去重。 | 临时对象 URL 不应制造新内容版本。 | 调整语义指纹规则。 |
| R22 | 保存链接要求 UUID Idempotency-Key 与不可变请求账本。 | 丢失确认后的重试不能重复创建资料。 | 协调新增请求头和客户端。 |
| R23 | 抓取任务保存真实租约来源与不可变 acquisition。 | 后台任务没有浏览器会话身份。 | 调整未发布006及内部适配。 |
| R24 | 原文保存服务端语言元数据；短事务只按实际选中版本调度。 | 避免锁内大对象读取和重试版本错配。 | 调整私有元数据与策略查询。 |
| R25 | 持久记录发布节点及已终结 epoch。 | 崩溃恢复仍须有界发布和幂等终结。 | 调整未发布006和仓库。 |
| R26 | 终结失败有界退避，并用稳定 UUID 游标与回绕保证公平遍历。 | 避免损坏任务紧循环或容量饱和饿死后续任务。 | 调整 worker 内部调度助手。 |
| R27 | 增加会话专用、有界的按文档任务发现接口。 | 刷新和跨设备后需要找到真实任务。 | 调整新增查询 API 与消费者。 |
| R28 | 集成文件默认串行；保留隔离、原超时和显式多 worker 并发。 | 共享全库锁且领取允许为空，默认并行造成无效假设。 | 集成检查变慢，必要时改进夹具隔离。 |
| R29 | 显式重译使用可重放 requestId；下一次主动操作使用新身份。 | 区分同一请求重放与同配置的新一轮，仍复用有效缓存。 | 调整可选请求字段、未发布006及仓库/界面。 |
| R30 | 行内 CSS 使用空 URL 和文档 provenance，按原始字节归档且不执行。 | 行内样式没有真实外部资源 URL，仍需保存可用 CSS 证据。 | 调整局部 Web CSS 合同和采集消费者。 |
| R31 | 将复审 N1 的极长 URL / 大草稿封装失败列为非阻塞后续，保留 16 MiB 上限。 | 原重要问题已解决；局部真实采集器探针证明少见的封装预算缺口，后台仍会拒绝超限消息。 | 此类保存暂时失败；后续需按完整消息计费并增加边界回归。 |

R26 在容量边界复审后补充 UUID 游标与回绕；原有 1024 项退避上限保留。R28 的检查记录明确区分初次失败、测试框架调整、后续通过和实际已采集的源码/dist 清单；未补称不存在的早期 dist 清单。

## 原始裁定

以下逐项保留执行记录中的裁定文本。部分合同在后续复审中得到补充，以上表格及计划中的最终合同为准。

### R1

Ruling: R1 — normalizeCaptureUrl belongs to web-capture task2; task1 tests URL schema preservation — avoids a test depending on an absent future producer — cost if wrong: a moved unit test only.

### R2

Ruling: R2 — GET save-preferences permits scoped devices and reveals only nonsecret preferences, PUT remains session-only — makes preferences:read useful without widening permissions — cost if wrong: endpoint permission adjustment with regression.

### R3

Ruling: R3 — represent safe math as immutable protected asset/literal bindings plus Web metadata; do not introduce incompatible SDK protected kinds — preserves shared SDK semantics — cost if wrong: Web contract adaptation, not PDF mutation.

### R4

Ruling: R4 — defer Task0 Minor CLI failed-sample path/hash diagnostic to Task13 validation-tool finishing — successful compatibility and preservation are proven; failure evidence should be improved once, with its owning delivery tool — cost if wrong: less useful failure report until Task13.

### R5

Ruling: R5 — support explicit manual sourceLanguage and selectionBlockIds for languages beyond deterministic detection; automatic rules remain frozen — spec permits manual handling of mixed/short/uncertain text — cost if wrong: bounded request/immutable-job DTO changes. Conservative BCP47-like values, foreign excludes zh/en; und/mul/zxx never qualify as explicit known language. Optional selection is nonempty/unique/bounded; server validates IR membership and canonicalizes IR order. Source language and selection belong to immutable input hash, checkpoint and publication identity. No automatic language detector API calls.

### R6

Ruling: R6 — add a shared strict versioned WebCaptureTranslationCandidate payload, replace opaque draft translation text — Tasks7/6 need a concrete shared format independent of server-generated IR/parse SHA — cost if wrong: capture candidate DTO adjustment before runtime consumers exist. Bind source snapshot/content fingerprint, source/target language, SDK/prompt/protection versions, source node ID, source text SHA, original SDK TranslationBlock and encoded rawText. No translated DOM HTML or trusted client-validation flag. Server compares reprojected source/protected inputs and reruns public SDK validation; mismatch/unknown version skips candidates, preserves original and warns.

### R7

Ruling: R7 — correct preview/crypto interfaces before consumers exist — preview index alone cannot convey generated HTML or real resource budgets; synchronous projection cannot use native SHA256 — cost if wrong: localized async/call-signature adaptation. projectWebReader(snapshot,manifest,{manifestBytes,assets,limits?}):Promise<WebReaderIR>; verify actual bytes parse to supplied strict manifest, hash actual bytes. inspectImageResource(bytes,file,limits):Promise<WebReaderAsset>, actual hash/bytes/image metadata, local id=CaptureFile.id. buildSnapshotPreviews(snapshot,resourceResolvedManifestDraft,limits):Promise<SnapshotPreviewBuild> returns {index,files:[{descriptor:CaptureFile,html:string}]}; build from empty-preview draft with actual resource descriptors, then append preview files/index to final manifest before final IR. Shared semantic projection; stable node/block IDs independent of final manifest hash; no cycle. Root uses parse5 pure AST and injected string-in/string-out purify capability, DOM objects/DOMPurify factory only in browser/node adapters; SanitizedSnapshot DTO unchanged.

### R8

Ruling: R8 — explicit resource replay context and role — sanitized HTML intentionally omits hotlink URLs; second-pass server validation cannot reconstruct them, and missing CSS has no file from which to infer role — cost if wrong: narrow optional-wrapper/manifest-field correction before consumers. SnapshotEnvironment.resources?:readonly PendingCaptureResource[]; browser/Node sanitize wrappers (input,limits?,resources?); replayResourcesFromManifest(manifest); no second Readability pass on scoped uploads. CaptureResource has required role:image|css in both states, available resource matches file role; no extension guessing. Known placeholders only; no hidden URLs; semantic fingerprint/node IDs/SVG refs replay invariant. Task2 owns narrow contract/schema/fixture updates and affected verification, controller owns plan.

### R9

Ruling: R9 — renderer previewId may be null because build input has no SnapshotPreviewIndex — descriptor.snapshots + source node resolve authoritative location — cost if wrong: downstream resolution adaptation, no guessed location.

### R10

Ruling: R10 — explicit contextBlockIds in WebReaderChunk for repeated exact original table headers/captions — empty/guessed labels lose semantics and source quote must not be smuggled context — cost if wrong: narrow chunk/schema/consumer adjustment. Every primary block exactly once in canonical index ownership; context repeats flagged, included in128/byte caps, DOM/SVG IDs chunk/side scoped, no progress/TOC primary anchors or duplicate translation units. Task3 owns small contract/fixture updates and bounded closure tests.

### R11

Ruling: R11 — optional Web text headingLevel1..6 outside SDK value, projector retains actual h1–h6 including synthetic runs — section depth cannot recover skipped source heading levels — cost if wrong: narrow Web metadata/projector adjustment. Renderer uses explicit level, logical nesting only when absent; PDF and SDK kinds unchanged.

### R12

Ruling: R12 — additive optional/null translation input for buildWebReader — original-first/no-Key/auto-off publication precedes any translation artifact, whose current schema otherwise requires provider/job/budget metadata — cost if wrong: narrow renderer/nullable version FK adaptation. No fabricated translation/profile/job/hash; generationKind none, zh/no translatable text not-required, other text honestly pending/manual. validateWebTranslation remains nonnull, PDF unchanged. Task3 adds focused source-only tests; Task4/6 persist nullable translation reference.

### R13

Ruling: R13 — exact spanning-cell blocks may join flagged table context when needed to preserve cropped grid geometry — existing rowSpan semantics cannot be kept by headers alone — cost if wrong: narrow context interpretation/layout correction, no new DTO. Same total budgets/primary ownership/no extra units apply. Derived chunks may fill absent headingLevel using full-source logical depth before pruning; source IR unchanged, explicit levels authoritative.

### R14

Ruling: R14 — derived layout-only gap cells may preserve empty source grid columns — implicit gaps have no authored cell node to copy, yet dropping them shifts spans — cost if wrong: narrow derived layout correction. Padding has no source reference/text/translation/progress anchor and must not be presented as authored evidence; if internal graph IDs needed, unique layout identities only, source IR unchanged. Geometry comes from full-source intervals, remains bounded with existing payload limits.

### R15

Ruling: R15 — Web-only imported translation artifact/union — R6 valid local candidates have no honest model job/profile/budget, and current model-only artifact/DBjob-notnull cannot represent them — cost if wrong: narrow Web contract/renderer/006 adaptation before release. WebModelTranslation keeps web-reader-translation/1; WebImportedTranslation web-imported-translation/1 generationKindimport; WebTranslation union. Actual source/IR byte binding +candidate provenance/versions/language +source-bound raw result/proof; public whole-block SDK replay, no fake model fields/metrics. Web-only generation enum extendsimport; PDF untouched. Import DBjobnullable, modeljobrequired, independent owner/doc/source/parse/asset FKs; Reader mayreferenceimport, capturejobId onlyreal serverjob. Unsupported/mismatched candidateswarnskip, validsupportedonespersist. Immutable registered artifacts/GC. Task6 owns narrow support/regressions.

### R16

Ruling: R16 — approve shared diagnostic chunk-planner additive buildWebImportedReader boundedtwo-passpruning — aggregate requiredtablecontext can exceedbudget despiteindividualprooflimits, failingoriginal-first — costifwrong: narrowrendererhelperadjustment. Droponlyproofs implicatedbyminimalunrepresentableclosures, retainunrelatedproofs, exactbytebindings andtruthfulstatus; noquadraticrebuild/budgetincrease/blanketexceptioncatch. Normalbuilder/PDFunchanged. Publicplan+constraintsupdatedbeforeconsumerchange; originalagentimplementing focusedmulti-badcontext+goodtable/paragraph regression.

### R17

Ruling: R17 — resource-only HTTP(S)/rasterdata/document-boundblob locator schema — current HTTP-only resource schema cannot fulfill approved Task8data/blob acquisition — costifwrong: narrowcontracts/sanitizer/fingerprint adaptation beforeconsumer. Source/navigation/canonical captureUrlSchema remains HTTP(S)-only. Resource URL adds strict bounded base64 data:image/png|jpeg|webp|gif (image-only, linear validation, actual decoded ceiling) and blob:http(s) with valid embedded origin/no userinfo, matching source origin. Local acquisition only from selected snapshot resource bound to current source/document/grant; background/server cannot turn locator into arbitraryfetch. Preserve byte/hash/image inspection and honest missing warnings. Correct sanitizer replay/fingerprint/resource-origin accounting without normalizeCaptureUrl ondata/blob. Existing HTML/total/manifest16MiB/control-route/JSONframe limits unchanged; do not increase budgets for URL payloads. Task7owns minimal sharedsupport/regressions, Task8 actual acquisition.

### R18

Ruling: R18 — distinct draft candidate permits sourceContentFingerprint:null; strict uploaded R6payload stillrequiresSHA — resource fingerprints cannot exist before Task8acquisition — costifwrong: narrowdrafttype/finalizer adjustment. Actual sanitized snapshotSHA/exactoriginalsourceproof/version remainbound; finalizer computes real fingerprint from resolved descriptors/status and validates strictpayload before serialization. Expose pure snapshottranslation-source helper sharing exact semantic/inline projection with projectWebReader, no fake manifest/IR/hash or duplicated SDK protection. Preserve representable valid candidates, unprovable formatted/protected/section mismatches skip+warn, no post-hoc source relabeling. Exact helper signature tobe recordedonceproposed.

### R19

Ruling: R19 — protectNodes omits empty optionalsectionPath at sourceextraction BEFORE translation — existing always[] cannot exactlymatch canonical projector's absentfield — costifwrong: localextraction/cacheidentity adjustment withregressions. Nonemptysections unchanged; old alreadytranslated proofswith[] skip, neverrewritten. SDK/PDFcontracts unchanged, focusedDOM/sourceversion/translation regressionsrequired.

### R20

Ruling: R20 — afterTask7 execute10before8,then9,11–13 — explicitTask7typedlinkfallback consumedbyTask8 requires realTask10linksAPI; allTask10auth/repo/capture/resourceproducers4–7ready andproviderfetchtransportneededlater9 — costifwrong: reorderonly. Publicplan/constraintsupdated. Scopeunchanged; no fakeendpoint/mocked-onlyfallback. Task10briefcarrieslinkretrydedupecontracthandoff, no paidjoborchestrationscopecreep. Task7stillactive, Task10notstartedyet.

### R21

Ruling: R21 — fingerprint-only availableblob provenance {kind:'document-blob',origin}, not ephemeralUUID — actual identical imagebytes undernewobjectURLshouldnot manufacture newcontentversion — costifwrong: narrowfingerprintcorrection beforelocalresourceconsumers. Retain id/role/status/actualfileSHA/bytes/mediaType insemanticidentity. Manifest/actualsourceSHA stillretainexactbloblocator, acquisitionstillgrant/documentbound. MISSINGblob keeps exactlocator+reason (cannotproveequalbytes), explicitconservativededupebehavior. HTTP/databehaviorunchanged, no URLsurrogate/fetchpath. EqualbytesdifferentUUIDequal,changedbytesunequal,missingdistinct regressionsrequired.

### R22

Ruling: R22 — UUID Idempotency-Key required on POST/api/v1/documents/links, existingJSONunchanged — Task8lostACKlinkfallback needs stable real produceridentity — costifwrong: additiveheader/clientcoordination beforeconsumer. Owner/key immutable requesthash/resultledger, independentowner/doc/FKs plusoptionalrealjobFK, exactcanonicalinputreplayreturnsame,changedinput409. Dedupeowner/normalizedsource/document/eligiblefetchjob, respectauthVersion; oldrevokedjobneverrevived. Freshsession/device links:write and Origin/CSRF/omit rules; sourceURLs/userinfo rulesunchanged. Alwayshonestlinkbeforeasyncfetch, no model/backlog. Header/response exacthandoffTask10report→Task8.

### R23

Ruling: R23 — addimmutable owner/job acquisition +explicitjob-origin capture adapter in006 — runFetchJob has durablelease notsession/device, existingingestion cannot honestly authenticateit — costifwrong: narrowinternalmigration/repository/adapter correction beforeworkerconsumer. AcquisitionpersistdistinctcaptureUUID/ingestionUUID +actualrawregisteredassetdescriptor/manifestidentity onfirstsuccessfulacquisition; retriesreuseactualbytes/identities. RegisteredrawassetFK protectsGCbeforeReaderpublicationunderexistingpublicationlock; immutableinputsandcompositeowner/doc/job/authVersionconstraints evennullableoriginfields. web_captures.fetch_job_id isorigin separatecompletionjob_id; exactlyone session/device/fetchjob origin. Keep CapturePrincipal unchanged, use assertJobLeaseCurrent onshortfinalwrites; no fakeactor/hash/job=capturealias. Readabilitypublicarticlemode in terminableworker only, thennormalclean/projection. Raw IO/resource/network/DOM/rendereroutsideTX; freshlease/auth/slot/epoch/objectavailabilityinsidefinalTX. Requestintent/manifest/capturedAt bindretainedinput, not retryoverrides. Task11claim/heartbeat/abortmonitor/lifecycledriver, runnerexposes exactdeps/signal/checks; Task9prefs/paidjobcreationremainseparate. Original001–005unchanged; no private-network productionbypass.

### R24

Ruling: R24 — newsource.metadata.language stores serverpreparedWebLanguageDecision immutably atfirstpublication; autoscheduler joinsactualeventReader/source/parse/IRSHA inshortTX — currenteventhasIDsnotlanguageanddedupmayselectdifferentretainedIR, cannotobject-readlargeIRunderlocks — costifwrong: narrowservermetadata/policyquerycorrection,no publicDTO/eventchange. Clientmanifestmetadatacannotset/overridefield. Useactualselectedimmutableversion, notretryIR/lang. Missing/malformedlegacydecision=>noauto; explicitmanualloadsvalidactualIRoutsideTXthenrecheckscurrentauth/profile/glossary/source/parsefinalTX. Completedimport/not-required Readersskipunnecessaryauto; zh/noKey/autooff/no-backlog remainfrozen. Testdedupe-selectedidentity+legacy/noopcases. Metadataadditiondoesnotmutateoldsource/IR/manifestbytes; eventshapeunchanged.

### R25

Ruling: R25 — add internal web_jobs publication_milestone integer default-1 CHECK -1..4 and nullable finalized_epoch within valid epoch/currentepoch in006 — boundedfirst/25/50/75/terminal and terminal-finalizeridempotence mustsurvivecrashes withoutobjectIOunderlocks/ambiguousartifactinference — costifwrong: narrowunreleased006/repositorycorrection. Marker+actualReaderrefscommitatomicallyafterfreshlease/terminalproof andconfirmedcheckpointidentity; no markeradvancebeforepublication. Retryretainspreviousmilestone, newepochterminalpublicationstillrunsagainstcurrentcheckpoint (oldfinalizedepochcannothideadditionalconfirmedwork). Currentactiveowner/authVersion+terminalstatus/epoch+immutablejobinput/checkpointproof recheckedafteroutside-lockrenderer; retry/newepochfencesoldfinalizer. No runningleasefabrication/profiledecrypt/modelcallforconfirmedtextfinalization. Fieldsinternalonly/publicDTO/PDF/immutablejobinputsunchanged; boundsmatchDBsafeepochs. Testscrashaftercheckpoint/beforepublish, repeatedfinalizer, retryafterterminalpartial, latefinalizerandnewerepoch/currentReaderprotection.

### R26

Ruling: R26 — boundedprocesslocalfinalizerfailurebackoff+pre-LIMITcandidateexclusion — current200mspoll retriespermanentlybadartifact andfirst10terminalrowsstarvelaterhealthyfinalizers — costifwrong: smallworker-lifecyclehelperadjustment,noschema/publicDTO/SDKretrychange. Keyjob+epoch, exponential1s→60s,max1024entries; successclears,new epochnotdelayedbyoldfailure. Excludecoolingexactjob/epochinSQLBEFORELIMIT(notjustskipfirst10afterfetch); boundedmemory/parametersandfaircontinuedcandidateaccess. Restartmayretryoncewithfreshproof, no paidmodelcallsfromfinalizer; neveroverwriteSDKnext_request_at/cooldown. KeepfullDBfrozen; implementafterrun, addfocusedbehaviorregressionpersistentlybadfrontcandidates+latergoodfinalization/nobusyloop+newepochnotblocked, thenaffectedtypes/build/targetedtestsnotbroadrepeat.

### R27

Ruling: R27 — additive session-only GET/api/v1/documents/:id/web-jobs discovery, sharedWebJobList {items:WebJob[],nextCursor:string|null} — currentSummary/DescriptorlackjobID/onlyGETbyID, reload/crossdevicecannotdiscoveracceptedautojobforrequiredcontrols — costifwrong: narrowadditiveAPI/queryconsumeradjustment,no Summary/Descriptorwiden. Queryoptional sourceVersionId UUID,parseId existingparseIdSchema(requires sourceVersionId),limit default10/max50/min1,cursor UUID. Unfilteredincludesfetch+translate,source/parsefiltersauthorizedregisteredversions. Ownerfromsession/adminownonly/deviceblocked; nonowner/nonWebdocorwrongsourceparse404; invalidcursorformatorscope400INVALID_REQUEST. Immutablecreated_atDESC,idDESC keyset, cursor belongsowner/doc/filterandDBcomparesactualcursorrowtimestamps(no JSDateprecisionloss); limit+1bounded andnextCursorlastreturnedIDonlywhenmore. Purelist/no profiledecrypt/model/jobmutation/enqueue/finalization/backlog. ExistingWebJobwhitelistonly, no secrets/leases. Addruntime+portablecontracts/tests andservicebehavior:pagebounds/ties/reload/filter/nojob/device/otherowner/no modelsorjobcreation. Readerusesopenedsource/parsefortranslatehistory andunfilteredfetchwhenlinkonly; no inventedsessionfakes/routes.

### R28

Ruling: R28 — standardintegrationfileParallelismfalse/isolationretained +fixtureboundednullableclaimpoll — faileddefaultparallelDB238/251with9timeouts/4nullTypeErrors; unchangedserialpub+bundle33/33in98.66s plusactualglobalPGadvisorylocksandnullableSKIPLOCKEDcontractsupportharnesscorrection — costifwrong: slowerintegrationdefault/revisitfixtureisolation, no productionbehaviorchange. Keepallassertiontimeouts/productionlease+concurrency/monitorsunchanged; explicitindependentworker/concurrenttestsremain. PreservefailedfullDB+unhandledrawand33caseprobeasprobeNOTfullgreen. Newcompletechecksite mandatory; ci/checkprecedeonly2testharnesschanges, runtime/shared/staticunchangedandservice typesPASS; inventorymustshowexact2harnessdeltas/no runtimechange, honestcommandchronology ratherthanunnecessaryfullrootrepeat.

### R29

Ruling: R29 — optional UUID requestId on CreateWebJobRequest identifies ONE explicit manual start action, separate from source/cache semantics — same-settings retranslation must create newrun while replayofoneaction staysidempotent (design158/plan163) — costifwrong: narrowrequest/unreleased006/repository/publication/UIadjustment. Siteexplicitstart generatesnewrequestIdperdeliberateaction, retainsitandcanonicalpayloadacrossuncertain/failedACKretry; clearonlyafteracceptedresult, scope/inputchangeorexplicitnewaction. NewmanualrequestIDscreateindependentjobswithsameboundsource/parse/provider/glossary/lang/selection, validSDKcachemayreuse/no globalcachebypass. AbsentrequestIdkeepslegacy/automaticcanonicaldedupeandEXACToldidentityencoding(omitfieldratherthannull). Persistnullableimmutableweb_jobs.request_id, translate-only; uniqueowner/document/authVersion/requestId andinputhashbindrequestIdonlywhenpresent. Samekey+samecanonicalinputreturnsoriginaljobincludingterminal;samekeychangedinput409IDEMPOTENCY_CONFLICT,neverretargetoldjob. Replayedacceptedrequestisack/readnotresume,newworkrequirescurrentprofile/glossary; freshowner/auth/sessionalwaysenforced. ExistingWebJobDTOmayremainunchanged; worker/finalizerrecomputejob-envelopehashfromstoredrequest_id, actualIR/sourcehashandSDKcacheidentityunchanged. RetryexistingjobkeepsID/nonce/checkpoint/epochrules. Testsreplay/lostACK→onejob, deliberate2ndsameconfig→newjob/newrequestedpointer/newReaderwithcacheallowed, changedpayloadkeyconflict/configfences/crossowner/no passiveconfigbacklog/automaticdedupeunchanged.

### R30

Ruling: R30 — CSS-only inline resource variant url:null with provenance{kind:inline-style,documentUrl:HTTP(S),index:nonnegativeSafeInteger}; pending has boundedUTF8text OR missingReason, final hasactualfile/status/provenance andNOtext — inlineCSS has no honestHTTPresourceURL inoldcontract, approvedsnapshotrequiresavailableCSS — costifwrong: narrowWebCSScontracts/006ifneeded/sanitizer-fingerprint/extensionconsumeradjustment, notPDF/SDK/sourceURLchange. ExternalCSSkeepsHTTPurl andmaycarrypendingmissingReason; inlinevariantexclusivewithurlnull/provenance, imagesnevernullable. provenance.documentUrl equalsnormalizedcapturedsourceURL; collectionfromnon-pluginoriginaldocumentstyle/link nodes, source identity/styles checkedacrossasyncboundary. CaptureDraft/manifeststrictschemas+portableexportsupdatedBEFOREconsumers. Inlinebytespersistwithtrustedimmutableoriginaldraft, encodedtoactualCSSfilewithoutnetwork/hostgrant; no arbitraryURLfetch or clientcaller-byteoverride. Finalmanifestinlineprovenance bindsdoc+actualSHA/bytes/status insemanticfingerprint, no fabricatedURL/hash; source/navigationHTTP(S)andR17data/blobimage-onlypolicyunchanged. Existing16MiBresource/64MiBtotal/256files/16origins/8MiBHTML/16MiBdraftJSON/IPCceilingsapply; oversize/unavailable/unsupportedCSSexplicitmissingReason orboundedwarningwhenno representablelocator, never silentlycomplete. RawCSSarchiveattachment-only/nonexecuting; trustedpreviewneverexecutesrawCSS. Sameoriginalcaptureall3translationmodes, ownedpluginstylesexcluded; testexternal+inlinecollector→upload,denial/stale/unsupported/budget/inertness andsourcebinding. NullCSSmustnotreachgenericURL/origin/imagecodec paths.

### R31

Ruling: R31 — park scoped-review Minor N1, long-URL/near-limit CSS delivery-envelope rejection, as an explicit nonblocking follow-up; retain the 16 MiB transport ceiling and do not initiate a second final fix wave — I1/I2/I3/M1 are addressed with no new Critical/Important breakage; an actual-collector/inspected-image probe produced a 16772840-byte draft but a 16779158-byte delivery against 16777216, and the inspected background guard rejects before enqueue — cost if wrong: unusual long-URL/large-CSS-image saves remain rejected until complete-envelope budgeting and a focused boundary regression land. Chrome IPC/UI/IndexedDB rejection was not separately exercised; preserve that evidence limit.
