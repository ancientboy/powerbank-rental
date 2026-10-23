# Smile 共享充电宝平台

英文 H5 用户端与独立正式管理后台。Node.js 24 单进程服务、SQLite/WAL 持久化，前后台分别鉴权；这不是已经接通支付及机柜的商用租借系统。

## 品牌

展示品牌为 `Smile`（S 大写），采用绿至黄色渐变的圆角微笑箭头标志。用户端、独立管理后台和历史演示共用同一 SVG 标志。此次仅更换品牌展示，不改变页面结构、底部导航或业务流程。为保持兼容，原有 `voltgo` Cookie、浏览器存储键、包名及部署路径保留不变；无需更改服务器、数据库或 Google OAuth 配置。

## 本次版本

- 用户入口 `/`；管理入口 `/admin/login`，管理工作台 `/admin`。
- 客户端沿用原白色/青柠绿设计、扫码卡片和独立页面切换；移动端底部导航为 Rent / Stations / Rentals / Account。界面恢复不改变正式登录、独立后台或 TEST 订单存储。
- 管理员通过服务器离线命令建立，不存在默认账户、默认密码或网页自助获取管理员入口。
- 正式后台从空数据开始，支持站点/机柜映射、版本化计价、用户/订单/支付查看、支持工单、审计、接入状态。后台角色：owner、operator（工单操作）、viewer（只读）。
- 用户保留真实 Google 登录接口，并提供默认关闭的临时 Google 测试登录。设置 ENABLE_GOOGLE_TEST_LOGIN=1 且两项 Google 配置为空时，可在同一服务进入隔离的 TEST 客户账户；不会获得管理员权限，也不启用支付/真机。详见部署指南第 9 节。
- TEST 客户登录后进入同一服务内的模拟扫码租赁流程：测试机柜、押金及费率报价、模拟支付押金、模拟取出后计时、归还扣除租金并退回剩余押金、结算与历史订单。支付成功本身不开始计费，不提供充值钱包。测试数据独立存储，后台单独标识，不计入真实业务统计。
- PVS、WsCharge 仍未接入，真实扣款和真实机柜操作保持禁用。测试价格、支付与归还仅用于演示，不代表正式收费规则或厂商联调完成。
- SQLite 由服务端共享，用户只能访问自己的订单/工单；正式数据与历史 demo.sqlite 不混用。
- Apple 登录不在正式产品中。历史离线演示源码仅用于既有业务状态机回归，不得部署为正式服务。

## 后台运营与模拟联调

新增订单筛选/详情/关联查询、工作队列、订单关联客服与追加会话、价格版本及操作差异。厂商相关设备、支付退款、异常核查在独立 TEST 联调区演练，正式模式仍关闭。

- [后台运营与验收](docs/ADMIN-OPERATIONS.md)
- [内部厂商适配契约与接入清单](docs/VENDOR-ADAPTER-CONTRACT.md)
- [WsCharge HTTP 接入与厂家联调边界](docs/WSCHARGE-HTTP.md)

## 全流程修复与验收

本轮补齐会话过期恢复、跨页面订单同步、过期报价、网络不确定结果、客服消息重试和后台保存/冲突反馈。保留原客户布局、底部导航和每次租借押金模式；不新增数据库迁移。

手机及后台验收步骤见 [全流程验收清单](docs/FLOW-ACCEPTANCE.md)。真实供应商、手机相机和运行中服务器仍需分别验证。

## 本地验证

需要 Node.js 24，无第三方运行依赖。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run verify:build
PUBLIC_ORIGIN=http://127.0.0.1:4173 ALLOW_LOCAL_HTTP=1 npm start
```

本地 HTTP 只允许回环地址。正式环境设置自己的 PUBLIC_ORIGIN=https://your-host，配置合法匹配证书的 HTTPS 反向代理，后端默认监听 127.0.0.1。不得忽略证书警告。HTTPS IP 可用于独立后台，但证书须包含该 IP；Google 不接受公网 IP 回调地址，之后需 HTTPS 域名。

配置管理员由服务器所有者亲自执行：

```sh
DATABASE_PATH=/var/lib/voltgo/production.sqlite npm run admin -- create your-admin-name owner
```

命令要求交互式终端、明确输入 YES、两次隐藏密码（8–256 字符）。密码使用 scrypt 存储；不要将密码放入命令行、聊天、GitHub 或环境示例。这里不会替你建立账号。

## 配置及部署

详细步骤：[正式部署、备份、升级与迁移](docs/PRODUCTION.md)。

| 变量 | 用途 |
|---|---|
| PUBLIC_ORIGIN | 必填，外部访问的 HTTPS origin，不含路径 |
| DATABASE_PATH | 持久化 SQLite 文件，默认 `.local/production.sqlite` |
| HOST / PORT | 默认 `127.0.0.1:4173`，反向代理连接此地址 |
| GOOGLE_CLIENT_ID | 后续 Google Web OAuth 客户端 ID |
| GOOGLE_CLIENT_SECRET | 后续客户端密钥，仅存服务器，禁止提交仓库 |
| ENABLE_GOOGLE_TEST_LOGIN | 默认 `0`；测试时明确设 `1`，任一 Google 配置非空即强制停用 |
| ALLOW_LOCAL_HTTP | 仅开发回环测试可设 `1` |

Google 回调固定为 `PUBLIC_ORIGIN/auth/google/callback`，例如 `https://rental.example.com/auth/google/callback`。现在可以全部留空，后台不依赖 Google。PVS/WsCharge 尚未实现真实适配器，不能靠设置任意凭据就启用。

## 历史演示

`npm run demo` / `npm run build:demo` 是旧的、独立模拟器，包含假运营会话，不属于正式后台；不得代理到公网正式域名，不得使用真实数据。生产 `npm start` 不加载其 `/v1` API、不读取其 Cookie，也不迁移其账户。`npm run build` 生成新的 Node 服务包，不再默认生成旧 Worker。历史说明见 [LEGACY-DEMO.md](docs/LEGACY-DEMO.md)，其中部署和模拟身份内容只适用于旧演示。

## 上线边界

当前交付的是正式鉴权/管理基础、隔离的完整模拟租赁流程和未接入服务的安全占位，不意味着真实租借可以上线。仍需用户配置管理员、域名/合法 TLS、Google OAuth、正式条款/隐私政策、PVS 文档及签名回调、WsCharge 真实协议与机柜测试、对账/归还通知/任务恢复，以及上线容量、安全与备份恢复演练。没有替用户修改运行中的服务器。

仓库尚未指定开源许可证；公开源码不等于已授予开源许可。
