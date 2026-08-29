<!-- 514cc-session-id: 019ff160-7e58-77c2-acc5-25e3162daff6 -->
# 远程项目三面图谱（v41 波六）

## 任务与判定

- LO 要求：继续 Kimi 当前波次，使“远程项目”也拥有 `供应商与应用 / Agent·Skill·MCP / 运行席位与真源` 三面图谱。
- 起点实证：Kimi 已完成远程主机三面图谱；远程项目只有侧栏、run 聚合、SFTP/终端入口，没有独立图谱目标，也不扫描项目级配置与能力。
- 本轮判定：远程项目必须保持 `{projectId -> hostId,path}` 身份，不能退化为主机别名；同一主机多个项目的图谱缓存、真源展开和慢响应所有权必须隔离。

## 落地

1. `apps/control-center/src/ssh/remote-graph.mjs:75`：同一图谱引擎增加 project scope；叠加项目 `.claude/.codex/.agents` 清单、`.mcp.json`、项目配置覆盖和项目真源白名单。项目路径在读取前再次走 SSH 服务的 SFTP rootAllowlist。
2. `apps/control-center/src/remote-projects/routes.mjs`：增加 `/api/remote-projects/:id/graph` 与 `/graph/source`；客户端只给 project id/file id，服务端台账解析 host/path，并强制 `ssh + sftp` 双门闸。
3. `apps/control-center/public/app.js:1423`：配置目标条支持本机、远程主机、远程项目；项目目标用 `project:<id>` 隔离图谱/真源缓存，三面共享当前 surface，慢主机响应不覆盖已切项目。
4. 远程项目侧栏菜单新增“打开配置图谱”；项目标题、目录、项目 scope 徽标、项目实况计数和项目目录 SSH 终端均接线。
5. `apps/control-center/public/styles.css`：390px 目标条/动作/真源布局，供应商表固定列轨并局部横滚，路径截断带 title；截图复核后修掉路径侵入状态列和本机计数误导。
6. `proposals/v41-remote-agent-design.md` 增补 §4.4 与波六安全/所有权决策。

## 验证证据

- 专项：`node --test tests/remote-graph.test.mjs tests/remote-projects.test.mjs tests/config-topology-ui.test.mjs` -> 12/12 pass。
- 浏览器：`node .scratch/verify-v41w5.mjs http://127.0.0.1:51400` -> 24/24 pass；覆盖主机旧路径、项目三面、项目真源、900ms 慢主机响应切项目、390x844 零主区横溢/列不重叠/零 pageerror。
- 截图：`.scratch/v41w6-remote-project-mobile.png`，已当轮人工查看；顶部为 `5 个 live 配置`，路径/状态列不再重叠。
- 全量：`npm test` -> 921 tests / 920 pass / 0 fail / 1 explicit skip。
- 配置：`npm run validate` -> 13/13 valid；CC-Switch 账本 288 项（157 equivalent / 128 adapted / 3 blocked_external_trust）。
- 语法：`node --check public/app.js public/state.js src/ssh/remote-graph.mjs src/remote-projects/routes.mjs` 全部 exit 0。
- 交付门：`git status --short --untracked-files=all -- <本轮文件>` 确认 11 个代码/测试/QA 依赖均可见；新增文件与本轮编辑区自定义行尾检查无 trailing whitespace。

## 边界与运行态

- 浏览器 QA 以 `http://127.0.0.1:51400` 作为真实资产/MIME/CSP 服务，API 由 Playwright mock；故证明前端行为与契约，不证明真实 SSH 主机已完成远端扫描。其后已安全重启服务端装载新模块：HTTP 200，带认证访问不存在的 `/api/remote-projects/__missing__/graph` 返回 `404 REMOTE_PROJECT_NOT_FOUND`（旧前缀处理器会误回 200 列表），证明新项目图谱路由实际生效。
- `git diff --check` 被工作树既有整文件 CRLF 漂移污染，对 `styles.css` 全文报 trailing whitespace；本轮没有为造绿重写该文件，改以读取后的新增文件与编辑区检查收口。
- 未执行 commit、push、runtime sync、真实远端安装/配置同步或长期凭据操作；仅用服务端一次性 bootstrap nonce 做本机鉴权路由回读，未落 token；未清理其他 agent 的脏改动。

__DELTA__: 烛(Codex) | 1 | observability | 证据：apps/control-center/src/ssh/remote-graph.mjs:214 将 Kimi 的远程主机三面补强为服务端台账解析、项目作用域叠加与双围栏的远程项目三面；.scratch/verify-v41w5.mjs 24/24 覆盖 latest-wins 和 390px
