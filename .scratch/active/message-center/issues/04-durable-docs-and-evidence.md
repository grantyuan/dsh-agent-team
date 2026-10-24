# 04 — 维护文档与验收证据

**What to build:** 页面落地后的稳定行为写进维护文档，索引与预算门禁通过；一次真实浏览器自检的证据被人工确认后归档，工作项可关闭。
**Blocked by:** 03
**Status:** ready

- [ ] 新增 `docs/frontend-design/message-center.md` 与 `message-center.zh.md`，双语成对、switcher 正确、内部链接可解析
- [ ] 两份 `docs/README` 索引表同时加入该文档行，`Where to start` 补入口；顺序两侧一致
- [ ] `scripts/check-docs.mjs` 为该文档记录 ceiling 行，实测后回填精确值，`npm run check:docs` 通过
- [ ] 用户可见行为变化记入 `CHANGELOG.md`
- [ ] `npm run test:browser` 在桌面与 390×844 各留证据，人工确认后复制进本工作项 `validation/` 并写明证明的验收点与复跑命令
- [ ] 全量 `npm run test`、`npm run typecheck` 通过；本目录归档到 `.scratch/archive/2026-10/message-center/`
