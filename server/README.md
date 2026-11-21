# AI Hub account server

## 部署

1. 解压 `ai-hub-server-*.zip`，使用 Node.js 24。服务运行时无需安装 npm 依赖。
2. 在本服 Gitea 的设置 → 应用中创建 **机密 OAuth2 应用**。登记完整的回调地址，例如本机试用时填 `http://127.0.0.1:8788/api/account/callback`。部署预览站时，使用预览站的 HTTPS 地址附加相同路径。
3. 将 `server/.env.example` 复制为包根目录的 `.env`。设置 `AIHUB_PUBLIC_ORIGIN`、Gitea Client ID 和 Client Secret，以及允许登录的 Gitea 用户名 `AIHUB_GITEA_USERS`（逗号分隔）。生成并妥善保存凭据加密密钥。

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   将结果填写到 `AIHUB_VAULT_KEY`。将配置文件和数据目录限制为服务账号可读写，并在受保护的位置分别备份 SQLite 数据与加密密钥。恢复时须使用原密钥。

4. 在包根目录运行 `node --env-file=.env server/index.mjs`。服务监听 `127.0.0.1:8788`。正式接入时，通过 Caddy 等反代使用 `AIHUB_PUBLIC_ORIGIN` 提供 HTTPS。流式请求期间允许代理持续传输响应。
5. 打开 AI Hub，在登录页点击「使用 Gitea 登录」。登录后默认使用账号同步，数据管理页可切换到「仅此浏览器」。在原浏览器选择「合并本机旧会话」可保留原件并复制既有历史。另一台设备登录同一账号即可恢复同步的数据。

反向代理需保留访问者请求的 `Host`。迁移域名时可通过 `AIHUB_ADDITIONAL_ORIGINS`（逗号分隔）保留旧入口，并在 Gitea 应用中登记各入口的完整回调地址。每个域名分别登录，同一 Gitea 账号可继续使用同步的供应商。浏览器历史可通过旧域名的数据管理导出，再导入新域名。导入前需确认新域名上的历史，因为导入会覆盖当前浏览器中该域名的会话和附件。

## 账号与数据

- 登录使用 OAuth2 授权码、S256 PKCE 和一次性 state。账号以 Gitea issuer 和 subject 为准。退出只撤销 AI Hub 的本次会话。
- SQLite 中的 API Key 按账号加密，客户端取回供应商和模型信息。发送消息时，后端使用该账号的 Key 调用供应商。
- 默认支持 DeepSeek、OpenAI、OpenRouter、SiliconFlow 和通义千问预设。管理员可通过 `AIHUB_PROVIDER_ENDPOINTS` 替换允许的 HTTPS 地址集合，格式是 API Base URL 到 `deepseek` 或 `openai` 的 JSON 对象。只登记由管理员信任的供应商地址。
- 账号同步覆盖会话、消息分支、附件原件、草稿和个人偏好。每个账号的内容独立加密保存于 `accounts.sqlite`。账号记录包含单调修订号，设备重复提交可安全重试，会话编辑冲突保留副本。本地缓存与待同步改动保存在各账号独立的浏览器数据库。
- 仅浏览器模式在当前设备保存会话、附件和偏好。供应商仍可单独选择保存位置。旧版 `chat-demo` 数据库保留供合并与回滚。
- 浏览器中的供应商凭据按登录账号隔离。只允许一个登录账号时，旧浏览器配置在该账号登录时迁入。多人实例的旧配置保存在原浏览器存储中，各账号可分别配置供应商。
- 同步附件沿用 64 MiB 的单文件上限。单账号的同步载荷上限为 4 GiB，全部账号共享 8 GiB，并为文件系统保留空间。超过容量的改动仍保存在浏览器。会话与草稿都解除引用后，附件在 24 小时宽限期后回收。
- 将 `accounts.sqlite` 纳入 SQLite 在线备份。账号库与加密密钥配对恢复，保留每次升级前的一份一致快照。首次升级时先启动新版账号服务，再切换 Web 文件。回退旧版时保留升级后的账号库供再次启用同步。
- 静态 Web 包支持离线和本地凭据模式。使用账号功能时运行 Server 包。

## Deployment

Use Node.js 24 and extract the server ZIP. In Gitea, create a confidential OAuth2 application and register the exact `<public origin>/api/account/callback` URL. For a local trial, use `http://127.0.0.1:8788/api/account/callback`.

Copy `server/.env.example` to `.env` in the package root. Set the Gitea client ID and secret, comma-separated permitted Gitea usernames, and a 32-byte random base64 vault key. Restrict access to the configuration and the data directory. Back up the SQLite database and vault key separately, and restore them together.

Run `node --env-file=.env server/index.mjs`. The service binds to loopback. Place it behind an HTTPS reverse proxy for remote access. Sign in on the AI Hub landing page, then select **Sync to AI Hub account** when saving a provider. On another device, sign in with the same Gitea account to use the saved provider.

Preserve the external `Host` in the reverse proxy. During a domain change, set `AIHUB_ADDITIONAL_ORIGINS` to a comma-separated list of former origins and register each exact callback in Gitea. Sign in separately on each domain to access synced providers. Export chat history from the former domain and import it on the new one. Import replaces the history currently stored for the destination domain.

The server encrypts keys per user and proxies the supported provider APIs. Set `AIHUB_PROVIDER_ENDPOINTS` to a JSON object mapping trusted HTTPS API Base URLs to `deepseek` or `openai` to customize the allowlist.

Signed-in browsers sync conversations, original attachments, drafts, and preferences by default. **Data management** also offers browser-only storage and the option to merge older local chats. Each account has its own cache, retry queue, and browser-only provider settings. Single-user installations move legacy provider settings into that user's browser storage. Concurrent chat edits keep a conflict copy. The standalone Web ZIP uses browser-local storage.

Original attachments have a 64 MiB per-file limit. Workspace payloads are limited to 4 GiB per account and 8 GiB overall, with filesystem headroom reserved by the server. Unsynced changes remain in the browser. Detached files are eligible for cleanup after 24 hours. Include `accounts.sqlite` in an online SQLite backup and retain the corresponding vault key. Start the updated account server before switching the Web files during upgrades.
