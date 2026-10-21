# Honest plan traceability and acceptance evidence

Snapshot: 2026-10-21. Source: provided development plan v1.0. Every original task (76) and case (59) is listed; **this is not a claim that all passed**. IMPLEMENTED-DEMO means only the specified synthetic behavior has executable evidence. PARTIAL means narrower implementation/evidence than the full plan. EXTERNAL means supplier/owner/live prerequisites or unimplemented live behavior remain. Full production G0–G4 acceptance is NOT achieved.

## Executed evidence

`npm test` was run in this workspace on 2026-10-21: 63 tests, 63 passed, 0 failed, 0 skipped (Node built-in runner). Files: tests/domain.test.mjs, tests/api.test.mjs, tests/reviewer-safety.test.mjs, tests/storage.test.mjs, tests/adapters.test.mjs, tests/scenarios.test.mjs. Count is a snapshot, not 59 plan cases. Actual SQLite/WAL-compatible schema and CAS adapter are tested via Node SQLite; neither deployed D1 service behavior nor PostgreSQL was tested by this run. The test whose title mentions malformed JSON only asserts disabled webhooks, so that title is not taken as malformed-JSON evidence. Browser screenshots, hosted readiness and live link verification belong to release evidence supplied separately by the publishing owner.

## 76 development tasks

