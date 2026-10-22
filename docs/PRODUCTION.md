# 正式运行、更新与接入指南

## 1. 部署前保留现状

先确认旧应用目录、进程管理方式、反向代理和数据位置。不要覆盖 `.local/demo.sqlite`、旧 `.env`、上传文件或供应商资料，不要直接运行清库命令。旧演示账户不是已验证身份，不可转换为正式用户/管理员；旧支付不是财务记录，旧机柜不是实际库存。将旧数据保留在独立只读归档，不把它导入新生产库。

本版本使用新文件 `production.sqlite` 和独立表结构；初次启动创建 schema_migrations versions 1–4，重复启动不会清空数据。生产目录必须持久化，不能放在每次发布删除的临时目录。当前仅支持单个 Node 进程和单台主机 SQLite；不要开启 PM2 cluster 或多实例写同一文件。

## 2. 构建和文件布局

需要官方 Node.js 24。执行 npm ci --ignore-scripts、npm run check、npm test、npm run build、npm run verify:build。dist 是普通 Node 服务包，入口 scripts/start.mjs，不是静态网站，也不是旧 Worker。默认 npm start 与 npm run dev 均启动正式服务；npm run demo 仅保留本地状态机演示。

建议发布目录 `/opt/voltgo/releases/<version>`，current 指向已验证版本；持久库在 `/var/lib/voltgo/production.sqlite`。服务使用专用低权限系统账户，数据库目录仅该账户可读写。环境配置不放 GitHub；不要在日志、截图或聊天中展示密钥。设置权限属于服务器维护操作，应由服务器管理员执行。

## 3. 运行配置

PUBLIC_ORIGIN=https://rental.example.com
DATABASE_PATH=/var/lib/voltgo/production.sqlite
HOST=127.0.0.1
PORT=4173

PUBLIC_ORIGIN 必须是裸 origin，不带路径、用户名、查询参数。Node 服务只在回环端口提供内部 HTTP，由 HTTPS 反向代理终止 TLS；Cookie 根据配置的外部 HTTPS 设置 Secure，不根据任意 Host/X-Forwarded-* 猜测 origin。反向代理应拒绝非指定 Host，不将应用内部端口暴露公网。提供有效匹配证书，不关闭证书校验。若暂时使用 HTTPS IP，证书需包含该 IP，Google 登录仍不可启用。

本地开发可用 PUBLIC_ORIGIN=http://127.0.0.1:4173、ALLOW_LOCAL_HTTP=1，且只能绑定回环。此设置绝不可用于公网 HTTP。

可由管理员创建 systemd 服务（示例，按实际路径和用户调整）：

```ini
[Unit]
Description=voltgo rental service
After=network.target
[Service]
Type=simple
User=voltgo
Group=voltgo
WorkingDirectory=/opt/voltgo/current
EnvironmentFile=/etc/voltgo/runtime.env
ExecStart=/usr/bin/node /opt/voltgo/current/scripts/start.mjs
Restart=on-failure
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
```

不自动执行此配置，不自动重启现有服务。反向代理、证书、系统用户和服务权限由用户确认并部署。

## 4. 独立管理员

在可信服务器交互终端执行 DATABASE_PATH=... npm run admin -- create 用户名 owner。密码最少 14 字符，隐藏输入，scrypt N=32768/r=8/p=1，随机盐。用户名使用小写字母、数字、点、下划线、短横线。不会默认创建 admin/admin 等账号。

其他角色 operator 可回复工单；viewer 只读。owner 可以维护站点和计价；管理员创建/停用/密码重设仅支持离线 CLI，暂无网页账号管理以免产生开放 bootstrap。

重设：npm run admin -- reset-password 用户名
停用：npm run admin -- disable 用户名

两者撤销该管理员全部会话。CLI 要求 YES 确认，不将密码作为命令参数。保护服务器终端访问。登录有持久化限流、8 小时到期、退出撤销、CSRF 与 origin 校验；管理员和用户 Cookie 不互认。所有后台写入都由服务端校验角色并写审计。

## 5. Google 后续配置

用户在 Google Cloud 建立 Web application 类型 OAuth Client，完成 consent screen、应用名称、支持邮箱、必要隐私政策和测试用户/发布状态配置。需要保存 Client ID、Client Secret 和最终 HTTPS 域名。客户端密钥仅设置在服务器 GOOGLE_CLIENT_SECRET；无需发送在聊天或公开仓库。

