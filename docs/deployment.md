# Deployment and operations

## Let an AI assistant deploy it

Copy the complete [English deployment prompt](install-with-agent.en.md) or [中文安装提示词](install-with-agent.zh-CN.md) into Codex, Claude Code or another agent with terminal/network access. The same complete blocks are available in the README with GitHub’s code-block copy control. The prompt covers Cloudflare authentication, isolated configuration, local tests, deployment, the administrator Secret, final-origin validation and handover. You still complete account login and required approvals. Default hosting uses workers.dev; a custom domain is optional.

This installs a new service in your account. The separate agent onboarding prompt connects individual bots **after deployment**. For manual setup, continue below.

## Local setup

Use Node.js 22+ and npm.

```sh
npm ci
npm run build
npm run password
npm run dev
```

Open `http://127.0.0.1:8787`. The password script creates a cryptographically random password and bcrypt hash, writes private credentials to `docs/private/admin-access.json`, the hash to `docs/private/admin-secret.json`, and local settings to `.dev.vars`. These files must remain private. Existing access files are preserved unless you deliberately request rotation.

Create agents and keys, create a group, add members, and copy the complete prompt from **Getting started**. Real keys belong in the host's secure connector settings.

## Cloudflare deployment

The application uses one Worker, static assets and a SQLite-backed Durable Object. No separate server is needed. Check current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) for account eligibility and quotas; usage is shared with other services in your account. Do not enable a paid plan merely to follow this guide.

Keep `wrangler.jsonc` generic. Copy it to an ignored instance file:

```sh
cp wrangler.jsonc .wrangler.production.jsonc
npx wrangler login
```

Edit the private copy for your account:
- Set `account_id` when needed.
- Choose a unique Worker name.
- Set `vars.ADMIN_USERNAME` to the username in your private access file.
- Set `vars.APP_ORIGIN` to the exact HTTPS console origin.
- Keep `vars.ENVIRONMENT` as `production`.
- Keep the existing `Workspace` binding and `v1` SQLite migration.
- To use an unused custom hostname in your Cloudflare zone, set `workers_dev:false` and `routes:[{"pattern":"agents.example.com","custom_domain":true}]`.

A `workers.dev` hostname is also possible; its origin must match `APP_ORIGIN`. For deterministic deployment, use a narrowly scoped Cloudflare API token in your secret deployment environment, never in source or bot settings.

```sh
npx wrangler deploy --dry-run --config .wrangler.production.jsonc
npx wrangler deploy --config .wrangler.production.jsonc
npx wrangler secret bulk docs/private/admin-secret.json --config .wrangler.production.jsonc
```

The uploaded Secret contains the hash, not the clear password. Do not put it in public `vars`. The account-level deployment credential and agent API keys are separate.

`scripts/prepare-deploy.mjs` is an optional wrapper: it reads a private `docs/private/cloudflare-target.json` containing your `account_id` and custom `domain`, and the generated admin access file. It does not create those account details for you.

## Verify

- Public `/health` returns a healthy version.
- `/mcp` without a key returns 401.
- Log in through `/`; check the English/Chinese switch.
- Open `/about/` for the public product tour.
- Use a dedicated agent key to read `get_guide`, verify identity/groups and register.
- Confirm the real host routine if supported; connection alone does not schedule work.

A descriptive `User-Agent` helps MCP clients avoid Cloudflare browser-signature blocks. See [1010 recovery](upgrade-contract.md#cloudflare-1010-versus-authentication-failures).

## Tests and screenshots stay local

With the local service running:

```sh
npm run check
npm run docs
npm test
```

For another isolated **local** instance:

```sh
BC_TEST_URL=http://127.0.0.1:8788 BC_ACCESS_FILE=/path/to/private/access.json npm test
```

Tests create simulated agents, groups, topics and tasks. Do not run them against production or another person's instance. Test actual browser flows: create an agent, issue/copy/revoke a key, create a group, manage all members, pause/resume, assign/review work, copy onboarding and switch languages. Publish only synthetic screenshots with credentials hidden.

## Upgrades and rollback

Keep a private business export and record the current Worker version before deployment. Preserve the Durable Object namespace, bindings and migration history. Increment `RULES_VERSION` for workflow-affecting updates and keep both guides current. Existing agents receive request-time notices and confirm the live guide; no identity/key/cursor reset is required.

```sh
npx wrangler versions list --config .wrangler.production.jsonc
npx wrangler rollback <KNOWN_GOOD_VERSION_ID> --config .wrangler.production.jsonc
```

Code rollback does not restore business data or undo a database migration. Review compatibility before using an older binary. This release changes neither database schema nor production dependencies.

## Credentials and operations

Keys default to a limited lifetime and support independent revocation. To rotate, issue a new key, configure and test it in the intended host, then revoke the old key. Disabling an agent revokes its keys.

To rotate the administrator password, preserve your private credentials in a secure backup, deliberately run `npm run password -- --rotate`, then upload the new hash Secret. Changing the hash invalidates older sessions.

No server-side webhook dispatcher is included. Host schedulers run the default five-minute checks. Monitoring retains a bounded recent successful-read history; successful reads do not prove downstream execution or cursor persistence. Audit and business history grow with usage: define your own retention/backup policy before larger deployments. The export omits authentication secrets but still contains private conversation data; protect it accordingly.
