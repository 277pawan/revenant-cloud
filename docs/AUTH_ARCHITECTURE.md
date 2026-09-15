# Auth architecture — password, SSO, invites, billing

Revenant Cloud auth is designed for **two humans**:

1. **Organization founder** — creates org, becomes admin, picks plan (billing later).
2. **Team member** — invited into an existing org, never creates a new org.

Marketing website + app will share identity via **SSO** so `organizationPlan` is known at login.

The marketing **frontend does not exist yet**. The API is ready:

1. `GET /api/v1/public/catalog` — pricing + SSO provider flags (no auth).
2. `CORS_ORIGIN` is comma-separated so `https://revenant.example` and `https://app.revenant.example` can both call the API with credentials.
3. Set `COOKIE_DOMAIN=.revenant.example` later so the session cookie is shared.
4. OAuth `state` is HMAC-signed; `returnTo` must be a relative path or an origin on the CORS list.
5. `GET /api/v1/me` already returns `organizationPlan` — website and app use the same session.

Do **not** build a public share URL for evidence. People download a PDF and share it themselves.

---

## Current (shipped)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/auth/register` | Founder creates org + admin user |
| `POST /api/v1/auth/login` | Email + password session (JWT + httpOnly cookie) |
| `POST /api/v1/auth/logout` | Clear session |
| `GET /api/v1/me` | Session user + plan from DB |
| `GET /api/v1/auth/providers` | OAuth buttons + registration flags for UI |
| `GET /api/v1/auth/invite/:token` | Preview org/role for invite link banner |
| `GET /api/v1/public/catalog` | Unauthenticated: plans, SSO button status, app login URL (for the future website) |
| `GET /api/v1/auth/oauth/:provider/start` | HMAC-signed `state` + `returnTo` allowlist (app or marketing origin) |
| `GET /api/v1/auth/oauth/:provider/callback` | Token exchange, user linking, session cookie, redirect to app |

## Database (migration `0011`)

- `users.password_hash` — **nullable** (OAuth-only users)
- `user_auth_providers` — links `user_id` ↔ `provider` + `provider_subject`
- `organization_invites` — hashed tokens, expiry, role (replaces admin-set passwords)

## SSO recommendation

**Ship order:**

1. **Google** — default for business email; fastest “Continue with Google”
2. **GitHub** — perfect for DevOps/SRE buyers of Revenant

**Do not** add Apple/Facebook/Microsoft — wrong audience or deferred.

Single sign-on UX: one row of provider buttons **above** email/password (password remains fallback for invited users until invite links ship).

## Invite flow (Phase 2)

```
Admin invites email → organization_invites row + email link
Member opens /login?invite=TOKEN → banner shows org + role
Member sets password OR uses Google (same email) → accept invite
```

## Billing + plan (Phase 3)

```
Marketing site checkout (Razorpay) → org.plan updated
SSO login → JWT includes organizationPlan (already on AuthUser)
App enforces limits from packages/shared/src/plans.ts
```

## Security notes

- Invite tokens stored as **SHA-256** only (`token_hash`)
- OAuth `state` param carries return URL (signed in production)
- No org name lookup by email (enumeration) — use invite token only
- `ALLOW_OPEN_REGISTRATION=false` for public deploy until billing ready

## Env vars

See `.env.example` — `OAUTH_*_CLIENT_ID/SECRET`, `PUBLIC_APP_URL`, `PUBLIC_MARKETING_URL`, `COOKIE_DOMAIN`.

When OAuth secrets are unset, UI shows providers as **coming soon**; API returns `501` on OAuth start.
