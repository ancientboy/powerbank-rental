# Smile：共享充电宝 H5 演示项目

面向阿根廷共享充电宝业务的英文 H5 流程演示，包含模拟登录、租借、支付、归还、结算和运营控制台，以及 WsCharge 离线协议验证。

当前版本用于体验与开发验证，不是已经完成的生产系统或服务器一键部署包。Apple / Google 登录、PVS 支付、机柜及归还通知均未接入真实服务；请勿输入真实个人信息、银行卡或密钥。

## 部署状态与后续准备

- 本地体验：使用 Node.js 24，运行下方命令。开发服务不是生产服务。
- 当前构建目标：HTTP Worker + D1 数据绑定，不能直接当作静态网站或普通 Node.js 服务部署。
- 自有服务器部署：服务器操作系统、域名及现有服务尚未确认。后续需准备生产运行入口、HTTPS / 反向代理、公开域名与安全 Cookie 配置、持久化数据库及备份，并完成上线检查。
- `.openai/hosting.json` 仅保留无项目身份的构建模板；不包含任何已有托管项目 ID，不会指向原演示站点。部署到托管平台前需由仓库使用者单独配置自己的项目和数据库绑定。
- 真实上线还需 Apple / Google、PVS、WsCharge 的配置与联调、正式身份鉴权、共享库存、多用户数据隔离及独立后台任务。
- 本仓库尚未指定开源许可证；公开源码不等于已授予开源许可。

后文提供运行方法、功能边界和工程文档索引。

## English implementation overview

A runnable English mobile H5 demonstration of the shared-power-bank rental journey, with a lightweight operator console and server-owned state. All identities, stations, payments, device evidence and prices are simulated. **Not approved for real users, payments or hardware.** Apple/Google buttons are not OAuth; operator entry is not production authentication. Each browser-session cookie receives its own persisted workspace; choosing Apple or Google selects a synthetic identity within that workspace. Clearing cookies starts a new workspace, not account recovery. Never enter personal or payment information.

## Run

Use Node.js 24 with built-in SQLite and Web Crypto support. No third-party npm dependencies are required.

```sh
npm test
npm run check
npm run dev
# Open http://localhost:4173
npm run build
npm run verify:build
```

The local server saves `.local/demo.sqlite` using Node built-in SQLite/WAL; it is a single-process development runtime, not a production deployment. Hosted builds use the `DB` D1 binding and `drizzle` migration, storing one revisioned JSON aggregate per browser workspace. `dist/server/index.js` embeds frontend assets. Publishing and its verified link are managed separately; this README does not claim deployment succeeded.

## Walk through

1. Choose simulated Apple or Google login.
2. Enter PAL01, REC02 or MIC03; SAN04 is an offline fixture.
3. Review the TEST quote, accept demo terms, and select a simulated payment method.
4. Simulate payment and collection evidence; inspect pending/declined/unknown alternatives.
5. Advance the simulation clock, find a return station and simulate a return.
6. Observe physical RETURNED separately from refund PENDING; query/reconcile the simulated result.
7. Review history/detail and support; enter the demo operator console for stop-new-rent, station, price, case, audit and reconciliation controls.

The simulation clock and reset affect the current browser workspace, including both synthetic provider identities in it. Do not use this demonstration as private-data storage.

## Engineering handoff

- [Architecture decision and limitations](docs/ADR-001-demo-architecture.md)
- [Exact implemented API](docs/API.md)
- [Domain rules and state](docs/DOMAIN.md)
- [Adapter interfaces and real-integration gates](docs/INTEGRATIONS.md)
- [Operations and safe restore](docs/RUNBOOK.md)
- [76-task and 59-case evidence matrix](docs/TRACEABILITY.md)
- [31-table PostgreSQL reference, NOT deployed](docs/production-schema.sql)

The recommended React/Next/TypeScript + NestJS + PostgreSQL system remains a production migration project. This demo implements selected domain behavior, not full P0–P12 acceptance. Use the traceability matrix rather than interpreting a working screen or passing unit test as real-integration evidence.

## Verification limits

Source unit/integration tests and the built Worker HTTP workflow were executed. Rendered browser and physical-device QA could not be completed because the available cloud browser could not reach the local preview. No screenshot or visual pass is claimed. Real Apple/Google/PVS/hardware tests require their actual configuration and access.

## WsCharge offline protocol review

Operations → WsCharge offline inspects synthetic fixtures based on the supplied version 6.0A document. No vendor connection or hardware command exists. The codec deliberately leaves status 200 as unknown physical evidence and return observations untrusted. See [supplier questions and limits](docs/WSCHARGE.md).
