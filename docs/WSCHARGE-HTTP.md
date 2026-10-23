# WsCharge HTTP 接入与厂家联调

本版本准备厂商 HTTP 网关适配及隔离回调观测，不代表已部署、已获厂家验收或真实租借可上线。现有支付、自动计费、归还结算及退款不由这些通知触发。供应商原文、截图和示例 token 不随源码发布。

## 文档确认的部分

供应商《Ws Charge Api》6.0A 的末尾附录明确给出 HTTPS 网关与客户通知地址；无需因此实现柜机 TCP 长连接。下列页码是本次 DOCX 渲染的物理页码，原目录分页可能不同。

- 第14–15页：向 `https://powerbank.cnwoshi.com/DeviceReceive/receive` 发出 POST，截图使用 `multipart/form-data`，字段 `token`、`E`、`I`，指定仓位时增加 `L`，均以字符串提交。
- 第15页：同步 JSON 响应 `code=200` 表示命令下发成功，不证明物理取出。设备结果另外发到客户提供的通知地址。
- 第8–9页 §2.3：库存命令 `I=64,E`；结果含 `I,E,K,X,terminalArr`，数组项为 `B,L,D`。`S` 在字段表中出现，但样例省略；信号 `X` 样例为十六进制字符串，仓位可能带前导零。
- 第9–10页 §2.4：借出命令 `I=65,E,L`；结果含 `I,E,L,B,S`，示例状态为 `200`。
- 第10–11页 §2.5：归还通知为 `I=66,E,L,B`，未要求 `S`。
- 第7–8页：`60` 为上线、`90` 为离线，均带 `E`。第11–14页另有 `80` 强退、`81` 全弹、`67` 重启；本接入不允许发出这些维护命令。
- 第15页只展示借出回调附带 `token` 和字符串 `timestamp`。没有说明签名算法，也不能据此认定全部事件均带这些字段。

## 本服务提出的回调契约

2026-10-23 厂家确认：正式通知前先以 GET 探测端点，失败时再用 POST 探测；探测通过后才发送 form-data 正式通知。以下列出已适配的传输方式及仍由本服务施加的校验：

- 路径：`/api/integrations/wscharge/notify`。已配置接入时，无查询参数的 GET、空 POST 或空表单返回 HTTP 200、`{"code":200,"probe":true,"received":false}`，只表示端点可达，不记录设备事件。
- 正式通知使用 POST `multipart/form-data`；兼容 `application/x-www-form-urlencoded` 和已有 JSON 通知。表单字段 `I` 转为整数，`terminalArr` 支持 JSON 数组字符串或连续索引的 `terminalArr[0][B]` 等表单字段；拒绝重复字段、编码冲突和文件上传。正式通知仍必须通过 token、机柜允许列表、时间戳与业务字段校验。
- 使用正文 `token` 与显式配置的回调 token 做恒定时间比较；仅接受允许列表内的柜机。共享 token 不是消息签名，也不能证明时间戳没有被持有该 token 的人修改。
- 将 `timestamp` 解释为 Unix 秒。默认时间偏差窗口为 300 秒；超窗的已认证通知保留为隔离观测，不更新当前库存。
- 成功接收返回 HTTP 200、JSON `{"code":200,"received":true,"duplicate":false}`；重复事件的 `duplicate` 为 `true`。这个 ACK 格式须由厂家确认。
- 严格校验字段，限制消息大小；不保存 token 或物联网卡号 `K`。厂商新增字段可能被拒绝，须先更新协议与测试，不应绕过验证。
- 通知保留为 `observation_only`，不能成为扣费、退款或订单完成的证据。重复识别与候选命令关联不等于已获得厂商事件 ID 或可靠请求关联。
- 库存仅为观测，不证明完整可租数量；过期库存不能当成可租承诺。
- 出站仅允许库存查询 `64` 和明确启用后的受控借出 `65`。请求须经过管理员权限、柜机允许列表及幂等校验；不自动重试物理弹出。结果不确定时必须人工核实，不能换一个幂等键再次尝试。
- 独立管理员命令入口的受控借出每台柜机仅允许一次：既有 `65` 记录会阻止新的借出，即使收到了成功样例通知也不自动解除。该入口不是客户订单流程；现已提供下文所述的证据核查及按订单借还机制。不要删除数据库或更换柜机标识来绕过限制。

