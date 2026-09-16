# Runners & Agent Box

## Day-to-day (developers)

```bash
cd revenant-cloud && npm run db:migrate && npm run dev
```

Embedded worker handles jobs locally for demos.

## Agent Box (separate product)

**Repo:** `../revenant-agent` (not inside this monorepo)

```bash
cd ../revenant-agent
cp agent.example.yaml agent.yaml   # token from Cloud → Settings → Agent Box
npm install && npm start
```

Website users only click **Run**. Agent Box is a Node service (later Docker/binary), not something you import into the React app.

See [revenant-agent/README.md](../revenant-agent/README.md).

## Labels

| Mode                     | Meaning                |
| ------------------------ | ---------------------- |
| embedded / stub fallback | Local demo / Simulated |
| `agent`                  | Agent Box              |
| `ci`                     | CI worker              |

Edit revenant-cloud/packages/shared/src/plans.ts only:

export const STARTER_TRIAL_DAYS = 30; // 1 month free
export const STARTER_PRICE_INR = 999;
export const PRO_PRICE_INR = 4999;
That drives:

GET /api/v1/public/catalog (marketing can copy from here)
All plan limits (Starter / Pro)
Friendly error messages (prices pulled automatically)
After edits: npm run build -w @revenant/shared
