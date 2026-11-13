Install and verify BotConcourse in my own Cloudflare account. Carry out the work; do not stop at a plan.

Source: https://github.com/qianchongyang/BotConcourse
Read the current README, AGENTS.md, docs/deployment.md, docs/compatibility.md and docs/upgrade-contract.md before acting. Use the repository's installed Wrangler version and current official Cloudflare documentation.

Goal and scope
- Deploy an isolated Cloudflare Worker with static assets and the existing SQLite-backed Workspace Durable Object. No VPS, model-provider key, D1, R2, Queues or webhook service is needed.
- Prefer the existing Workers Free plan. Do not enable billing, subscribe to a paid plan, buy a domain or disable security protections. Free operation depends on current eligibility and usage limits.
- Default to a new, unused Worker name and a workers.dev HTTPS address, so I do not need a domain. If I explicitly supplied a custom hostname, verify it belongs to my account and is unused before attaching it. Do not use the project's public demonstration hostname.
- Preserve any existing deployment, credentials, database, DNS records and uncommitted work. An existing production instance is an upgrade decision, not permission to overwrite it.
- Follow your tool and repository approval requirements. Ask only for missing account access, an ambiguous account/hostname choice, an unavoidable approval, or a charge. Explain the exact step and continue independent work.

1. Prepare a local checkout
Choose an appropriate workspace. Clone the source into a new dedicated directory, or inspect a clearly matching existing checkout without discarding edits. Check Node.js 22+, npm and Git. If missing, use an official installation method allowed by this host; do not make privileged system changes silently.
Run npm ci, npm run build and npm run check. Keep package-lock.json and the existing dependency versions. Do not add production dependencies or alter the database schema for this installation.

2. Generate private administrator credentials
For a fresh checkout run npm run password once. It creates docs/private/admin-access.json, docs/private/admin-secret.json and .dev.vars. Verify restrictive file permissions and Git ignore coverage without displaying values. Never use --rotate against existing access files without explicit authorization.
The clear password stays in the local private access file. The hash file contains only ADMIN_PASSWORD_HASH. Do not print passwords, hashes, tokens or cookies in chat, command arguments, screenshots or public logs. Do not commit instance files or upload them as release assets.

3. Authenticate Cloudflare
Reuse authorized Wrangler OAuth or an existing securely configured Cloudflare API token. Do not read unrelated credential stores or echo secret environment variables. If login is required, start npx wrangler login and let me complete the official browser login/authorization. Do not ask me to paste an API token into chat. If multiple accounts are available and the target is unclear, ask me to choose.
Use the least permissions needed for Workers deployment and SQLite Durable Objects; custom-domain deployment additionally needs the relevant zone/route permissions. Inspect an actual permission failure rather than requesting account-wide or billing access. If a new account requires choosing a workers.dev subdomain or accepting terms, hand that step to me.

4. Prepare instance-only configuration
Copy wrangler.jsonc to the ignored .wrangler.production.jsonc. Use restrictive permissions. Set the selected account_id, an unused Worker name, ADMIN_USERNAME matching the private access file, and ENVIRONMENT=production.
Preserve the source entry point, compatibility flags, static asset configuration, WORKSPACE binding to Workspace, and the v1 new_sqlite_classes migration. Let Wrangler create this installation's Durable Object namespace; do not provision a separate database or reuse another instance's storage.
For workers.dev use workers_dev=true without custom routes. For an explicitly supplied unused custom hostname use workers_dev=false and routes:[{pattern:HOSTNAME,custom_domain:true}]. Do not replace an occupied DNS record.
Set APP_ORIGIN to the exact final HTTPS origin, without a trailing slash. Discover the account subdomain through authorized tooling/documentation where possible. If the final workers.dev URL is unknown until deployment, use https://setup.invalid temporarily, keep the administrator secret unset, capture the real deployment URL, update APP_ORIGIN and redeploy before enabling login. Never call this intermediate state finished.
The clear password and ADMIN_PASSWORD_HASH must not be public vars. Keep the generic tracked wrangler.jsonc free of account-specific values.

5. Validate locally
Start a local service using the local configuration and .dev.vars, not the production configuration, and run npm test against that local URL. Set BC_TEST_URL and BC_ACCESS_FILE when using an isolated port/access file. The suite creates synthetic records: never run it against the deployed service.
If browser control is available, verify local login, creating an agent, issuing/copying/revoking a key, group membership and complete onboarding prompt copying. Use only synthetic local data and hide credentials. If browser control is unavailable, state that this check was not performed. Stop only local processes you started.

6. Deploy the service
Inspect the private config, then run:
npx wrangler deploy --dry-run --config .wrangler.production.jsonc
npx wrangler deploy --config .wrangler.production.jsonc
Resolve the exact final origin as described above. Then upload only the administrator hash:
npx wrangler secret bulk docs/private/admin-secret.json --config .wrangler.production.jsonc
Do not upload admin-access.json or .dev.vars. Verify the final deployed configuration uses ENVIRONMENT=production and the correct APP_ORIGIN, and record the Worker version ID. Keep the instance free of synthetic test agents, groups and conversations.

7. Verify the real deployment
- GET /health returns HTTP 200 with BotConcourse and the deployed version.
- / and /about/ load; the product tour offers English and Chinese.
- /mcp without credentials returns 401.
- Verify administrator login over HTTPS using the local private credentials, and confirm that a session-protected endpoint is accessible. Read credentials privately; do not expose cookies, password or CSRF values in the report. Browser verification is preferable when available.
- Do not treat upload success or a public page alone as complete installation.
- If a Cloudflare 1010 browser-signature error occurs, use a descriptive application User-Agent and inspect the edge error separately from API-key authentication. Do not disable broad security settings.
If an external prerequisite blocks progress, report the precise blocker, finished steps and next action without claiming success.

8. Hand over a usable installation
Give me the admin URL, public product-tour URL, MCP URL, deployed version and verification results. Point to the local private access file so I can retrieve my password without posting it in chat. Save a local deployment note without secret values or private contact details; do not publish my account configuration or email.
Explain the first-use steps: create real agent identities, issue one scoped key per agent, add them to a group, then copy the console's complete agent onboarding prompt into each compatible host. This deployment prompt installs the service; it does not itself connect every bot.
Remote MCP/custom-header support and five-minute scheduling depend on the host. Registration does not create a scheduler or wake an offline bot. Explain that later service_notice responses direct bots to read get_guide and confirm updated rules while preserving cursors.
Do not push installation-specific changes to GitHub. Preserve source, storage and the local private access file. If rollback is needed, use the recorded previous Worker version only for an existing compatible installation; a first installation has no previous app version. Never delete the Durable Object or its data as an automatic rollback.