## 环境配置

密钥只能在服务器受保护的环境配置或秘密管理系统中设置，不放进仓库、浏览器、聊天、命令行历史或日志。

| 变量 | 用途 |
|---|---|
| `WSCHARGE_ENABLED` | 默认关闭；联调准备完成后显式设为 `1` |
| `WSCHARGE_API_TOKEN` | 厂家正式出站凭据，不使用文档样例 |
| `WSCHARGE_CALLBACK_TOKEN` | 显式配置的回调共享 token；与出站是否相同由厂家确认，不隐式回退 |
| `WSCHARGE_CABINET_IDS` | 允许联调的真实柜机编号，以逗号分隔 |
| `WSCHARGE_ENABLE_DISPATCH` | 默认关闭；仅受控真机借出测试时显式设为 `1` |
| `WSCHARGE_MAX_CLOCK_SKEW_SECONDS` | 默认 `300`，允许 `30` 至 `86400`；需结合厂家时间戳及重试规则确认 |
| `PUBLIC_ORIGIN` | 外部 HTTPS origin；参见[正式部署指南](PRODUCTION.md) |

## 回调地址与部署状态

建议最终地址为 `PUBLIC_ORIGIN` 加 `/api/integrations/wscharge/notify`。

现有 IP 对应的候选拼接是 `https://47.237.134.133/api/integrations/wscharge/notify`。**这只是候选地址，未部署、未验证可用，不能当作已可配置的正式回调。** 已发现该 IP 的 HTTPS 证书 SAN 不匹配。应使用有效证书覆盖的域名，或取得覆盖该 IP 的有效证书；禁止通过忽略 TLS 校验上线。本次没有登录或改动运行中的服务器。

部署与验收顺序：

1. 暂用 IP 时，将 `PUBLIC_ORIGIN` 保持为 `https://47.237.134.133`，为该 IP 配置受信任且 SAN 包含该 IP 的有效证书；之后如改域名，再同步修改 DNS、证书和 origin。按[正式部署指南](PRODUCTION.md)配置反向代理及持久化数据备份。
2. 与厂家确认下一节的协议，取得正式 token 和测试柜机编号，通过安全渠道配置；保持物理借出关闭。
3. 在本地或隔离测试环境完成认证失败、非法字段、重复回调、超窗、乱序、未知柜机、供应商超时等测试。测试通过不等于真实设备已接通。
4. 由获授权的部署人员发布代码，检查 HTTPS 链、回调路由及服务状态，再把最终 URL 给厂家。不要将带密钥的 URL 作为回调地址。
5. 先做库存查询和上线/离线通知联调，再由现场人员配合受控借出与归还测试；核对回调内容、ACK、重试及物理结果。没有现场确认，不反复发送借出命令。
6. 保存联调记录，核实事件身份、幂等与订单关联方案后，另行实现并验收真实计费/支付结算。现阶段保持隔离观测，不开启商用租赁。

## 必须向厂家确认

- 已确认正式通知为 POST form-data，前置 GET/POST 可达性探测；仍需提供各类事件的脱敏请求样例并确认 ACK 正文。
- 全部通知是否带 `token`？与出站 token 是否相同，如何安全分配和轮换？是否另有签名机制？
- `timestamp` 是否 Unix 秒，代表设备事件还是发送时刻？重试是否保持原值？设备和服务端时钟如何同步？
- 收到通知后应返回什么 HTTP 状态与正文？上述 HTTP 200 JSON ACK 是否可接受？
- 超时、重试间隔、次数、最大延迟、乱序及漏通知后的补查机制是什么？
- `S=200` 究竟证明下发成功、锁已弹开还是充电宝已取走？其他状态码及失败字段是什么？
- 是否有稳定事件 ID、请求关联 ID或客户订单号？如何区分同一柜机、仓位、充电宝的多次租借？
- 空仓与异常仓位的库存表示、数组完整性、可租电量阈值和柜机并发限制是什么？

