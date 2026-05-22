# TrendPulse

> Daily AI-curated digest of what's emerging across HN, GitHub trending, arxiv, Reddit.

**Live:** https://trendpulse.ivixivi.workers.dev

TrendPulse polls 5 sources every 4 hours, collects ~115 items per cycle, and synthesizes
3-7 cross-cutting themes using AI. The free web feed shows today's themes; paid tiers
get email + custom filters + webhook delivery.

## API

```
GET  /api/digest/latest    — Today's full digest
GET  /api/digest/history   — Last 30 daily digests
POST /api/run-now          — Manual trigger (30-min rate limit)
GET  /api/status           — System health
```

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

**Pay any rail:** GitHub Sponsors, crypto, BMC, latent Stripe.
See [`/api/rails`](https://vulnpulse.ivixivi.workers.dev/api/rails) for the canonical operator rail registry.

## Stack

- Cloudflare Workers (compute + cron)
- Cloudflare Workers AI — Llama 3.3 70B for theme synthesis
- Cloudflare KV — raw items + daily digest archive

## Sister products

TrendPulse is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) — LLM system-prompt analyzer
- [EdgarFlash](https://edgarflash.ivixivi.workers.dev) — Real-time SEC EDGAR alerts
- [WriteLens](https://writelens.ivixivi.workers.dev) — Pay-per-call text quality scoring
- [BountyScope](https://bountyscope.ivixivi.workers.dev) — Bug-bounty intel + smart-contract analyzer
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