| ID | Original task | Status | Artifact/evidence | Remaining gap |
|---|---|---|---|---|
| P0.1 | 整理用户旅程 | PARTIAL | docs/DOMAIN.md, docs/INTEGRATIONS.md | TEST rules only; owner decisions and G0 review not signed. |
| P0.2 | 决定 D01、D05 至 D08、D16 | PARTIAL | docs/DOMAIN.md, docs/INTEGRATIONS.md | TEST rules only; owner decisions and G0 review not signed. |
| P0.3 | 建立服务商核验表 | PARTIAL | docs/DOMAIN.md, docs/INTEGRATIONS.md | TEST rules only; owner decisions and G0 review not signed. |
| P0.4 | 分解 MVP | PARTIAL | docs/DOMAIN.md, docs/INTEGRATIONS.md | TEST rules only; owner decisions and G0 review not signed. |
| P0.5 | 确定事件及时间语义 | PARTIAL | docs/DOMAIN.md, docs/INTEGRATIONS.md | TEST rules only; owner decisions and G0 review not signed. |
| P0.6 | 完成 G0 评审 | PARTIAL | docs/DOMAIN.md, docs/INTEGRATIONS.md | TEST rules only; owner decisions and G0 review not signed. |
| P1.1 | 建立代码结构 | PARTIAL | README.md, docs/ADR-001-demo-architecture.md, docs/RUNBOOK.md | Alternative demo structure; no full production CI, pinned toolchain, environment/security approval or restore drill. |
| P1.2 | 锁定工具链 | PARTIAL | README.md, docs/ADR-001-demo-architecture.md, docs/RUNBOOK.md | Alternative demo structure; no full production CI, pinned toolchain, environment/security approval or restore drill. |
| P1.3 | 区分环境 | PARTIAL | README.md, docs/ADR-001-demo-architecture.md, docs/RUNBOOK.md | Alternative demo structure; no full production CI, pinned toolchain, environment/security approval or restore drill. |
| P1.4 | 建立秘密及会话策略 | PARTIAL | README.md, docs/ADR-001-demo-architecture.md, docs/RUNBOOK.md | Alternative demo structure; no full production CI, pinned toolchain, environment/security approval or restore drill. |
| P1.5 | 定义备份与迁移约定 | PARTIAL | README.md, docs/ADR-001-demo-architecture.md, docs/RUNBOOK.md | Alternative demo structure; no full production CI, pinned toolchain, environment/security approval or restore drill. |
| P2.1 | 完成第 6 章数据字典 | PARTIAL | src/domain.mjs, src/api.mjs, src/store.mjs, docs/API.md, docs/production-schema.sql | CAS demo constraints and contract implemented; normalized SQL is undeployed reference; no full OpenAPI/client or PostgreSQL integration. |
| P2.2 | 完成第 7 章 OpenAPI | PARTIAL | src/domain.mjs, src/api.mjs, src/store.mjs, docs/API.md, docs/production-schema.sql | CAS demo constraints and contract implemented; normalized SQL is undeployed reference; no full OpenAPI/client or PostgreSQL integration. |
| P2.3 | 完成第 5 章状态机 | PARTIAL | src/domain.mjs, src/api.mjs, src/store.mjs, docs/API.md, docs/production-schema.sql | CAS demo constraints and contract implemented; normalized SQL is undeployed reference; no full OpenAPI/client or PostgreSQL integration. |
| P2.4 | 建立事件信封 | PARTIAL | src/domain.mjs, src/api.mjs, src/store.mjs, docs/API.md, docs/production-schema.sql | CAS demo constraints and contract implemented; normalized SQL is undeployed reference; no full OpenAPI/client or PostgreSQL integration. |
| P2.5 | 定义 outbox、inbox 与幂等存储 | PARTIAL | src/domain.mjs, src/api.mjs, src/store.mjs, docs/API.md, docs/production-schema.sql | CAS demo constraints and contract implemented; normalized SQL is undeployed reference; no full OpenAPI/client or PostgreSQL integration. |
| P2.6 | 开展并发约束测试 | PARTIAL | src/domain.mjs, src/api.mjs, src/store.mjs, docs/API.md, docs/production-schema.sql | CAS demo constraints and contract implemented; normalized SQL is undeployed reference; no full OpenAPI/client or PostgreSQL integration. |
| P3.1 | 实现 Auth mock | PARTIAL | src/domain.mjs, tests/domain.test.mjs | Deterministic mock actions cover selected scenarios, not all token/event/sequence/capability variants. |
| P3.2 | 实现 Payment mock | PARTIAL | src/domain.mjs, tests/domain.test.mjs | Deterministic mock actions cover selected scenarios, not all token/event/sequence/capability variants. |
| P3.3 | 实现 Device mock | PARTIAL | src/domain.mjs, tests/domain.test.mjs | Deterministic mock actions cover selected scenarios, not all token/event/sequence/capability variants. |
| P3.4 | 实现可控时钟和故障注入 | PARTIAL | src/domain.mjs, tests/domain.test.mjs | Deterministic mock actions cover selected scenarios, not all token/event/sequence/capability variants. |
| P3.5 | 建立演示数据集 | PARTIAL | src/domain.mjs, tests/domain.test.mjs | Deterministic mock actions cover selected scenarios, not all token/event/sequence/capability variants. |
| P4.1 | 建立设计 token 和组件 | PARTIAL | public/app.js, public/style.css, public/index.html | Nine-screen walkthrough and demo controls; full real-device/a11y/network matrix not yet independently accepted. |
| P4.2 | 建立路由和登录恢复 | PARTIAL | public/app.js, public/style.css, public/index.html | Nine-screen walkthrough and demo controls; full real-device/a11y/network matrix not yet independently accepted. |
| P4.3 | 实现扫描及输入 | PARTIAL | public/app.js, public/style.css, public/index.html | Nine-screen walkthrough and demo controls; full real-device/a11y/network matrix not yet independently accepted. |
| P4.4 | 按第 8 章实现九个页面及状态 | PARTIAL | public/app.js, public/style.css, public/index.html | Nine-screen walkthrough and demo controls; full real-device/a11y/network matrix not yet independently accepted. |
| P4.5 | 建立英语文案与无障碍检查 | PARTIAL | public/app.js, public/style.css, public/index.html | Nine-screen walkthrough and demo controls; full real-device/a11y/network matrix not yet independently accepted. |
| P4.6 | 处理移动浏览器兼容 | PARTIAL | public/app.js, public/style.css, public/index.html | Nine-screen walkthrough and demo controls; full real-device/a11y/network matrix not yet independently accepted. |
| P5.1 | 建立用户及第三方身份模型 | PARTIAL | src/api.mjs, src/domain.mjs, tests/api.test.mjs, tests/reviewer-safety.test.mjs | Synthetic identity, request protection and ownership only; production OAuth/admin authentication/revocation/deletion unimplemented. |
| P5.2 | 实现服务端票据验证与会话 | PARTIAL | src/api.mjs, src/domain.mjs, tests/api.test.mjs, tests/reviewer-safety.test.mjs | Synthetic identity, request protection and ownership only; production OAuth/admin authentication/revocation/deletion unimplemented. |
| P5.3 | 首次登录自动建户 | PARTIAL | src/api.mjs, src/domain.mjs, tests/api.test.mjs, tests/reviewer-safety.test.mjs | Synthetic identity, request protection and ownership only; production OAuth/admin authentication/revocation/deletion unimplemented. |
| P5.4 | 处理关联与恢复 | PARTIAL | src/api.mjs, src/domain.mjs, tests/api.test.mjs, tests/reviewer-safety.test.mjs | Synthetic identity, request protection and ownership only; production OAuth/admin authentication/revocation/deletion unimplemented. |
| P5.5 | 实现用户与后台权限 | PARTIAL | src/api.mjs, src/domain.mjs, tests/api.test.mjs, tests/reviewer-safety.test.mjs | Synthetic identity, request protection and ownership only; production OAuth/admin authentication/revocation/deletion unimplemented. |
| P5.6 | 设计账户删除和数据保留 | PARTIAL | src/api.mjs, src/domain.mjs, tests/api.test.mjs, tests/reviewer-safety.test.mjs | Synthetic identity, request protection and ownership only; production OAuth/admin authentication/revocation/deletion unimplemented. |
| P6.1 | 解析站点及柜机码 | PARTIAL | src/domain.mjs, tests/domain.test.mjs, tests/storage.test.mjs | Server-owned quote/reservation/money/command mock; real provider evidence and distributed worker unavailable. |
| P6.2 | 报价并创建租借 | PARTIAL | src/domain.mjs, tests/domain.test.mjs, tests/storage.test.mjs | Server-owned quote/reservation/money/command mock; real provider evidence and distributed worker unavailable. |
| P6.3 | 创建资金操作 | PARTIAL | src/domain.mjs, tests/domain.test.mjs, tests/storage.test.mjs | Server-owned quote/reservation/money/command mock; real provider evidence and distributed worker unavailable. |
| P6.4 | 确认资金准备就绪 | PARTIAL | src/domain.mjs, tests/domain.test.mjs, tests/storage.test.mjs | Server-owned quote/reservation/money/command mock; real provider evidence and distributed worker unavailable. |
| P6.5 | 安全提交弹出操作 | PARTIAL | src/domain.mjs, tests/domain.test.mjs, tests/storage.test.mjs | Server-owned quote/reservation/money/command mock; real provider evidence and distributed worker unavailable. |
| P6.6 | 确认起租及取宝异常 | PARTIAL | src/domain.mjs, tests/domain.test.mjs, tests/storage.test.mjs | Server-owned quote/reservation/money/command mock; real provider evidence and distributed worker unavailable. |
| P6.7 | 提供活动租借恢复 | PARTIAL | src/domain.mjs, tests/domain.test.mjs, tests/storage.test.mjs | Server-owned quote/reservation/money/command mock; real provider evidence and distributed worker unavailable. |
| P7.1 | 识别归还 | PARTIAL | src/domain.mjs, public/app.js, tests/domain.test.mjs | Return/bill/refund/history/operator demo implemented; not all evidence, settlement, audit or recovery criteria met. |
| P7.2 | 计算最终账单 | PARTIAL | src/domain.mjs, public/app.js, tests/domain.test.mjs | Return/bill/refund/history/operator demo implemented; not all evidence, settlement, audit or recovery criteria met. |
| P7.3 | 执行结算和补偿 | PARTIAL | src/domain.mjs, public/app.js, tests/domain.test.mjs | Return/bill/refund/history/operator demo implemented; not all evidence, settlement, audit or recovery criteria met. |
| P7.4 | 实现历史与详情 | PARTIAL | src/domain.mjs, public/app.js, tests/domain.test.mjs | Return/bill/refund/history/operator demo implemented; not all evidence, settlement, audit or recovery criteria met. |
| P7.5 | 实现后台与审计 | PARTIAL | src/domain.mjs, public/app.js, tests/domain.test.mjs | Return/bill/refund/history/operator demo implemented; not all evidence, settlement, audit or recovery criteria met. |
| P7.6 | 完成 M1 演示及恢复测试 | PARTIAL | src/domain.mjs, public/app.js, tests/domain.test.mjs | Return/bill/refund/history/operator demo implemented; not all evidence, settlement, audit or recovery criteria met. |
| P8.1 | 核对官方前置条件 | EXTERNAL | docs/INTEGRATIONS.md | Requires official identity setup, credentials authorized by owner, real callback implementation and device acceptance. |
| P8.2 | 配置测试与生产隔离 | EXTERNAL | docs/INTEGRATIONS.md | Requires official identity setup, credentials authorized by owner, real callback implementation and device acceptance. |
| P8.3 | 接入真实回调 | EXTERNAL | docs/INTEGRATIONS.md | Requires official identity setup, credentials authorized by owner, real callback implementation and device acceptance. |
| P8.4 | 处理供应商资料特性 | EXTERNAL | docs/INTEGRATIONS.md | Requires official identity setup, credentials authorized by owner, real callback implementation and device acceptance. |
| P8.5 | 真机与受限环境验收 | EXTERNAL | docs/INTEGRATIONS.md | Requires official identity setup, credentials authorized by owner, real callback implementation and device acceptance. |
| P9.1 | 核验准确产品及文档 | EXTERNAL | docs/INTEGRATIONS.md | PVS identity/docs/merchant capability unverified; no real payment integration or sandbox report. |
| P9.2 | 实现托管或令牌化支付 | EXTERNAL | docs/INTEGRATIONS.md | PVS identity/docs/merchant capability unverified; no real payment integration or sandbox report. |
| P9.3 | 实现 webhook 及查单 | EXTERNAL | docs/INTEGRATIONS.md | PVS identity/docs/merchant capability unverified; no real payment integration or sandbox report. |
| P9.4 | 接入资金动作 | EXTERNAL | docs/INTEGRATIONS.md | PVS identity/docs/merchant capability unverified; no real payment integration or sandbox report. |
| P9.5 | 建立三方对账 | EXTERNAL | docs/INTEGRATIONS.md | PVS identity/docs/merchant capability unverified; no real payment integration or sandbox report. |
| P9.6 | 完成各工具沙箱矩阵 | EXTERNAL | docs/INTEGRATIONS.md | PVS identity/docs/merchant capability unverified; no real payment integration or sandbox report. |
| P10.1 | 登记真实资产 | EXTERNAL | docs/INTEGRATIONS.md | Supplier, hardware, protocol and lab acceptance missing; simulation is not hardware evidence. |
| P10.2 | 接入认证及心跳 | EXTERNAL | docs/INTEGRATIONS.md | Supplier, hardware, protocol and lab acceptance missing; simulation is not hardware evidence. |
| P10.3 | 验证弹出语义 | EXTERNAL | docs/INTEGRATIONS.md | Supplier, hardware, protocol and lab acceptance missing; simulation is not hardware evidence. |
| P10.4 | 验证归还证据 | EXTERNAL | docs/INTEGRATIONS.md | Supplier, hardware, protocol and lab acceptance missing; simulation is not hardware evidence. |
| P10.5 | 校准计费权威 | EXTERNAL | docs/INTEGRATIONS.md | Supplier, hardware, protocol and lab acceptance missing; simulation is not hardware evidence. |
| P10.6 | 联合实验室端到端测试 | EXTERNAL | docs/INTEGRATIONS.md | Supplier, hardware, protocol and lab acceptance missing; simulation is not hardware evidence. |
| P11.1 | 执行完整回归 | PARTIAL | tests/*.test.mjs, docs/RUNBOOK.md, docs/TRACEABILITY.md | Local regression and runbook only; full security/load/restore/real-device/content acceptance outstanding. |
| P11.2 | 执行并发与压力测试 | PARTIAL | tests/*.test.mjs, docs/RUNBOOK.md, docs/TRACEABILITY.md | Local regression and runbook only; full security/load/restore/real-device/content acceptance outstanding. |
| P11.3 | 执行安全检查 | PARTIAL | tests/*.test.mjs, docs/RUNBOOK.md, docs/TRACEABILITY.md | Local regression and runbook only; full security/load/restore/real-device/content acceptance outstanding. |
| P11.4 | 验证备份恢复与部署回滚 | PARTIAL | tests/*.test.mjs, docs/RUNBOOK.md, docs/TRACEABILITY.md | Local regression and runbook only; full security/load/restore/real-device/content acceptance outstanding. |
| P11.5 | 准备运营流程 | PARTIAL | tests/*.test.mjs, docs/RUNBOOK.md, docs/TRACEABILITY.md | Local regression and runbook only; full security/load/restore/real-device/content acceptance outstanding. |
| P11.6 | 审核用户可见内容 | PARTIAL | tests/*.test.mjs, docs/RUNBOOK.md, docs/TRACEABILITY.md | Local regression and runbook only; full security/load/restore/real-device/content acceptance outstanding. |
| P12.1 | 进行上线前评审 | EXTERNAL | docs/INTEGRATIONS.md, docs/RUNBOOK.md | No live pilot, real settlement verification, Go approval or signed handoff. |
| P12.2 | 最小规模发布 | EXTERNAL | docs/INTEGRATIONS.md, docs/RUNBOOK.md | No live pilot, real settlement verification, Go approval or signed handoff. |
| P12.3 | 验证真实资金与实物 | EXTERNAL | docs/INTEGRATIONS.md, docs/RUNBOOK.md | No live pilot, real settlement verification, Go approval or signed handoff. |
| P12.4 | 监控并执行止损 | EXTERNAL | docs/INTEGRATIONS.md, docs/RUNBOOK.md | No live pilot, real settlement verification, Go approval or signed handoff. |
| P12.5 | 决定扩大或回退 | EXTERNAL | docs/INTEGRATIONS.md, docs/RUNBOOK.md | No live pilot, real settlement verification, Go approval or signed handoff. |
| P12.6 | 完成交接 | EXTERNAL | docs/INTEGRATIONS.md, docs/RUNBOOK.md | No live pilot, real settlement verification, Go approval or signed handoff. |

## 59 acceptance cases

| ID | Priority | Original scenario | Status | Evidence | Limitation |
|---|---|---|---|---|---|
| A01 | P0 | Apple 首次及再次登录 | PARTIAL | domain stable provider identity test | Synthetic subject only; no Apple token/first-profile behavior. |
| A02 | P0 | Google 首次及再次登录 | PARTIAL | domain stable provider identity test | Synthetic subject only; no Google verification. |
| A03 | P0 | 错误签名、aud、iss、过期及重放 token | EXTERNAL | Real auth disabled | Invalid signatures/audience/issuer/replay require authentic adapter tests. |
| A04 | P0 | Apple 隐藏邮箱及跨提供方相同邮箱 | PARTIAL | domain no email merge test | Providers separated; Hide My Email and dual-identity recovery not integrated. |
| A05 | P0 | A 用户请求 B 订单或退款 | IMPLEMENTED-DEMO | domain ownership; reviewer identity-switch replay and support isolation tests | Demo ownership tested; production identities still external. |
| A06 | P1 | 取消登录、弹窗受阻、Cookie 限制 | PARTIAL | login cancelled scenario | No real popup/cookie-restriction suite. |
| Q01 | P0 | QR 被替换、非官方链接、伪造柜码 | PARTIAL | resolve action in src/domain.mjs | Manual/same-origin code validation; full revocable QR protocol pending. |
| Q02 | P1 | 摄像头拒绝或不支持 | PARTIAL | public/app.js manual-code flow | Browser camera fallback requires device verification. |
| Q03 | P0 | 柜机离线、库存过期或无可租电池 | PARTIAL | domain offline station test | No stale-inventory TTL gate. |
| Q04 | P0 | 两用户同时抢一块电池 | IMPLEMENTED-DEMO | storage one-bank CAS contention test | Real SQLite adapter; not deployed D1 load or PostgreSQL locking. |
| Q05 | P0 | 同一用户双击、双标签并发租借 | IMPLEMENTED-DEMO | domain duplicate-active and concurrent MemoryStore tests | One-rental rule within synthetic workspace. |
| Q06 | P0 | 报价、预留、支付会话分别到期 | PARTIAL | domain expired quote and late-payment tests | No independent real checkout session expiry. |
| P01 | P0 | 每个目标支付工具成功 | EXTERNAL | mock methods only | Every real target instrument requires sandbox and merchant evidence. |
| P02 | P0 | 仅浏览器回跳显示 success | PARTIAL | no browser success callback route; server mock action | No live checkout callback acceptance test. |
| P03 | P0 | 支付拒绝、取消及挑战未完成 | PARTIAL | domain declined-payment test | Challenge/cancel provider semantics absent. |
| P04 | P0 | webhook 重复 20 次和乱序 | PARTIAL | reviewer 20 duplicate requests; adapters 20 signed fixture events | Mock request/event dedupe tested; not real provider event ordering. |
| P05 | P0 | 伪造、错误签名或重放通知 | PARTIAL | adapters signed fixture rejects bad signature/amount/currency/merchant | Fixture protocol is not PVS; live ingress remains disabled. |
| P06 | P0 | 支付成功但通知丢失 | PARTIAL | domain pending/unknown query tests; drainJobs | Simulated query recovery, not real lost notification. |
| P07 | P0 | API 超时但实际扣款成功 | PARTIAL | domain unknown query test | No real remote-success/local-timeout injection. |
| P08 | P0 | 预留过期后支付迟到成功 | IMPLEMENTED-DEMO | domain late-payment compensation test | Late simulated payment refunds rather than dispensing. |
| P09 | P0 | 工具不支持部分退款或预授权 | IMPLEMENTED-DEMO | adapters unsupported partialRefund guard test | MOCK capability only; real merchant matrix unverified. |
| P10 | P0 | 授权到期、金额超过可捕获或可退额 | PARTIAL | adapters refund bound and unsupported authorization test | No real capture/authorization expiry or concurrent monetary limit suite. |
| D01 | P0 | 正常弹出及可信起租证据 | PARTIAL | API journey; domain collection | Start comes from server simulator, not trusted hardware. |
| D02 | P0 | ACK 到达但无弹出或取走证据 | IMPLEMENTED-DEMO | domain acknowledgement-not-start test | ACK does not start billing. |
| D03 | P0 | 弹出已执行但响应丢失 | PARTIAL | domain UNKNOWN quarantine test | No hardware response-loss evidence. |
| D04 | P0 | 未知弹出时预留期限届满 | IMPLEMENTED-DEMO | domain UNKNOWN quarantine test | Unknown remains locked after clock advance; original command reused. |
| D05 | P0 | 支付成功但确定卡槽失败 | IMPLEMENTED-DEMO | domain known-jam refund test | No rental fee, full synthetic refund obligation. |
| D06 | P0 | Worker 发送后崩溃并重启 | PARTIAL | state recreation; durable mock refund test | No actual external send/crash/query recovery. |
| D07 | P1 | 电池未取走或被柜收回 | PARTIAL | collect not_taken scenario | No supplier takeback evidence or real test. |
| D08 | P0 | 电池 A 租出后电池 B 归还 A 的原槽 | IMPLEMENTED-DEMO | reviewer bank B into bank A origin slot test | A remains active; B can be rented from A former slot. |
| R01 | P0 | 同柜及跨柜正常归还 | PARTIAL | domain and API cross-station return | Real same/cross-cabinet event authentication not available. |
| R02 | P0 | 用户点击已归还但无硬件证据 | IMPLEMENTED-DEMO | domain support report never ends rental test | Report action does not set returned. |
| R03 | P0 | 另一块电池、缺序列或不明 ID | PARTIAL | domain wrong-bank test | Missing sequence and untrusted identifiers need adapter validation. |
| R04 | P0 | 重复归还、重插和乱序旧事件 | PARTIAL | domain duplicate return test | No arbitrary old-event/sequence ingestion pipeline. |
| R05 | P0 | 离线已还，之后才收到通知 | PARTIAL | domain offline occurrence test | Fixed 15-minute fixture, not validated signed device clock. |
| R06 | P0 | 设备时间漂移或不可信 | IMPLEMENTED-DEMO | scenarios drift billing-hold/quarantine test | Synthetic untrusted time; actual device clock verification external. |
| R07 | P0 | 已归还但电池损坏 | IMPLEMENTED-DEMO | scenarios damaged-return/no damage debit test | Damage assessment/real supplier evidence remains external. |
| R08 | P1 | 满槽、关店、离线站点 | PARTIAL | station offline/full guards; list UI | Opening hours not an enforced real schedule. |
| R09 | P0 | 归还事件先于延迟起租事件到达 | IMPLEMENTED-DEMO | scenarios out-of-order return/original command test | Synthetic timeline buffered/reconciled; not authentic firmware events. |
| B01 | P0 | TEST 单位 60 秒边界 0、59、60、61 秒 | IMPLEMENTED-DEMO | domain exact 0/59/60/61 boundary test | TEST arithmetic only. |
| B02 | P0 | 起租中途价格更新 | IMPLEMENTED-DEMO | domain new-pricing snapshot test | Old rental price immutable by normal pricing action. |
| B03 | P0 | 封顶前后、跨日和最长租期边界 | PARTIAL | domain cap and residual-day tests | Elapsed-day fixture, not approved local-day/free/max-rental policy. |
| B04 | P0 | 超大金额、币种混用和小数输入 | PARTIAL | domain invalid fractional money test | Integer strings and BigInt; full currency/overflow matrix not complete. |
| B05 | P0 | 押金、费用、退款及补收 | PARTIAL | domain conservation test | Deposit/fee/refund supported; extra balance is review only. |
| B06 | P0 | 部分退款、捕获或释放失败及未知 | PARTIAL | domain failed-refund cannot resume billing test | Capture/release and real UNKNOWN refunds not integrated. |
| B07 | P0 | 结算后发现早归还证据 | IMPLEMENTED-DEMO | scenarios append adjustment/preserve original billing test | Synthetic additional refund; real provider correction requires integration. |
| O01 | P0 | 人工归还或退款 | PARTIAL | domain admin reason test; return_review/refund actions | Public demo role, not production permission; full evidence tests pending. |
| O02 | P0 | 备份恢复后存在外部已成功操作 | PARTIAL | scenarios stale config restore/fence and missing-operation tests | Configuration-only mock recovery; not full DB or external-system restoration. |
| O03 | P0 | 发布回滚与旧应用读新 schema | PARTIAL | initial SQLite migration; build artifact | No old-app/new-schema rollback drill. |
| O04 | P0 | 停止新租开关 | IMPLEMENTED-DEMO | domain stop-new-rent test | Existing return still works. |
| O05 | P0 | 对账漏账、重复账、币种或金额差异 | IMPLEMENTED-DEMO | scenarios synthetic provider discrepancy tests | Mock missing/duplicate/currency/amount detection; no actual settlement file. |
| O06 | P1 | 支付或设备供应商长时不可用 | PARTIAL | drainJobs bounded retries/dead-letter | No real supplier outage or configured alert delivery. |
| U01 | P1 | 刷新、回退、重新登录及跨设备 | PARTIAL | API recreated-store journey; SQLite persistence | Cookie workspace survives refresh; not real cross-device account recovery. |
| U02 | P1 | 慢网、断网、大字体及 320px 屏幕 | PARTIAL | public responsive UI | Manual browser evidence tracked by release reviewer; no full target-device suite here. |
| U03 | P1 | 定位未授权或地图服务失败 | PARTIAL | address list fallback | Real map/location service not integrated. |
| U04 | P1 | 英文长文案与读屏键盘访问 | PARTIAL | English UI and form controls | No complete screen-reader/keyboard signoff. |
| S01 | P0 | 秘密、卡数据和完整令牌扫描 | PARTIAL | no provider keys/card forms by design | No complete repository/log/export automated secret scan evidence here. |
| S02 | P0 | CSRF、会话撤销及精确 CORS | PARTIAL | API Origin/CSRF tests | No production session rotation/revocation or complete security audit. |
| S03 | P0 | 后台共享口令或普通用户管理接口 | PARTIAL | API demo operator isolation test | Public admin simulation is explicitly not secure production authentication. |

## Release conclusion

A usable mock-enabled walkthrough is deliverable while real authentication, payment, hardware, operating decisions and production hardening remain blocked. Do not report “76 tasks complete”, “59 acceptance cases passed”, “P0 defects zero” or “ready for public commercial operation”. Any implementation changes after this snapshot require re-running tests and updating the matrix; the plan's unmet test coverage remains release-blocking for live use.

## WsCharge offline follow-on (2026-10-21)

Supplier document 6.0A has been inspected. `src/wscharge.mjs`, operator-only synthetic fixtures, offline protocol tab, strict parser tests and bundled Worker smoke implement a bounded protocol review surface. See `docs/WSCHARGE.md` for page evidence and missing transport/authentication/event semantics. Real equipment integration remains gated; status200 is not collection proof and an I66 observation does not modify rentals or money. No original supplier document is published. This addition does not convert external hardware or production tasks into completed tasks.
