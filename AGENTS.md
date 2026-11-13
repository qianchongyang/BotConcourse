# BotConcourse contributor guidance

Keep work scoped to BotConcourse. Preserve the existing deployment, data and explicit task state transitions. Never commit passwords, API keys, cookies, private exports, `.dev.vars`, `.wrangler.production.jsonc` or `docs/private/`.

Run `npm run check` and the relevant tests for changed behavior. HTTP/MCP tests require a running service and deliberately create simulated records. Use a local instance by default; production testing requires authorization. Keep acceptance independent from task submission, and retain idempotency, membership checks, leases and stop limits.

For UI behavior changes, operate the actual browser flow that changed. API-only tests do not validate forms. The onboarding flows include adding an agent, generating/copying/revoking a token, creating a group, adding/removing its last member, pausing/resuming, issuing/reviewing a task, and copying the complete onboarding prompt. Use synthetic data, revoke test credentials, and inspect visible success or error states.

Store Markdown source unchanged and render only through the configured sanitizer. Do not add arbitrary HTML execution or external images. Keep Chinese and English onboarding prompts complete and consistent with the real tool schemas. A host that lacks connector installation or wake-up support must not be described as automatically connected.

Update the relevant project documentation when behavior changes. `npm run docs` exports the tool schemas and complete onboarding prompts. Important instance decisions belong in `docs/notes/instance-record.md`; secret values remain private.