授权重定向 URI 必须精确登记 `https://rental.example.com/auth/google/callback`，应用配置 PUBLIC_ORIGIN 对应同一 origin。本实现为后端 OAuth redirect 流程，不使用浏览器内 Google JS SDK；回调地址必须无多余斜线/路径。公网裸 IP 不能用于 Google callback；localhost 是开发例外。

服务使用 state、浏览器绑定 HttpOnly cookie、nonce、PKCE-S256、单次十分钟状态，验证 Google RS256 签名/JWKS、issuer、audience、expiry、azp 和 email_verified，以 Google sub 作为稳定身份。登录时不保存 access/refresh token，只保留登录身份和服务端会话。配置缺失/无效时明确不可用。配置完成后需人工验证真实成功/取消/过期流程，当前测试为隔离 mock provider 加真实本地 RSA 签名验证，并非真实 OAuth 联调。

官方参考：https://developers.google.com/identity/openid-connect/openid-connect
https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation

## 6. PVS / WsCharge

仍为 pending。界面展示状态，但不存在一键启用或假成功；真实租出、扣款和归还命令返回不可用；受控 TEST 账户可使用独立的纯模拟流程（见第 10 节）。待用户提供供应商协议、环境、认证/签名、事件去重、查询/退款/结算说明再开发真实适配器和验收。WsCharge 原始厂商资料不放公共仓库。现有离线 codec 不等于运行中的设备网关，也不依据65命令 ACK 开始计费。

## 7. 备份、升级与回滚

SQLite 处于 WAL 模式，运行中不能只复制主 .sqlite 文件。推荐使用 SQLite backup API 或在计划维护窗口停止应用后复制数据库及必要 WAL/SHM 一致性文件；优先用在线备份命令 `npm run backup -- /secure-backup/voltgo-YYYYMMDD.sqlite`。备份含个人数据与密码哈希，访问仅限授权维护人员，单独加密保存并定期做恢复演练。

升级前备份数据库和当前版本配置，记录当前 Git 提交。新版本独立目录运行测试/构建，不覆盖数据；检查迁移说明后切换 current，再由管理员重启服务。启动 /health 返回 production 和 schemaVersion 4；检查独立管理员登录、匿名 API 401、退出失效、空/真实站点状态、Google pending、PVS/WsCharge pending。不要把旧测试支付导入真实账目。

回滚代码前核实新旧数据库结构兼容；不能随意用旧备份覆盖已产生的业务数据。schema v2 新增 test_users / test_login_states 两个独立表；schema v3 新增 test_records / test_rentals / test_idempotency 独立模拟业务表，不改变原有 users / admins / 业务记录。迁移可重复执行，不导入旧 demo 数据。恢复演练在隔离目录/端口，不要连接真实支付/机柜。

## 8. 已知边界

本版本的正式订单/支付只读列表为后续真实接入保留，尚无真实设备借还与计费服务，不可运营收款。当前 SQLite 单实例，无独立后台结算任务。审计为本地持久化记录，不是不可篡改外部审计。配置状态仅证明本地参数符合格式，不证明供应商可用。管理员未配置前登录不可能成功，这是预期行为。需完成上线安全审查、日志保留、隐私合规、备份、实际浏览器与真实供应商端到端验收。


## 9. 临时 Google 模拟登录（同一正式服务）

默认关闭。此功能不调用 Google，不验证 Google 邮箱，只生成服务端测试客户身份；不是管理员入口，也不是切换回 legacy demo。仅在受控测试部署上临时开启，公网开启后任何访问者都可创建自己的测试客户与测试工单。不要在测试资料中填写个人敏感信息。

