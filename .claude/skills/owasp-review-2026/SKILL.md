---
name: owasp-review-2026
description: Perform an OWASP-grade security review of a Node.js / TypeScript app — auth, authorization, injection, secrets, dependencies, SSRF, CSRF, prototype pollution, supply-chain. Use as a checklist before launch, after a major dep bump, or during incident response. Concrete grep patterns and grep-able anti-patterns included.
category: security
version: 0.1.0
tags: [security, owasp, audit, node, review]
recommended_npm: ["jose", "argon2", "audit-ci", "snyk"]
license: MIT
author: claude-code-skills
---

This is the review I run before any production launch. Goal: catch the boring 95% that audits charge $20k for.

## 1. Authentication

- Passwords hashed with **Argon2id** (memoryCost ≥ 19MiB, timeCost ≥ 2). Bcrypt is acceptable but legacy; never SHA*+salt, never MD5.
- Session tokens are random ≥ 256 bits. `crypto.randomBytes(32).toString('base64url')`.
- JWT only when stateless is required; otherwise opaque session IDs in Redis. If JWT: `jose` library, `EdDSA` or `ES256`, 15-min access + 7-day refresh, signed not encrypted (encryption is for confidential payloads only).
- Login rate-limited per IP and per username (separately).
- Account enumeration: same response for "wrong password" and "user not found".
- 2FA via TOTP (`otplib`), backup codes, never SMS.

## 2. Authorization

- Every protected route checks **resource ownership**, not just "is logged in". Grep: `findUnique({ where: { id }})` without a `userId` filter is the canonical bug.
- Role checks at the route level AND at the data layer (defense in depth).
- IDOR test: can user A fetch user B's resource by guessing IDs? Use UUIDs, but don't rely on opacity — enforce ownership.

## 3. Injection

- All SQL via parameterized queries (Drizzle, Prisma, `pg` with `$1`/`$2`). Grep: `` ` ``${...}` inside SQL strings.
- All shell calls via `execFile` / `spawn` with array args. Never `exec(\`cmd ${userInput}\`)`. `execa` is the safe default.
- HTML output through React/Vue templates (auto-escape) or `DOMPurify` for user-supplied HTML.
- LLM prompt injection: never trust agent output as a control signal. If the agent's text decides what to execute, sanitize / structurally constrain.

## 4. Secrets

- Never in git. Run `gitleaks detect` in CI.
- Never logged. Audit `console.log` calls near auth code. Use a structured logger that auto-redacts (`pino` with `redact: ['*.password', '*.token']`).
- `.env` files `chmod 600` on servers, owned by deploy user.
- Rotated regularly; document the rotation procedure.

## 5. Dependencies & supply chain

- `pnpm audit` / `npm audit` in CI, fail on `high` or above. `audit-ci --high` is the canonical tool.
- Lockfile committed (`pnpm-lock.yaml`).
- `pnpm install --frozen-lockfile` in CI (no surprise installs).
- Postinstall scripts disabled by default in CI: `pnpm install --ignore-scripts` for build, run scripts only for trusted packages.
- Pin major versions in `dependencies`; allow patch updates with renovatebot, reviewed weekly.

## 6. Web-specific

- **CSRF**: SameSite=Lax cookies + CSRF token on state-changing requests when supporting third-party origins.
- **CORS**: explicit origin allowlist. `*` only with `credentials: false`.
- **SSRF**: block requests to `127.0.0.1`, `10.0.0.0/8`, `192.168.0.0/16`, `169.254.169.254` (cloud metadata) unless explicitly allow-listed. The `ssrf-req-filter` package or a homegrown check.
- **Open redirects**: don't redirect to user-supplied URLs without an allow-list.
- **Headers**: `helmet` or Hono's `secureHeaders()` enables CSP, X-Frame-Options, X-Content-Type-Options.
- **Cookies**: `Secure`, `HttpOnly`, `SameSite=Lax`. `Domain` only when subdomains need access.

## 7. JavaScript-specific

- **Prototype pollution**: never `Object.assign(target, untrusted)` if `target` is `{}` (use `Object.create(null)`). Avoid `lodash.merge` on untrusted input.
- `JSON.parse` on untrusted input has no prototype-pollution risk by default; `__proto__` keys are not promoted in modern Node — but grep for any custom merge utilities.
- **Regex DoS (ReDoS)**: any user-supplied regex is a foot-gun. Use `safe-regex2` or run in a worker with a timeout.
- **eval / new Function**: forbidden, full stop. Same for `setTimeout("...code...")`.

## 8. Crypto

- Use `crypto.subtle` (Web Crypto) or `node:crypto`. Never roll your own AES, never `crypto.createHash('md5')` for security.
- Random for security: `crypto.randomBytes`, **not** `Math.random()`.
- Constant-time compare: `crypto.timingSafeEqual`, never `===` on tokens.

## 9. File uploads

- Whitelist content types by sniffing magic bytes (`file-type` package), not by trusting `Content-Type`.
- Store outside web root, serve through a controlled handler.
- Limit size (server-side, not just client).
- Run AV / sandbox if user-uploaded files are executed (e.g. PDFs, Office docs).

## 10. Operational

- Logs sent off-box (otherwise lost on incident).
- Sentry / equivalent for unhandled exceptions, with PII scrubbing.
- Error responses don't leak stack traces or DB schema in prod.
- Admin endpoints behind a separate auth (mTLS, IP allow-list, or platform-level access policy).

## Anti-patterns (grep these immediately)

- `process.env.NODE_ENV === 'development'` to skip auth in prod by accident
- `Authorization: Bearer ${token}` with no validation of token shape
- `app.use(cors({ origin: true, credentials: true }))` — equivalent to `*` with credentials
- `bcrypt.compare(plain, hash, callback)` — async callback variant where callback isn't awaited
- `parseInt(req.body.amount)` — no bounds check
- `fs.readFile(req.params.file)` — path traversal
- `redirect(req.query.next)` — open redirect
- `eval(...)` of any kind

## Quality gates

- `audit-ci --high` passes in CI.
- `gitleaks` / `trufflehog` finds nothing in git history.
- All routes pass IDOR check (manual review or automated test).
- Headers from `securityheaders.com` score A or A+.
- Rate-limit verified by load test.
- Auth flows have integration tests for common bypasses.
