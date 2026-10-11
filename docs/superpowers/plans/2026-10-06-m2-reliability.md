# M2 Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 完成 M2-B 和 M2-C，交付可安装 Chrome / Edge 扩展。
**Architecture:** Portable SDK 策略 + 注入式存储/调度；扩展负责 IDB、权限和页面会话。
**Tech Stack:** TypeScript / Zod / React / MV3 / idb / Vitest / Playwright。
**Spec:** `docs/superpowers/specs/2026-10-06-m2-reliability-design.md`

## Global Constraints

- 用户授权连续执行，无中间批准。保持密钥仅在可信配置与请求中。
- 无 Git 仓库：直接工作，保存排除密钥的基线快照与进度 ledger，不创建假分支/提交。
- 增强 SDK 可选，旧消费者兼容；不实现 M3 或格式解析器。
- 功能测试先 RED 再 GREEN；每任务验证，最终独立审查并打包。

## Review Focus

1. 恶意/损坏缓存、未知槽位与随机 ID 不进入 DOM；上下文依赖不遗漏。
2. 分片跨格式、长原子、输出截断和部分 JSON 不丢失或重复内容。
3. worker 重启、取消和迟到响应不重置尝试预算或越过 epoch 写入。
4. 跨标签页队列、长 Retry-After、慢 SSE 与取消不泄漏并发或产生无限调用。
5. IDB 版本/配额降级、权限与配置变更、ZIP 内容和说明准确。

## Task 1 — SDK 预算、分片与缓存身份

**Files:** `packages/translation-core/src/{budget,cache,concurrency}.ts`, `types.ts`, `provider.ts`, `index.ts`, `tests/reliability.test.ts`。
**Interfaces:** BudgetOptions / planUnits；TranslationCache；cacheKey / documentFingerprint / normalizeDocumentUrl；ConcurrencyScheduler.run。
- [x] 写预算、嵌套保护分片往返、key 稳定/失效与可取消队列测试；`npm run test:sdk` 预期新测试 FAIL。
- [x] 实现纯 SDK 模块，续接边界进入请求契约；预算未满足的单元显式失败。
- [x] `npm run test:sdk` 预期所有测试 PASS。

## Task 2 — Provider 时限与 SDK 可靠执行

**Files:** SDK `openai-compatible.ts`, `engine.ts`, 新 `reliable-engine.ts`, `checkpoint.ts`, tests。
**Interfaces:** 可选 generateDetailed usage；ReliabilityOptions（cache、state、scheduler、budget、identity）；Checkpoint 单元 attempt / 状态 / 结果；save(checkpoint, cacheWrites)。
- [x] 写 SSE / 首响应 / 空闲 / 总时限、部分成功、鉴权、429、截断、缓存损坏及持久化恢复的 RED 测试。
- [x] 实现有限重试、预算批次、缓存重校验、检查点先于 yield、统计和部分失败。
- [x] `npm run test:sdk && npm run test:package` 预期 PASS，旧接口保持兼容。

## Task 3 — 扩展持久化存储与配置

**Files:** `apps/extension/src/background/database.ts`, settings schema / connection，unit database tests，package manifests。
**Interfaces:** TranslationDatabase（cache / documents / jobs / atomic checkpoint / epoch / stats / clear）；public provider identity 不含 key。
- [x] 安装固定 idb / fake-indexeddb，写实际 IDB 事务与 LRU / 清理 / epoch / 失败降级 RED 测试。
- [x] 实现存储、版本、配额处理；旧设置补默认预算、stream 和缓存配置。
- [x] `npm run typecheck && npm run test:extension` 预期 PASS。

## Task 4 — MV3 恢复与 UI

**Files:** background jobs / service-worker，content background client / controller / index，shared contracts，options / popup，manifest。
**Interfaces:** persistent grants，start / resume / cancel / heartbeat，重连前 isCurrent；PageStatus metrics / partial / recovering；trusted cache management。
- [x] 写恢复/取消/幂等与配置兼容 RED 测试（单元或对应浏览器测试）。
- [x] 接入可靠引擎与数据库，队列共享，任务围栏，有界活跃保活和 alarm，页面检测与重放。
- [x] 设置预算与 SSE、缓存管理；popup 展示真实请求/缓存/失败指标。
- [x] `npm run typecheck && npm run test:extension` 预期 PASS。

## Task 5 — 浏览器与真实 API 验收

**Files:** fixture server，e2e tests，live runner，validation docs。
- [x] 写生产扩展的跨标签页并发、97/100 缓存、清理、坏块有限重试和真实 worker 终止恢复测试，先观察 FAIL。
- [x] 修复集成问题，不添加测试专用生产后门。
- [x] `npm run check` 预期全部 PASS；`npm run test:llm:extension` 真 API 翻译、缓存与恢复/模式检查 PASS。

## Task 6 — 文档、审查与安装包

**Files:** READMEs，web-spec / monorepo / m2-validation，package script，releases ZIP。
- [x] 更新 A/B/C、SDK 注入示例、默认值、限制及安装/验收步骤。
- [x] 执行 fresh reviewer（executing-plans 要求），五个重要问题 RED→GREEN 修复并完整验证；审查取舍见 `docs/m2-review.md`。
- [x] `npm run check` PASS（97 units / 1 consumer / 26 Chromium）；构建 ZIP、校验 manifest / 资源 / 无密钥，记录 hash；原样 ZIP 加载检查 PASS。
- [x] 提供 `apps/extension/dist/`、`releases/pagelingo-m2-0.2.0.zip` 与 `docs/install-m2.md` 的最终交付入口。