1. 先备份 SQLite，更新代码并运行 npm test、npm run build；继续使用原来的 DATABASE_PATH。
2. 在服务进程读取的环境配置中设置 ENABLE_GOOGLE_TEST_LOGIN=1，同时保持 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 都为空。不要把真实配置提交到仓库。项目不会自动读取 .env；使用现有 systemd EnvironmentFile 或启动时 node --env-file=/安全路径/应用.env scripts/start.mjs。
3. 重启应用，打开用户首页 Your account，点击 Continue with Google (test)。无需邮箱、密码或 Google 授权。/api/user/session 中 readiness.googleTest.ready 应为 true，登录后 user.isTest 为 true。
4. 可检查账户、使用 DEMO-001 模拟扫码租借、模拟支付/失败重试/取消、归还与结算历史，以及创建测试工单及后台回复。账户与工单会写入正式共享 SQLite，但标为 TEST；不同浏览器互相隔离，管理员能看见这些测试数据。
5. 同一浏览器退出再登录会恢复自己的测试账户。身份依据随机 HttpOnly cookie，不依据输入的邮箱、Google sub 或角色；清空 cookie、使用无痕窗口或浏览器绑定超过 30 天会获得新测试账户。保留 cookie 可在服务重启后继续访问原测试资料。退出撤销登录会话，但保留此测试身份绑定。
6. 关闭时将 ENABLE_GOOGLE_TEST_LOGIN=0 并重启。服务会撤销测试会话与浏览器绑定，测试记录保留用于审计，不删除真实资料。即使以后再打开，也不会恢复已撤销的旧绑定。真实 Google 的任一配置项非空时，测试模式同样强制关闭，包括配置不完整或 IP 地址不支持 OAuth 的情况。正式启用 Google 时同时明确设回 0。

测试用户与真实 Google 用户使用独立表及命名空间，不能自动合并、冒充真实 Google 账户或取得后台权限。真实 Google 登录后不会自动带入测试订单/工单。

重要：模拟登录和模拟租赁不会启用真机借还或真实支付。真实租出、扣款、归还仍返回不可用；TEST 身份也不构成未来真实硬件/支付授权。后续 WsCharge 联调必须另行设计并授权测试账户白名单、测试机柜白名单和独立操作权限，不能仅凭 isTest 登录就打开生产机柜或扣款。PVS 继续预留，当前不发生真实收费。


## 10. 同一服务内的 TEST 模拟租赁

仅当既有 googleTestEnabled 条件满足且当前会话 user.isTest=true 时开放。无需第二个开关。真实 Google 用户不能进入模拟端点；TEST 用户也不能借此调用真实硬件/支付。DEMO-001 是程序内固定的虚拟站点，不写入真实 station 记录，不能对应机柜。模拟模块没有网络或支付/硬件适配器调用。

所有模拟业务写入 SQLite 的 test_records、test_rentals、test_idempotency 表，与 records 中的真实 rental/payment/station 分开。后台 dashboard 分别返回 testRentals、testPayments、testStations，不能计入真实营业额。关闭测试开关会撤销 TEST 会话和身份绑定，保留历史，不删除真实或测试业务记录。迁移 v4 保留旧数据并重建模拟租赁状态约束及唯一索引，可重复执行；重启后使用仍有效的浏览器身份可继续未完成的模拟订单。清空 cookie 后不能自动找回旧身份。

金额单位为 ARS 分；恢复原演示的示例费率：hourlyRate=50000（ARS 500/开始的小时）、dailyCap=300000（ARS 3,000/每个 24 小时周期）、deposit=1000000（ARS 10,000）。版本 test-deposit-v2、illustrative=true，仅为演示，不是确认的商业费率。最低计一小时，不满一小时向上取整，每 24 小时周期分别封顶。报价有效五分钟，并保存费率快照。无钱包或充值，不调用 PVS、Google Pay、银行或机柜；所有金额、押金、扣费和退款均为模拟，不能作为真实收据或支付证明。

API（仅 TEST 会话，所有响应 Cache-Control:no-store）：
- GET /api/user/test/stations：{testOnly, stations, pricing}。
- GET /api/user/test/state：{testOnly, serverNow, rental, rentals}。当前订单包括 pending_payment / awaiting_pickup / active，或 null。
- POST /api/user/test/quote：{stationId:"DEMO-001"} → {quote}，含 id、pricing、expiresAt。
- POST /api/user/test/rent：{quoteId} → {rental}，初始 pending_payment；每个用户最多一个待支付、待取或使用中的订单。
- POST /api/user/test/pay：{rentalId,outcome:"success"|"failure",paymentMethod:"card"|"google_pay"|"bank_transfer"} → {rental,payment}。支付方式默认 card，仅记录模拟选择，不连接支付服务。失败保持待支付，未收押金；成功生成唯一 deposit 交易并转 awaiting_pickup，startedAt=null、费用为零。重复成功不重复收取押金。
- POST /api/user/test/pickup：{rentalId,outcome:"success"|"failure"}。仅待取订单可以首次模拟取走；成功转 active，服务器设置 startedAt 后才计时；失败取消并模拟全额退款。重复调用不改变原取走结果。
- POST /api/user/test/cancel：{rentalId}。待支付可取消；待取可取消并全额模拟退款；使用中必须归还。重复取消不重复退款。
- POST /api/user/test/return：{rentalId} → {rental,payment,refund}。active 转 completed 并保存 returnedAt、durationSeconds、totalAmount。rental_fee 交易仅记录从已付押金扣除的金额，不是再次支付；refund 交易单独记录押金余额退还。重复归还返回已有结果，不重复扣除或退款。