在这些问题确认并通过真机联调前，不得把共享 token、一个示例状态码或“未收到回调”当成结算依据。

## 后台查看与接口

- 管理后台 Integrations 中，WsCharge HTTP 区域与原有 TEST 场景隔离，仅展示配置状态、通知、库存观测和命令尝试；没有物理弹出按钮。
- `GET /api/admin/wscharge`：管理员只读查询脱敏状态，最近 200 条观测和命令记录。库存数量不表示可租承诺。
- `POST /api/admin/wscharge/commands`：仅 owner，继续要求管理员会话、同源、CSRF 与 `Idempotency-Key`。请求为 `code`、`cabinetId` 及借出时的 `slot`；实际向厂家发送命令属于真实设备操作，须完成授权和现场安全确认。
- 新增数据保存在独立的 records kind，保留原有用户、订单、计费、支付和 TEST 数据，不新增数据库迁移。上线前仍应使用项目备份流程备份。

## Supervised QR rental testing (mock money, physical device)

The `/rent?cabinet=TDMB081675764251` page is a dedicated physical-test flow.
`/?cabinet=...` redirects there. The QR contains only the HTTPS link and cabinet ID.
The downloadable `/cabinet-test-qr.png` is for the configured test cabinet; it is
not an authorization credential. Normal simulated DEMO-001 rentals stay separate.

Enable `WSCHARGE_HARDWARE_TEST_ENABLED=1` and `WSCHARGE_ENABLE_DISPATCH=1` for
physical testing. All signed-in accounts can use this flow; anonymous visitors
must sign in first. Per-account requests, owner grants and one-hour grant limits
are no longer required. Authentication, same-origin/CSRF checks, the cabinet
allowlist and dispatch switches remain enforced. The current rental-page sign-in
button uses the configured TEST login; production account onboarding and real
payments are not yet part of this flow.

The customer journey is: scan → sign in if needed → review rates and click
**Confirm rental** → see the slot being released → **In use** with the timer →
automatic return receipt. Scanning alone never dispatches a power bank. Inventory
refresh and order creation happen behind the confirmation action. A changed price
requires confirmation again. Customer-facing text is English, with shared Smile
navigation and rental history. The scanner supports camera decoding, a **Photos**
icon button for local image decoding, and optional manual station/link entry.

The server selects the highest reported battery (at least 50%), breaking ties by
slot number, from fresh allowed-cabinet inventory. One unresolved physical order
per cabinet is permitted. Payment is a mock ledger using the existing illustrative
ARS deposit/rates; no payment provider is called. Rental time starts at a matched
successful I=65 callback, without waiting for physical pickup. A matching I=66
return ends the order and writes one mock fee/refund entry. Repeated callbacks and
repeated pay requests cannot dispatch or settle twice. Orders and mock payments
appear in the rental page, customer history and the admin physical-test panel in
Integrations, Orders and Payments.

Uncertain command results, failed ejection callbacks and missing confirmations
never cause automatic redispatch or client-forced return/refund. They retain the
reservation for investigation. The page marks a missing confirmation after 30s.
A successful return releases the command, but a fresh later inventory is required
before the next borrow. The original standalone supervised command can only be
reconciled by an owner with a matched successful ejection, later return and fresh
inventory proving that bank is back; history is never deleted. There is no general
force-unlock interface. Unknown/failed cases require individual supplier review.

This test-only callback linkage does not enable live billing or commercial rental.
All shared-token callback limitations still apply. No secrets are in the QR or UI.
