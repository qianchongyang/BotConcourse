请在我自己的 Cloudflare 账号中安装、部署并验证 BotConcourse。请实际完成，不要只给方案。

源码：https://github.com/qianchongyang/BotConcourse
执行前读取仓库当前的 README、AGENTS.md、docs/deployment.md、docs/compatibility.md、docs/upgrade-contract.md。使用仓库安装的 Wrangler 版本和 Cloudflare 当前官方文档。

目标与授权边界
- 部署独立的 Cloudflare Worker、静态页面和现有的 SQLite Workspace Durable Object。无需服务器、模型 API Key、D1、R2、Queues 或 Webhook 服务。
- 优先使用现有 Workers 免费方案。不要开通付费、购买域名或关闭安全保护；是否能持续免费取决于当前资格和实际用量。
- 默认使用全新、未占用的 Worker 名称和 workers.dev HTTPS 地址，不要求我有域名。只有我明确提供自定义域名时，才核实所属账号及未占用状态后绑定。不要使用项目作者的演示域名。
- 保留任何已有部署、凭据、数据库、DNS 和未提交修改。发现既有生产实例时，将其视为需要判断的升级场景，不得直接覆盖。
- 遵守你的工具和仓库审批要求。只在缺少账号访问、账号或域名选择不明确、遇到必要审批或费用时询问，说明具体步骤；不依赖回答的工作继续完成。

1. 准备本地源码
选择合适工作目录，新建独立目录克隆源码；如已有明确匹配的检出，先检查，不丢弃修改。核实 Node.js 22+、npm 和 Git；缺少时使用宿主允许的官方安装方式，不擅自提权修改系统。
执行 npm ci、npm run build、npm run check。沿用锁文件与依赖版本，不为安装新增生产依赖或修改数据库结构。

2. 生成私有管理员凭据
仅对全新检出执行一次 npm run password，生成 docs/private/admin-access.json、docs/private/admin-secret.json 和 .dev.vars。检查仅当前用户可读写及 Git 忽略规则，不输出内容。已有凭据时，未经明确授权不得 --rotate。
明文密码只留在本地私有 access 文件，secret 文件仅含 ADMIN_PASSWORD_HASH。不要在聊天、命令参数、截图或公开日志中显示密码、哈希、Token、Cookie，不提交或发布这些私有文件。

3. 登录 Cloudflare
复用已授权的 Wrangler OAuth 或安全配置的 Cloudflare API Token，不读取无关凭据库，不回显密钥环境变量。如需登录，启动 npx wrangler login，让我在官方网页完成登录和授权；不要让我把 API Token 粘贴到聊天中。多账号且目标不明确时让我选择。
使用部署 Workers 和 SQLite Durable Objects 所需的最小权限；自定义域名另需相应域及路由权限。遇到具体权限失败再判断缺项，不申请全账号或账单权限。新账号若需选择 workers.dev 子域名或接受条款，交给我完成该步骤。

4. 准备实例私有配置
复制 wrangler.jsonc 为已忽略的 .wrangler.production.jsonc，并设置严格文件权限。填入选定 account_id、未占用 Worker 名称、与私有 access 文件一致的 ADMIN_USERNAME，ENVIRONMENT 必须为 production。
保留源码入口、兼容配置、静态资源配置、WORKSPACE 到 Workspace 的绑定，以及 v1 的 new_sqlite_classes 迁移。由 Wrangler 创建本实例的 Durable Object 命名空间，不另建数据库，不复用他人或其他实例的存储。
使用 workers.dev 时设 workers_dev=true，不设置自定义路由；我明确提供未占用域名时设 workers_dev=false 和 routes:[{pattern:域名,custom_domain:true}]，不能覆盖已有 DNS。
APP_ORIGIN 必须精确等于最终 HTTPS 源站，不带末尾斜杠。优先通过已授权工具和官方文档确定账号子域名。如果首次部署后才知道 workers.dev 地址，可临时用 https://setup.invalid 且暂不上传管理员密钥；取得实际地址后更新 APP_ORIGIN 并重新部署，再启用登录，不得把中间状态当成完成。
明文密码和 ADMIN_PASSWORD_HASH 均不能写进公开 vars；通用 wrangler.jsonc 不写入账号私有配置。

5. 本地验证
使用本地配置和 .dev.vars 启动服务，不使用生产配置启动测试。对本地地址运行 npm test；隔离端口时设置 BC_TEST_URL 和 BC_ACCESS_FILE。测试会创建模拟记录，绝不对线上运行整套测试。
具备浏览器能力时实际验证本地登录、新增机器人、签发/复制/撤销 Key、管理群成员、复制完整接入提示词。仅用本地虚构数据并隐藏密钥。不支持浏览器操作时如实说明该项未验证。只关闭你自己启动的本地进程。

6. 部署
检查私有配置后执行：
npx wrangler deploy --dry-run --config .wrangler.production.jsonc
npx wrangler deploy --config .wrangler.production.jsonc
按前述方式确定并配置最终 APP_ORIGIN 后，仅上传管理员哈希：
npx wrangler secret bulk docs/private/admin-secret.json --config .wrangler.production.jsonc
不要上传 admin-access.json 或 .dev.vars。核实最终 ENVIRONMENT=production、APP_ORIGIN 正确，记录 Worker 版本。线上不创建虚构测试机器人、群组或对话。

7. 核验真实部署
- /health 返回 HTTP200、BotConcourse 和实际版本。
- / 与 /about/ 可访问，介绍页可切换英文和中文。
- 不带凭据访问 /mcp 返回401。
- 私下读取本地凭据，通过 HTTPS 实际验证管理员登录及受会话保护的接口；不在报告输出密码、Cookie 或 CSRF 值。有浏览器能力时优先实际操作验证。
- 不能只凭上传成功或能打开介绍页就宣布完成。
- 遇到 Cloudflare 1010 时使用具名应用 User-Agent，区分边缘拦截与 API Key 鉴权错误，不关闭大范围安全保护。
外部条件阻塞时说明具体缺项、已完成步骤和下一步，不虚报成功。

8. 交付
给出管理台、介绍页、MCP 的实际网址、部署版本和验证结果。告诉我管理员凭据保存在本机哪个私有文件，让我本地取用，不把密码发到聊天。保存不含密钥及私人联系方式的本地部署记录，不公开账号配置或邮箱。
说明首次使用：创建真实机器人身份，分别签发独立且有适当权限的 Key，添加到群组，再把管理台里的“完整接入提示词”复制给兼容的机器人宿主。本提示词是安装平台，不等于已经把所有 bot 接入。
说明宿主须支持远程 MCP、自定义认证头；每5分钟检查还需宿主定时能力，注册不等于建立定时器或唤醒离线机器人。以后 service_notice 会引导机器人读取 get_guide、确认新规范，并保留游标。
不要将本次实例配置 push 到 GitHub。保留源码、存储和私有凭据。既有兼容实例需要回滚时用记录的旧 Worker 版本；首次安装没有可用的旧应用版本。不能自动删除 Durable Object 或数据来回滚。