订单记录 depositPaid、depositApplied、refundAmount、outstandingAmount，押金支付/费用抵扣/退款分别引用 depositPaymentId、settlementId、refundId。费用超过押金时，仅抵扣已有押金，退款为零，差额记录 outstandingAmount、settlementStatus=review_required，不追加扣款。退款在本模拟中总是成功，不代表真实支付网关支持退款。

迁移 v4 仅重建 test_rentals 的状态 CHECK 和开放订单唯一索引，使 awaiting_pickup 受保护；保留所有用户、会话、真实业务、模拟记录和幂等响应。旧版零押金报价、订单及历史不补收或伪造已付押金，读取时标记 legacy=true。旧待支付订单须明确取消后重新报价，不能直接支付新押金；旧 active 订单可归还，保留原费率计算应计费用并标记 legacy_review，不额外扣款或生成虚构退款。旧 completed 历史保持原记录。回滚前核实 awaiting_pickup 状态与旧代码不兼容，不得直接用旧代码操作新订单。

每次 POST 必须附同源 Origin、会话 x-csrf-token 和 Idempotency-Key（8–128 位字母、数字、下划线或短横线，推荐 UUID）。同一逻辑请求的网络重试复用该 key；不同操作必须换 key。相同 key 和请求返回持久化原响应，不同请求复用 key 返回 409。重复 quoteId 创建订单也返回原订单，不生成第二笔订单。身份、所有权校验和幂等写入均在服务端；不能用别人的 quoteId/rentalId 操作。GET /api/user/rentals 对 TEST 用户返回自己的模拟历史，对真实用户仍只返回真实记录。原 /api/user/rent、/pay、/return 保持 503，不会通过此变更启用供应商功能。

上线验收至少覆盖：模拟登录后进入扫码入口、DEMO-001 及无效站码、报价、支付失败/重试/取消、成功租借、刷新恢复、归还/历史、后台 TEST 标识、重复点击与断网重试、数据库重开、不同用户隔离、CSRF/Origin 拒绝、关闭开关撤销会话。真实扫码设备、Google OAuth、PVS 收费和 WsCharge 柜机联调仍需另行验收。


## 11. 流程恢复与后台并发编辑

本轮沿用 schema v4，无新增迁移。完整步骤见 [FLOW-ACCEPTANCE.md](FLOW-ACCEPTANCE.md)。

客服 POST /api/user/support 可带 Idempotency-Key（8–128 位字母、数字、下划线或短横线）。同一用户、同一 key、同一消息的重试返回同一工单；不同消息复用 key 返回 409。未提供 key 的旧调用仍兼容，但不具备去重保证。不要把客服消息、登录凭据或真实个人数据写入公开日志。

后台站点和工单保存可带 expectedUpdatedAt，价格保存可带 expectedVersion。当前前端附带加载时的值；若记录已变更，服务返回 409，需重新加载并核对后再编辑。旧客户端不带令牌的调用保持兼容，因此接入自定义管理客户端时也应发送令牌。

客户订单列表和后台 TEST 进行中订单金额使用服务器时间动态估算，已结算订单不重新计算。客户端恢复焦点时会同步会话和订单；模拟押金和退款仍不连接真实支付服务。


## 12. 后台运营与独立模拟联调

本轮继续沿用 schema v4。新增订单详情/筛选、工作队列、关联客服及双向回复历史、计价历史和安全操作差异记录；新增记录沿用独立 records kind，旧客服单条回复以 legacy 历史展示，不伪造过去已被覆盖的内容。

使用说明见 [ADMIN-OPERATIONS.md](ADMIN-OPERATIONS.md)。联调实验与客户 TEST 租借、正式资金分离，必须明确进入 TEST 场景；接入契约及未实现的真实链路见 [VENDOR-ADAPTER-CONTRACT.md](VENDOR-ADAPTER-CONTRACT.md)。不能因为模拟回归通过就打开真实收费或机柜操作。
