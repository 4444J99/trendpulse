# TrendPulse

> Daily AI-curated digest of what's emerging across HN, GitHub trending, arxiv, Reddit.

**Live:** https://trendpulse.ivixivi.workers.dev

TrendPulse polls 5 sources every 4 hours, collects ~115 items per cycle, and synthesizes
3-7 cross-cutting themes using AI. The free web feed shows today's themes; paid tiers
get email + custom filters + webhook delivery.

## API

```
GET  /api/digest/latest    — Today's full digest                    (free)
GET  /api/digest/history   — Last 30 daily digests                  (free)
POST /api/run-now          — Manual trigger (30-min rate limit)     (free)
GET  /api/status           — System health                         (free)
GET  /api/config           — Public config (checkout link, flags)  (free)

POST   /api/license/check  — Validate a Lemon Squeezy license key   (premium)
GET    /api/digest/custom  — Keyword/source-filtered digest         (premium)
GET    /api/delivery       — View your delivery registration        (premium)
POST   /api/delivery       — Register webhook/email delivery        (premium)
DELETE /api/delivery       — Remove your delivery registration      (premium)
```

Premium endpoints require an **active Lemon Squeezy subscription**. Pass the
license key as `Authorization: Bearer <key>`, an `X-License-Key` header, a
`?key=` query param, or a `license_key` body field. Without a valid key they
return **402 Payment Required** with the checkout link.

## Sources

- Hacker News top stories
- GitHub trending (recent stars)
- arxiv cs.AI new submissions
- Reddit /r/MachineLearning, /r/programming

## Pricing

| Tier  | Price    | What's included                               |
|-------|----------|-----------------------------------------------|
| Free  | $0       | Web feed + daily digest + public API          |
| Pro   | $29/mo   | Daily email + custom filters + history search |
| Team  | $99/mo   | 5 seats + webhook delivery + custom sources   |

Subscriptions are billed via **Lemon Squeezy** (merchant of record — handles
tax/VAT). On checkout the subscriber receives a **license key**; pasting it into
the landing page or sending it on the premium API unlocks custom filtering and
custom delivery. The key's status tracks the subscription, so cancellations and
expirations re-lock access automatically.

### Going live

1. In Lemon Squeezy, create a subscription product with two variants (`Pro`,
   `Team`) and enable **License keys** on it.
2. Set the checkout link: `CHECKOUT_URL` in `wrangler.toml` →
   `https://<store>.lemonsqueezy.com/buy/<variant-uuid>`.
3. (Optional) Enable email delivery: `wrangler secret put RESEND_API_KEY` and
   set `FROM_EMAIL`. Webhook delivery (Team) needs no provider.
4. `wrangler deploy`.

License validation hits the public Lemon Squeezy license API and needs **no API
secret** — the license key itself is the credential. Results are cached in KV
for 10 minutes.

## Stack

- Cloudflare Workers (compute + cron)
- Cloudflare Workers AI — Llama 3.3 70B for theme synthesis
- Cloudflare KV — raw items + daily digest archive

## Development

```
npm install        # install toolchain (TypeScript, ESLint, Vitest, Wrangler)
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm test           # Vitest unit tests
npm run build      # wrangler deploy --dry-run (bundle check, no deploy)
npx wrangler dev   # run locally
```

CI runs lint + typecheck + test + build on every pull request and on pushes to
`main` (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Sister products

TrendPulse is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) — LLM system-prompt analyzer
- [EdgarFlash](https://edgarflash.ivixivi.workers.dev) — Real-time SEC EDGAR alerts
- [WriteLens](https://writelens.ivixivi.workers.dev) — Pay-per-call text quality scoring
- [BountyScope](https://bountyscope.ivixivi.workers.dev) — Bug-bounty intel + smart-contract analyzer
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
