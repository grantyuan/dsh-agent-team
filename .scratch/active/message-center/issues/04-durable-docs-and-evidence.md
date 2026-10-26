# 04 — 维护文档与验收证据

**What to build:** 页面落地后的稳定行为写进维护文档，索引与预算门禁通过；一次真实浏览器自检的证据被人工确认后归档，工作项可关闭。
**Blocked by:** 03
**Status:** in-progress

- [x] 新增 `docs/frontend-design/message-center.md` 与 `message-center.zh.md`，双语成对、switcher 正确、内部链接可解析
- [x] 两份 `docs/README` 索引表同时加入该文档行（Where to start 经 frontend-design/README 的分文件表路由，两侧顺序一致）；`docs/AGENTS.md` 路由表同步加行
- [x] `scripts/check-docs.mjs` 为该文档记录 ceiling 行（实测 679/246），`npm run check:docs` 通过
- [x] 用户可见行为变化记入 `CHANGELOG.md`
- [x] `npm run test:browser` 6/6 通过（含新增消息中心段），桌面与 390×844 证据已留 `artifacts/browser/ui-09/message-center-*.png` 五张（topics/mine 桌面、topics/mine 窄屏、locate 高亮帧）。复跑：`CHROME_PATH=/usr/local/bin/chromium npm run test:browser`。待人工确认后复制进本工作项 `validation/`——这一步与归档留给操作者
- [x] 全量 `npm run test`、`npm run typecheck` 通过（已知既有失败与本工作无关，见下）
> 既有失败对照（干净工作树同样失败）：`render-isolation`（memo 隔离回归，早于本工作存在）、`member-lifecycle`/`member-prompt`（全量并发下的负载偶发，单跑通过）。归档待操作者确认验收后执行。
