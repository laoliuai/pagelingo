# S3 Task 5 — pairing and capture-device authorization

Base: `ec393900639a9b7f82b82eb3a6b1ee535f11c188`. Implements device pairing/exchange, scoped internal principals, revocation, and the existing settings page's device panel. No capture upload, worker orchestration, plugin configuration upload, registration, migration, or legacy parser changes.

## Task 6 integration APIs

`apps/document-service/src/devices/guards.ts` exports:

```ts
interface DeviceActor {
  kind: 'device';
  deviceId: string;
  userId: string;
  authVersion: number;
  tokenHash: string;
  scopes: DeviceScope[];
  scope: DeviceScope;
}
type CapturePrincipal = { kind: 'session'; actor: Actor } | DeviceActor;
requireCapturePrincipal(request: FastifyRequest, scope: DeviceScope): Promise<CapturePrincipal>;
assertCapturePrincipalCurrent(client: PoolClient, principal: CapturePrincipal): Promise<void>;
```

`Actor` remains the existing authoritative auth/sessions type (`userId`, `role`, `authVersion`, `sessionHash`). Derive owner from `principal.actor.userId` for sessions, otherwise `principal.userId`; never accept owner, principal, authVersion, scopes, session/device IDs or token hashes from JSON. `DeviceActor` is internal and must not be serialized. Its `scope` records the requested authorization; final validation checks that scope against the current device row, rather than trusting the snapshot `scopes` array.

Use `requireCapturePrincipal(request, 'captures:write' | 'captures:read' | 'links:write' | 'preferences:read')` at the appropriate HTTP boundary. Cookie writes retain the existing Origin and CSRF checks. Any Authorization header, including empty/malformed/unknown credentials, selects device authentication and cannot fall back to Cookie. Existing session-only APIs reject Authorization through `readSession`, including provider, admin, library, Reader, and original files.

Before each mutation and after external/object-store work, call `assertCapturePrincipalCurrent` **inside the short transaction that writes the reference**, before capture/document locks. It locks user -> session/device and revalidates active status, authVersion, current credential, real-clock expiry, revocation and the original requested scope. Never rely on request authentication for a delayed file/publication commit. The existing session guard now also locks its session and checks `clock_timestamp()`, fixing a reproduced transaction-start-time expiry bypass. Heavy I/O and projection must remain outside these transactions. Task 6 still owns real file/commit routes; the tests here exercise their shared authorization boundary with a real transactional document insert.

`apps/document-service/src/devices/service.ts` exports `createDevicesService(db: Database)` with:

```ts
createPairingCode(actor: Actor): Promise<PairingCode>;
exchange(input: DeviceExchangeRequest, ip: string): Promise<DeviceExchangeResult>;
list(actor: Actor): Promise<DeviceList>;
revoke(actor: Actor, deviceId: string): Promise<void>;
```

`registerDevicesRoutes(app)` is wired in createApp. Pairing creation and successful exchange return 201; list returns `{items: DeviceDTO[]}`; revoke returns 204, idempotently for an owned device. Other-owner/missing IDs return 404. Exchange ignores Cookie identity and rejects client authorization/owner fields via the existing strict contract. It returns only `{token, device, owner:{id,username}, siteId}`. Lists expose only the five DeviceDTO fields.

Pairing codes and tokens each use 32 cryptographically random bytes encoded base64url; only SHA256 hashes are stored. Codes expire after five DB-clock minutes and are consumed atomically once after user/session revalidation. Devices expire after **30 DB-clock days** and receive exactly the four allowed scopes. `siteId` comes from the existing persisted site_metadata singleton. Creation quota is five per owner/minute; exchange quota is 30 per IP/minute, shared through rate_limit_windows, committed before validation/consumption so rejected attempts count. Rate-limit errors return Retry-After. Errors and logs expose no token, pairing code, provider Key or DB row.

## Revocation and background jobs

- Ordinary logout revokes only devices paired by that cookie session, then deletes that session. Other sessions/devices remain usable, and user authVersion stays unchanged.
- Natural session expiry or cleanup does not revoke paired devices. Pairing exchange nevertheless requires the original session to still be current when consumed.
- All-devices logout, password change/reset, and disable explicitly mark all the owner's devices revoked; the existing authVersion increment remains the authoritative fence. Enable never revives old credentials.
- Existing accepted jobs remain independent of ordinary logout and paired-device revocation. A real fetch-job lease regression confirms it stays current after logout, then fails after allDevices changes authVersion. No job state is tied to a cookie session or device credential.

## Validation evidence

RED/GREEN cycles (all commands from the isolated worktree, disposable DB/site runners only):

1. `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/devices.test.ts`: initial **5 failed** with missing routes (404 instead of 201); after implementation **5 passed**. Covered exchange race/reuse (`secondExchange.statusCode === 401`), five-minute expiry, expired/revoked sessions, creation/exchange quotas, safe owner listing and `otherOwner.statusCode === 404`, Origin/CSRF, and Authorization/Cookie handling.
2. Extended same command: **9 failed / 5 passed** before the capture guard existed; after guard/revocation implementation **14 passed**, 18.68s. Added scopes/owner isolation, natural expiry/cleanup, ordinary logout, and authenticated delayed writes across revoke/logout/allDevices/password/reset/disable. An initial test-only route spelling treated `:` as a Fastify parameter; corrected before the recorded behavior RED run.
3. `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/devices.test.ts -t 'current clock'`: RED **1 failed / 14 skipped** (expired session transaction unexpectedly resolved); GREEN **1 passed / 14 skipped**, 6.16s, after clock_timestamp/session-lock fix.
4. `npm run test:site:e2e -- devices.test.ts`: RED **1 failed**, missing accessible device panel; GREEN **1 passed**, 6.2s. The real browser generates a code, exchanges it without cookies, checks second exchange 401, reloads the safe device list, revokes through the confirmation UI, checks persistence/no token or code storage, and verifies zero model calls.

