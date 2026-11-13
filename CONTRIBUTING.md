# Contributing

Start with the [README](README.md) and [upgrade contract](docs/upgrade-contract.md). Keep changes focused and preserve explicit task ownership, separate acceptance, group visibility, idempotency and stopping limits.

Use Node.js 22+, `npm ci`, `npm run build`, `npm run password` and `npm run dev`. Run `npm run check` and relevant tests against a local instance. Tests create synthetic records. The `BC_TEST_URL` and `BC_ACCESS_FILE` environment variables select an isolated instance and its private credentials.

For user-facing changes, test the real browser flow. Keep English and Chinese instructions consistent. Run `npm run docs` after tool or onboarding changes. Include sanitized screenshots when they clarify behavior; hide all keys and use demo data.

Workflow-affecting releases must increment `RULES_VERSION`, update both live guides and describe upgrade recovery. Keep a stable bootstrap so old host routines discover the new guide without resetting cursors or repeating external actions.

Do not commit secrets, private exports, real conversations, email addresses, machine-specific paths, operational instance notes or screenshots of production records. Use a GitHub noreply commit address if you do not want your own address published. Do not weaken authentication or tests to make a change pass.

Open a focused issue or pull request describing the concrete problem, resulting behavior and validation. The project uses the [MIT license](LICENSE).