Final checks:

- `npm run typecheck --workspace @pagelingo/document-service`: PASS.
- `npm run typecheck --workspace @pagelingo/web`: PASS.
- `npm run test --workspace @pagelingo/document-service`: **107 passed / 10 files**, 11.34s.
- `npm run test:site:e2e -- devices.test.ts accounts.test.ts account-isolation.test.ts`: build:site PASS, **12 browser tests passed**, 1.3m. Includes account isolation/switching, provider settings, logout failure retries and existing theme/accessibility behavior.
- Full service integration: `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service` — **166 passed / 4 failed**, 142.42s (`/tmp/pgl-task5-db-final.log`). All **18 device tests passed**. This run overlapped the final browser build/12 e2e cases and the unit/typecheck run. Four existing tests reached the unchanged 15-second limit: reader-progress's `uses document-wide CAS and retains per-version history without writes on opening/restoring` (15.135s), and bundle-imports' `attaches to the uploaded original, stores all bundle files and generated chunks, and directly creates a document` (15.150s), `is idempotent by request and package and never moves current back to an older package` (15.096s), and `preserves successful current after partial and failed retranslations but exposes the first partial version` (15.164s). The reader timeout also caused an ENOTEMPTY cleanup error. No assertion/auth/constraint failures were reported.
- Isolated investigation: `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/reader-progress.test.ts tests/integration/bundle-imports.test.ts --maxWorkers=1 -t 'uses document-wide CAS|attaches to the uploaded original|is idempotent by request and package|preserves successful current'` — **4 passed / 22 skipped**, 27.02s, exit 0 (`/tmp/pgl-task5-timeout-isolated.log`), without browser/unit load. All application guard paths were inspected: user locking precedes session locking and work-row locking; cleanup deletes sessions without subsequently acquiring user locks. No wait-order inversion was found. Passing isolation plus concurrent build/browser workload supports resource contention as an inference, rather than proving its exact bottleneck. No production behavior or timeout was changed to address these failures.
- Clean serial full-suite follow-up: `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- --maxWorkers=1` — **170 passed / 11 files**, 338.52s, exit 0 (`/tmp/pgl-task5-db-serial-final.log`), with unchanged timeouts. No browser/unit/build work from this task overlapped it. This was not an exclusive host: read-only process inspection observed an unrelated Vitest runner during the serial run; no unrelated process was touched. This full run preceded the final TTL-only amendment described below.
- `git diff --check`: PASS before final report/commit.

Additional integration assertions cover strict owner/scope rejection, cookie-independent exchange identity, stable siteId across app instances, current-scope revalidation before writes, and accepted-job logout independence.

Final TTL amendment: while the serial full suite was running, the controller identified approved plan §1's **30-day** device-token default, which had been omitted from the extracted task brief, and updated the brief/constraints. Production/tests stayed frozen until that run completed. Added `expires issued device credentials after 30 days`; `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/devices.test.ts -t '30 days'` was RED (**1 failed / 18 skipped**, 1.90s): stored lifetime 7,776,000,003ms exceeded the 30-day bound 2,592,001,000ms (`/tmp/pgl-task5-ttl-red.log`). Changed only the issuance SQL interval from 90 to 30 days. GREEN: `node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/devices.test.ts` — **19 passed**, 21.65s, exit 0 (`/tmp/pgl-task5-devices-final.log`). Both service/web typechecks passed again. `npm run test:site:e2e -- devices.test.ts` rebuilt the final service/site successfully and passed **1 real browser test**, 7.4s, exit 0 (`/tmp/pgl-task5-web-ttl-final.log`). All three screenshots were refreshed and visually inspected with the corrected 30-day expiry. No further broad suite was run for this constant-only amendment, as agreed with the controller. Task 13 retains final integration across the completed S3 implementation.

Screenshots were visually inspected and copied to `docs/superpowers/specs/assets/2026-10-27-s3-validation/devices-{desktop,mobile,dark}.png`. The narrow view is 390 px wide; body overflow is checked. Dark mode uses the actual UI theme button. Screenshots contain disposable test device metadata, no credentials.

## Files and remaining integration obligations

New service `devices/{service,routes,guards}.ts`; existing `devices/repository.ts` adds owner revocation. Existing app/auth routes/session lookup/session guard and users service wire revocation/security. New web `features/settings/devices-panel.{tsx,css}` is mounted in provider-page.tsx and uses existing components/tokens, account-scoped query cache, ephemeral code state and expiry clearing. New service integration/browser tests and three screenshots accompany this report.

No migration, original output, model, credential or generated renderer edits. No subagents, merge, push or unrelated process stops. Task 4's existing full-suite PDF timeout case passed in the clean serial full suite; no test timeout was increased. No known remaining functional concern. Independent review by the controller and Task 13's final integrated validation remain required.
