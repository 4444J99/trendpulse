/**
 * TrendPulse — continuous market/news research worker.
 *
 * Cron pulls from multiple sources, stores raw items, periodically synthesizes
 * a digest using Workers AI. Operator's intel; also sold as paid product.
 *
 * Sources:
 *   - Hacker News top stories
 *   - GitHub trending (proxied via search API: most-starred recent)
 *   - arxiv cs.AI new submissions
 *   - Reddit /r/MachineLearning, /r/programming
 */

export interface Env {
  AI: any;
  ASSETS: Fetcher;
  TP_DATA: KVNamespace;
  TP_DIGEST: KVNamespace;
  USER_AGENT: string;
  // --- Monetization (Lemon Squeezy) ---
  CHECKOUT_URL?: string;        // public LS checkout link, surfaced to the UI
  // --- Custom email delivery (optional; webhook delivery needs no provider) ---
  RESEND_API_KEY?: string;      // secret — if set, email delivery is enabled
  FROM_EMAIL?: string;          // e.g. "TrendPulse <digest@yourdomain.com>"
}

export type Source = 'hn' | 'github' | 'arxiv' | 'reddit-ml' | 'reddit-prog';

export interface Item {
  source: Source;
  title: string;
  url: string;
  score?: number;
  comments?: number;
  collected_at: string;
  summary?: string;
}

export interface Digest {
  generated_at: string;
  date_label: string;       // YYYY-MM-DD
  themes: { name: string; rationale: string; example_titles: string[]; signal_strength: 'rising' | 'steady' | 'spike' }[];
  one_line: string;
  source_counts: Record<string, number>;
}

type ServiceStatus = 'initializing' | 'healthy' | 'stale';

interface StatusSnapshot {
  name: 'TrendPulse';
  status: ServiceStatus;
  generated_at: string;
  collection: {
    raw_collection_count: number;
    raw_collection_count_truncated: boolean;
    last_collection_at: string | null;
    last_collection_age_seconds: number | null;
    recent_collections: string[];
  };
  digest: {
    has_latest: boolean;
    latest_date: string | null;
    latest_generated_at: string | null;
    latest_age_seconds: number | null;
    theme_count: number;
    source_counts: Record<string, number>;
    history_count: number;
    history_count_truncated: boolean;
  };
  usage: {
    delivery_registrations: number;
    delivery_registrations_truncated: boolean;
    custom_digest_caches: number;
    custom_digest_caches_truncated: boolean;
  };
  operations: {
    manual_run_last_at: string | null;
    manual_run_cooldown_seconds: number;
  };
  config: {
    premium_enabled: boolean;
    email_delivery_enabled: boolean;
  };
}

const RAW_KEY_PREFIX = 'raw:';
const DIGEST_KEY_PREFIX = 'digest:';
const LATEST_KEY = 'digest:latest';
const MANUAL_RUN_KEY = 'last_manual_run';
const MANUAL_RUN_COOLDOWN_MS = 30 * 60 * 1000;
const STATUS_STALE_AFTER_MS = 30 * 60 * 60 * 1000;
const KV_COUNT_LIMIT = 1000;

// === Monetization: Lemon Squeezy license gate ===
//
// Premium features (custom filtering + custom delivery) are gated behind an
// active Lemon Squeezy subscription. We use LS *license keys*: enable "License
// keys" on the subscription product, the subscriber gets a key, and they pass
// it to TrendPulse. We validate it against the public LS license API — no API
// secret needed, since the key itself is the credential. Subscription status
// (active / past_due cancel / expired) is reflected in the key status, so a
// short-cached validate call is enough to keep the gate live.

const LS_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const LIC_CACHE_PREFIX = 'lic:';        // cached validation result (TP_DATA)
const LIC_CACHE_TTL = 10 * 60;          // 10 min — long enough to cut API calls, short enough to honor cancellations
const DELIVERY_PREFIX = 'delivery:';    // one registration per license (TP_DATA)
const CUSTOM_PREFIX = 'custom:';        // cached custom digests (TP_DIGEST)

type Tier = 'free' | 'pro' | 'team';

interface LicenseResult {
  valid: boolean;
  status: string;          // active | inactive | expired | disabled | unknown
  tier: Tier;
  email?: string;
  expires_at?: string | null;
  error?: string;
}

interface DeliveryRegistration {
  license_hash: string;
  license_key?: string;             // stored server-side only so cron can re-check entitlement
  tier: Tier;
  email?: string;
  webhook?: string;
  webhook_secret?: string;          // optional — HMAC-signs the webhook payload
  filters?: { keywords?: string[]; sources?: Source[] };
  created_at: string;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Map a Lemon Squeezy variant name to an internal tier. Anything active is at
// least Pro; variants mentioning "team" unlock Team-only features (webhooks).
export function tierFromVariant(variantName: unknown): Tier {
  const v = String(variantName ?? '').toLowerCase();
  if (v.includes('team') || v.includes('enterprise') || v.includes('business')) return 'team';
  return 'pro';
}

async function validateLicense(env: Env, rawKey: string | null | undefined): Promise<LicenseResult> {
  const key = (rawKey ?? '').trim();
  if (!key) return { valid: false, status: 'missing', tier: 'free', error: 'no license key provided' };

  const hash = await sha256Hex(key);
  const cacheKey = `${LIC_CACHE_PREFIX}${hash}`;
  const cached = await env.TP_DATA.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached) as LicenseResult; } catch {}
  }

  let result: LicenseResult;
  try {
    const resp = await fetch(LS_VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': env.USER_AGENT,
      },
      body: new URLSearchParams({ license_key: key }).toString(),
    });
    const data: any = await resp.json().catch(() => ({}));
    const status = String(data?.license_key?.status ?? 'unknown');
    const valid = data?.valid === true && status === 'active';
    result = {
      valid,
      status,
      tier: valid ? tierFromVariant(data?.meta?.variant_name) : 'free',
      email: data?.meta?.customer_email ? String(data.meta.customer_email) : undefined,
      expires_at: data?.license_key?.expires_at ?? null,
      error: valid ? undefined : String(data?.error ?? `license ${status}`),
    };
  } catch (err) {
    // LS unreachable — don't grant access, but don't cache the failure.
    console.error('license validation failed:', err);
    return { valid: false, status: 'unreachable', tier: 'free', error: 'license service unavailable' };
  }

  // Cache both positive and negative (definitive) results briefly.
  await env.TP_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: LIC_CACHE_TTL });
  return result;
}

// Pull a license key from the request: Authorization: Bearer, X-License-Key
// header, ?key= query param, or a JSON/form body field `license_key`.
export function licenseFromRequest(req: Request, url: URL, body?: any): string | null {
  const auth = req.headers.get('Authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const hdr = req.headers.get('X-License-Key');
  if (hdr) return hdr.trim();
  const q = url.searchParams.get('key') || url.searchParams.get('license_key');
  if (q) return q.trim();
  if (body && typeof body === 'object') {
    const b = body.license_key || body.key;
    if (b) return String(b).trim();
  }
  return null;
}

function paywall(env: Env, lic: LicenseResult, needed: Tier = 'pro'): Response {
  return Response.json({
    error: 'premium feature — active subscription required',
    detail: lic.error ?? `requires ${needed} tier`,
    your_status: lic.status,
    your_tier: lic.tier,
    upgrade: env.CHECKOUT_URL ?? null,
  }, { status: 402 });   // 402 Payment Required
}

export function tierMeets(have: Tier, need: Tier): boolean {
  const rank: Record<Tier, number> = { free: 0, pro: 1, team: 2 };
  return rank[have] >= rank[need];
}

// === Source fetchers ===

async function fetchHN(env: Env): Promise<Item[]> {
  // Top story IDs first, then top 30 details.
  const idsResp = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
    headers: { 'User-Agent': env.USER_AGENT },
  });
  if (!idsResp.ok) return [];
  const ids = (await idsResp.json() as number[]).slice(0, 30);
  const items: Item[] = [];
  for (const id of ids) {
    try {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        headers: { 'User-Agent': env.USER_AGENT },
      });
      if (!r.ok) continue;
      const it: any = await r.json();
      if (!it?.title) continue;
      items.push({
        source: 'hn',
        title: String(it.title),
        url: it.url ? String(it.url) : `https://news.ycombinator.com/item?id=${id}`,
        score: Number(it.score ?? 0),
        comments: Number(it.descendants ?? 0),
        collected_at: new Date().toISOString(),
      });
    } catch {}
  }
  return items;
}

async function fetchGithubTrending(env: Env): Promise<Item[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const r = await fetch(`https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=30`, {
    headers: { 'User-Agent': env.USER_AGENT, 'Accept': 'application/vnd.github+json' },
  });
  if (!r.ok) return [];
  const data: any = await r.json();
  return (data.items ?? []).map((it: any): Item => ({
    source: 'github',
    title: `${it.full_name} — ${it.description ?? ''}`.slice(0, 240),
    url: it.html_url,
    score: it.stargazers_count,
    collected_at: new Date().toISOString(),
  }));
}

async function fetchArxiv(env: Env): Promise<Item[]> {
  // Use the query API instead of the daily RSS (which is empty on weekends).
  const url = 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&start=0&max_results=25&sortBy=submittedDate&sortOrder=descending';
  const r = await fetch(url, {
    headers: { 'User-Agent': env.USER_AGENT, 'Accept': 'application/atom+xml' },
  });
  if (!r.ok) return [];
  const xml = await r.text();
  const out: Item[] = [];
  const entries = xml.split('<entry>').slice(1, 26);
  for (const e of entries) {
    const closeIdx = e.indexOf('</entry>');
    if (closeIdx < 0) continue;
    const block = e.slice(0, closeIdx);
    const title = match(block, /<title>([\s\S]*?)<\/title>/)?.replace(/\s+/g, ' ').trim();
    const link = match(block, /<id>([^<]+)<\/id>/);
    const summaryRaw = match(block, /<summary>([\s\S]*?)<\/summary>/)?.replace(/\s+/g, ' ').trim();
    if (!title || !link) continue;
    out.push({ source: 'arxiv', title, url: link, summary: summaryRaw?.slice(0, 400), collected_at: new Date().toISOString() });
  }
  return out;
}

async function fetchReddit(env: Env, sub: string, source: Source): Promise<Item[]> {
  // Reddit JSON API blocks Cloudflare IPs. Use RSS feed which is more open.
  const r = await fetch(`https://www.reddit.com/r/${sub}/top/.rss?t=day&limit=25`, {
    headers: {
      'User-Agent': env.USER_AGENT,
      'Accept': 'application/rss+xml,application/atom+xml',
    },
  });
  if (!r.ok) return [];
  const xml = await r.text();
  const out: Item[] = [];
  // Reddit RSS uses Atom <entry> blocks
  const entries = xml.split('<entry>').slice(1, 26);
  for (const e of entries) {
    const closeIdx = e.indexOf('</entry>');
    if (closeIdx < 0) continue;
    const block = e.slice(0, closeIdx);
    const title = match(block, /<title>([\s\S]*?)<\/title>/)?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = match(block, /<link[^>]+href="([^"]+)"/);
    if (!title || !link) continue;
    out.push({ source, title, url: link, collected_at: new Date().toISOString() });
  }
  return out;
}

function match(s: string, re: RegExp): string | undefined {
  return s.match(re)?.[1];
}

async function collectAll(env: Env): Promise<Record<string, Item[]>> {
  const [hn, gh, ax, rml, rprog] = await Promise.allSettled([
    fetchHN(env),
    fetchGithubTrending(env),
    fetchArxiv(env),
    fetchReddit(env, 'MachineLearning', 'reddit-ml'),
    fetchReddit(env, 'programming', 'reddit-prog'),
  ]);

  return {
    hn: hn.status === 'fulfilled' ? hn.value : [],
    github: gh.status === 'fulfilled' ? gh.value : [],
    arxiv: ax.status === 'fulfilled' ? ax.value : [],
    'reddit-ml': rml.status === 'fulfilled' ? rml.value : [],
    'reddit-prog': rprog.status === 'fulfilled' ? rprog.value : [],
  };
}

// === Digest synthesis ===

const DIGEST_SYSTEM = `You are TrendPulse. Given a batch of titles from HN / GitHub trending / arxiv / Reddit, identify 3-7 cross-cutting themes that are gaining attention right now. A theme is something multiple sources agree on, OR something that's surprisingly absent given expectations.

Return JSON:
{
  "one_line": "<one sentence summary of what's hot today>",
  "themes": [
    {
      "name": "<short theme label>",
      "rationale": "<1-2 sentence why this is a theme>",
      "example_titles": ["<title 1>", "<title 2>", ...],
      "signal_strength": "rising|steady|spike"
    }
  ]
}

Prioritize: emerging tech, business model shifts, regulatory signals, market positioning changes. Skip celebrity / political / drama-driven items unless they have a structural product/market implication.

Return ONLY JSON.`;

export function tryParseJson(s: unknown): any | null {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  const str = typeof s === 'string' ? s : String(s);
  // Strip code fences and any text before/after JSON object boundaries.
  let cleaned = str.replace(/^```json\s*|\s*```$/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function synthesizeDigest(items: Record<string, Item[]>, env: Env, focus?: string): Promise<Digest> {
  const allTitles: string[] = [];
  for (const [src, list] of Object.entries(items)) {
    for (const it of list) {
      const meta = it.score != null ? ` [${it.score}]` : '';
      allTitles.push(`(${src}) ${it.title}${meta}`);
    }
  }
  const corpus = allTitles.slice(0, 200).join('\n');

  const system = focus
    ? `${DIGEST_SYSTEM}\n\nThe reader has a specific focus: ${focus}. Weight themes toward this focus and skip items irrelevant to it.`
    : DIGEST_SYSTEM;

  let aiResp: any;
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Titles from the last 24h:\n\n${corpus}\n\nRespond with the JSON object only, starting with { and ending with }.` },
      ],
      max_tokens: 2000,
    });
  } catch (err) {
    console.error('digest inference failed:', err);
    return {
      generated_at: new Date().toISOString(),
      date_label: new Date().toISOString().slice(0, 10),
      themes: [],
      one_line: 'inference failed; raw items below',
      source_counts: countSources(items),
    };
  }

  const raw = aiResp?.response ?? aiResp?.result ?? aiResp;
  console.log('digest raw:', typeof raw, JSON.stringify(raw).slice(0, 500));
  const parsed = tryParseJson(raw);
  return {
    generated_at: new Date().toISOString(),
    date_label: new Date().toISOString().slice(0, 10),
    themes: Array.isArray(parsed?.themes) ? parsed.themes : [],
    one_line: String(parsed?.one_line ?? ''),
    source_counts: countSources(items),
  };
}

function countSources(items: Record<string, Item[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(items)) out[k] = v.length;
  return out;
}

// === Premium: custom filtering ===

const ALL_SOURCES: Source[] = ['hn', 'github', 'arxiv', 'reddit-ml', 'reddit-prog'];

// Most recent raw collection (cron stores one every 4h). Used to build
// personalized digests without re-fetching every source.
async function getLatestRaw(env: Env): Promise<Record<string, Item[]> | null> {
  // KV lists keys lexicographically; ISO timestamps sort chronologically, so
  // the last key is the newest. Pull a small window and pick the max.
  const list = await env.TP_DATA.list({ prefix: RAW_KEY_PREFIX });
  if (!list.keys.length) return null;
  const newest = list.keys.map(k => k.name).sort().at(-1)!;
  const v = await env.TP_DATA.get(newest);
  if (!v) return null;
  try { return JSON.parse(v) as Record<string, Item[]>; } catch { return null; }
}

interface CustomFilters { keywords: string[]; sources: Source[] }

export function parseFilters(params: URLSearchParams): CustomFilters {
  const keywords = (params.get('keywords') ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 20);
  const reqSources = (params.get('sources') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean) as Source[];
  const sources = reqSources.filter(s => ALL_SOURCES.includes(s));
  return { keywords, sources: sources.length ? sources : ALL_SOURCES };
}

export function applyFilters(raw: Record<string, Item[]>, f: CustomFilters): Record<string, Item[]> {
  const out: Record<string, Item[]> = {};
  for (const [src, list] of Object.entries(raw)) {
    if (!f.sources.includes(src as Source)) continue;
    const filtered = f.keywords.length
      ? list.filter(it => {
          const hay = `${it.title} ${it.summary ?? ''}`.toLowerCase();
          return f.keywords.some(k => hay.includes(k));
        })
      : list;
    if (filtered.length) out[src] = filtered;
  }
  return out;
}

// Build (and day-cache) a personalized digest for a given filter set.
async function buildCustomDigest(env: Env, f: CustomFilters): Promise<Digest & { filters: CustomFilters; matched: number }> {
  const dateKey = new Date().toISOString().slice(0, 10);
  const sig = await sha256Hex(JSON.stringify({ k: f.keywords, s: f.sources }));
  const cacheKey = `${CUSTOM_PREFIX}${dateKey}:${sig}`;
  const cached = await env.TP_DIGEST.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  const raw = await getLatestRaw(env);
  if (!raw) {
    return { generated_at: new Date().toISOString(), date_label: dateKey, themes: [], one_line: 'no collection yet', source_counts: {}, filters: f, matched: 0 };
  }
  const filtered = applyFilters(raw, f);
  const matched = Object.values(filtered).reduce((n, l) => n + l.length, 0);

  const focus = f.keywords.length ? `topics matching: ${f.keywords.join(', ')}` : undefined;
  const digest = await synthesizeDigest(filtered, env, focus);
  const result = { ...digest, filters: f, matched };
  // Cache for the rest of the day so repeated calls don't re-run inference.
  await env.TP_DIGEST.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 });
  return result;
}

async function handleCustomDigest(req: Request, env: Env, url: URL): Promise<Response> {
  const lic = await validateLicense(env, licenseFromRequest(req, url));
  if (!lic.valid) return paywall(env, lic, 'pro');

  const filters = parseFilters(url.searchParams);
  const digest = await buildCustomDigest(env, filters);
  return Response.json({ tier: lic.tier, ...digest });
}

// === Premium: custom delivery ===
//
// Subscribers register a delivery target (webhook and/or email) tied to their
// license. Each cron digest is pushed to active registrations, respecting any
// saved per-subscriber filters. Webhook delivery is a Team feature; email is
// available to any active subscription (requires RESEND_API_KEY).

async function readBody(req: Request): Promise<any> {
  const ct = req.headers.get('Content-Type') ?? '';
  try {
    if (ct.includes('application/json')) return await req.json();
    if (ct.includes('form')) return Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {}
  return {};
}

export function validWebhookUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname;
  } catch { return false; }
}

async function handleDelivery(req: Request, env: Env, url: URL): Promise<Response> {
  const body = req.method === 'GET' ? undefined : await readBody(req);
  const licenseKey = (licenseFromRequest(req, url, body) ?? '').trim();
  const lic = await validateLicense(env, licenseKey);
  if (!lic.valid) return paywall(env, lic, 'pro');

  const hash = await sha256Hex(licenseKey);
  const kvKey = `${DELIVERY_PREFIX}${hash}`;

  if (req.method === 'GET') {
    const existing = await env.TP_DATA.get(kvKey);
    let registration: Omit<DeliveryRegistration, 'license_key'> | null = null;
    if (existing) {
      try { registration = publicDeliveryRegistration(JSON.parse(existing) as DeliveryRegistration, lic.tier); } catch {}
    }
    return Response.json({
      tier: lic.tier,
      email_delivery_available: !!env.RESEND_API_KEY,
      registration,
    });
  }

  if (req.method === 'DELETE') {
    await env.TP_DATA.delete(kvKey);
    return Response.json({ ok: true, removed: true });
  }

  // POST — register / update.
  const email = body?.email ? String(body.email).trim() : undefined;
  const webhook = body?.webhook ? String(body.webhook).trim() : undefined;
  if (!email && !webhook) {
    return Response.json({ error: 'provide an `email` and/or `webhook` target' }, { status: 400 });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: 'invalid email address' }, { status: 400 });
  }
  if (email && !env.RESEND_API_KEY) {
    return Response.json({ error: 'email delivery is not configured on this instance; use a webhook target instead' }, { status: 503 });
  }
  if (webhook) {
    if (!validWebhookUrl(webhook)) return Response.json({ error: 'invalid webhook URL' }, { status: 400 });
    if (!tierMeets(lic.tier, 'team')) return paywall(env, lic, 'team');
  }

  // Filters can be passed as arrays (JSON) or comma strings (form/query).
  const asList = (v: any): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [];
  const keywords = asList(body?.keywords).map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 20);
  const sources = asList(body?.sources).map(s => s.trim()).filter(s => ALL_SOURCES.includes(s as Source)) as Source[];

  const reg: DeliveryRegistration = {
    license_hash: hash,
    license_key: licenseKey,
    tier: lic.tier,
    email,
    webhook,
    webhook_secret: body?.webhook_secret ? String(body.webhook_secret) : undefined,
    filters: (keywords.length || sources.length) ? { keywords, sources } : undefined,
    created_at: new Date().toISOString(),
  };
  await env.TP_DATA.put(kvKey, JSON.stringify(reg));
  return Response.json({ ok: true, registered: { email: !!email, webhook: !!webhook, filters: reg.filters ?? null }, tier: lic.tier });
}

function publicDeliveryRegistration(reg: DeliveryRegistration, currentTier: Tier): Omit<DeliveryRegistration, 'license_key'> {
  const { license_key: _licenseKey, ...publicReg } = reg;
  return { ...publicReg, tier: currentTier };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function digestToHtml(d: Digest): string {
  const themes = (d.themes ?? []).map(t =>
    `<li><strong>${escapeHtmlServer(t.name)}</strong> <em>(${escapeHtmlServer(t.signal_strength ?? 'steady')})</em><br>${escapeHtmlServer(t.rationale ?? '')}</li>`
  ).join('');
  return `<h2>TrendPulse — ${escapeHtmlServer(d.date_label)}</h2>
<p><strong>${escapeHtmlServer(d.one_line ?? '')}</strong></p>
<ul>${themes}</ul>
<p style="color:#888;font-size:12px">Generated ${escapeHtmlServer(d.generated_at ?? '')}</p>`;
}

export function escapeHtmlServer(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function sendWebhook(env: Env, reg: DeliveryRegistration, digest: Digest): Promise<boolean> {
  if (!reg.webhook) return false;
  const payload = JSON.stringify({ event: 'digest', generated_at: digest.generated_at, digest });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': env.USER_AGENT,
    'X-TrendPulse-Event': 'digest',
  };
  if (reg.webhook_secret) headers['X-TrendPulse-Signature'] = await hmacHex(reg.webhook_secret, payload);
  try {
    const r = await fetch(reg.webhook, { method: 'POST', headers, body: payload });
    return r.ok;
  } catch (err) {
    console.error('webhook delivery failed:', err);
    return false;
  }
}

async function sendEmail(env: Env, to: string, digest: Digest): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL ?? 'TrendPulse <onboarding@resend.dev>',
        to,
        subject: `TrendPulse digest — ${digest.date_label}`,
        html: digestToHtml(digest),
      }),
    });
    return r.ok;
  } catch (err) {
    console.error('email delivery failed:', err);
    return false;
  }
}

// Push a freshly-generated digest to every active subscriber. Standard digest
// is reused unless a subscriber has saved filters, in which case a personalized
// digest is built (and day-cached) for them.
async function deliverDigest(env: Env, standard: Digest): Promise<void> {
  const list = await env.TP_DATA.list({ prefix: DELIVERY_PREFIX });
  let delivered = 0, skipped = 0;
  for (const k of list.keys) {
    const v = await env.TP_DATA.get(k.name);
    if (!v) continue;
    let reg: DeliveryRegistration;
    try { reg = JSON.parse(v) as DeliveryRegistration; } catch { continue; }
    if (!reg.license_key) { skipped++; continue; }

    const lic = await validateLicense(env, reg.license_key);
    if (!lic.valid) { skipped++; continue; }
    if (reg.tier !== lic.tier) {
      reg = { ...reg, tier: lic.tier };
      await env.TP_DATA.put(k.name, JSON.stringify(reg));
    }

    let digest = standard;
    if (reg.filters && (reg.filters.keywords?.length || reg.filters.sources?.length)) {
      const f: CustomFilters = {
        keywords: reg.filters.keywords ?? [],
        sources: (reg.filters.sources?.length ? reg.filters.sources : ALL_SOURCES),
      };
      try { digest = await buildCustomDigest(env, f); } catch { digest = standard; }
    }

    const tasks: Promise<boolean>[] = [];
    if (reg.webhook && tierMeets(lic.tier, 'team')) tasks.push(sendWebhook(env, reg, digest));
    if (reg.email) tasks.push(sendEmail(env, reg.email, digest));
    if (!tasks.length) { skipped++; continue; }
    const results = await Promise.allSettled(tasks);
    if (results.some(r => r.status === 'fulfilled' && r.value)) delivered++; else skipped++;
  }
  console.log(`trendpulse: delivery — ${delivered} sent, ${skipped} skipped`);
}

async function handleLicenseCheck(req: Request, env: Env, url: URL): Promise<Response> {
  const body = await readBody(req);
  const lic = await validateLicense(env, licenseFromRequest(req, url, body));
  return Response.json({
    valid: lic.valid,
    tier: lic.tier,
    status: lic.status,
    expires_at: lic.expires_at ?? null,
    error: lic.error ?? null,
  }, { status: lic.valid ? 200 : 402 });
}

function handleConfig(env: Env): Response {
  return Response.json({
    checkout_url: env.CHECKOUT_URL ?? null,
    premium_enabled: !!env.CHECKOUT_URL,
    email_delivery: !!env.RESEND_API_KEY,
    features: {
      pro: ['custom filters', 'email delivery', 'historical search'],
      team: ['everything in pro', 'webhook delivery', 'custom sources'],
    },
  });
}

async function runCron(env: Env) {
  const items = await collectAll(env);
  const stamp = new Date().toISOString();
  await env.TP_DATA.put(`${RAW_KEY_PREFIX}${stamp}`, JSON.stringify(items), { expirationTtl: 60 * 60 * 24 * 14 });

  const digest = await synthesizeDigest(items, env);
  const dateKey = digest.date_label;
  await env.TP_DIGEST.put(`${DIGEST_KEY_PREFIX}${dateKey}`, JSON.stringify(digest));
  await env.TP_DIGEST.put(LATEST_KEY, JSON.stringify(digest));
  console.log(`trendpulse: digest generated for ${dateKey}, ${digest.themes.length} themes`);

  // Push to paid subscribers' delivery targets (webhook / email).
  await deliverDigest(env, digest);
}

function parseStoredDigest(v: string | null): Digest | null {
  if (!v) return null;
  try {
    const parsed = JSON.parse(v) as Partial<Digest>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      generated_at: String(parsed.generated_at ?? ''),
      date_label: String(parsed.date_label ?? ''),
      themes: Array.isArray(parsed.themes) ? parsed.themes as Digest['themes'] : [],
      one_line: String(parsed.one_line ?? ''),
      source_counts: numericRecord(parsed.source_counts),
    };
  } catch {
    return null;
  }
}

function numericRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function secondsSinceIso(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 1000));
}

function manualRunLastAt(raw: string | null): string | null {
  if (!raw) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function manualRunCooldownSeconds(raw: string | null, now: Date): number {
  if (!raw) return 0;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil((MANUAL_RUN_COOLDOWN_MS - (now.getTime() - ms)) / 1000));
}

async function buildStatus(env: Env, now = new Date()): Promise<StatusSnapshot> {
  const [rawList, digestList, deliveryList, customList, latestDigestValue, lastManualRun] = await Promise.all([
    env.TP_DATA.list({ prefix: RAW_KEY_PREFIX, limit: KV_COUNT_LIMIT }),
    env.TP_DIGEST.list({ prefix: DIGEST_KEY_PREFIX, limit: KV_COUNT_LIMIT }),
    env.TP_DATA.list({ prefix: DELIVERY_PREFIX, limit: KV_COUNT_LIMIT }),
    env.TP_DIGEST.list({ prefix: CUSTOM_PREFIX, limit: KV_COUNT_LIMIT }),
    env.TP_DIGEST.get(LATEST_KEY),
    env.TP_DATA.get(MANUAL_RUN_KEY),
  ]);

  const rawTimestamps = rawList.keys
    .map(k => k.name.replace(RAW_KEY_PREFIX, ''))
    .sort();
  const latestCollectionAt = rawTimestamps.at(-1) ?? null;
  const latestDigest = parseStoredDigest(latestDigestValue);
  const latestDigestAgeSeconds = secondsSinceIso(latestDigest?.generated_at ?? null, now);
  const archiveDigestKeys = digestList.keys.filter(k => /^digest:\d{4}-\d{2}-\d{2}$/.test(k.name));
  const status: ServiceStatus = !latestDigest
    ? 'initializing'
    : latestDigestAgeSeconds == null || latestDigestAgeSeconds > STATUS_STALE_AFTER_MS / 1000
      ? 'stale'
      : 'healthy';

  return {
    name: 'TrendPulse',
    status,
    generated_at: now.toISOString(),
    collection: {
      raw_collection_count: rawList.keys.length,
      raw_collection_count_truncated: rawList.list_complete === false,
      last_collection_at: latestCollectionAt,
      last_collection_age_seconds: secondsSinceIso(latestCollectionAt, now),
      recent_collections: rawTimestamps.slice(-5).reverse(),
    },
    digest: {
      has_latest: latestDigest != null,
      latest_date: latestDigest?.date_label || null,
      latest_generated_at: latestDigest?.generated_at || null,
      latest_age_seconds: latestDigestAgeSeconds,
      theme_count: latestDigest?.themes.length ?? 0,
      source_counts: latestDigest?.source_counts ?? {},
      history_count: archiveDigestKeys.length,
      history_count_truncated: digestList.list_complete === false,
    },
    usage: {
      delivery_registrations: deliveryList.keys.length,
      delivery_registrations_truncated: deliveryList.list_complete === false,
      custom_digest_caches: customList.keys.length,
      custom_digest_caches_truncated: customList.list_complete === false,
    },
    operations: {
      manual_run_last_at: manualRunLastAt(lastManualRun),
      manual_run_cooldown_seconds: manualRunCooldownSeconds(lastManualRun, now),
    },
    config: {
      premium_enabled: !!env.CHECKOUT_URL,
      email_delivery_enabled: !!env.RESEND_API_KEY,
    },
  };
}

function countLabel(count: number, truncated: boolean): string {
  return `${count}${truncated ? '+' : ''}`;
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return 'n/a';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function metricHtml(label: string, value: string, detail: string): string {
  return `<div class="metric"><span>${escapeHtmlServer(label)}</span><strong>${escapeHtmlServer(value)}</strong><small>${escapeHtmlServer(detail)}</small></div>`;
}

function renderDashboard(status: StatusSnapshot): string {
  const sourceRows = Object.entries(status.digest.source_counts).length
    ? Object.entries(status.digest.source_counts).map(([source, count]) =>
        `<tr><td>${escapeHtmlServer(source)}</td><td>${escapeHtmlServer(String(count))}</td></tr>`
      ).join('')
    : '<tr><td colspan="2">No latest digest yet</td></tr>';
  const recentCollectionRows = status.collection.recent_collections.length
    ? status.collection.recent_collections.map(ts => `<li>${escapeHtmlServer(ts)}</li>`).join('')
    : '<li>No collections yet</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TrendPulse Status Dashboard</title>
<style>
:root { --bg:#0b0c10; --fg:#eef0f3; --muted:#8a96a8; --accent:#22c55e; --warn:#f59e0b; --bad:#ef4444; --card:#13161e; --border:#1f2733; }
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,system-ui,sans-serif;line-height:1.5;padding:28px 16px;max-width:1080px;margin:0 auto;font-size:15px}
header{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:20px}
h1{font-size:34px;letter-spacing:0;line-height:1.1}
h2{font-size:17px;margin-bottom:10px;letter-spacing:0}
.eyebrow{color:var(--accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0;margin-bottom:5px}
.actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.actions a{border:1px solid var(--border);border-radius:6px;padding:8px 10px;background:var(--card);font-size:13px}
.statusline{display:flex;justify-content:space-between;gap:16px;align-items:center;margin:18px 0;color:var(--muted)}
.pill{display:inline-flex;align-items:center;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:700;text-transform:uppercase}
.pill.healthy{background:var(--accent);color:#06120a}
.pill.initializing{background:var(--warn);color:#180d02}
.pill.stale{background:var(--bad);color:#fff}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0 24px}
.metric,.panel{background:var(--card);border:1px solid var(--border);border-radius:8px}
.metric{padding:14px;min-height:104px;display:flex;flex-direction:column;justify-content:space-between}
.metric span,.metric small,.muted{color:var(--muted)}
.metric strong{font-size:28px;line-height:1.1;margin:8px 0;letter-spacing:0}
.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0}
.panel{padding:16px}
dl{display:grid;grid-template-columns:minmax(140px,42%) 1fr;gap:8px 12px}
dt{color:var(--muted)}
dd{word-break:break-word}
table{width:100%;border-collapse:collapse}
td{border-top:1px solid var(--border);padding:8px 0}
td:last-child{text-align:right;font-variant-numeric:tabular-nums}
ul{list-style:none}
li{border-top:1px solid var(--border);padding:8px 0;color:var(--muted);font-family:ui-monospace,monospace;font-size:13px}
footer{color:var(--muted);font-size:13px;border-top:1px solid var(--border);padding-top:14px;margin-top:24px}
@media(max-width:820px){.grid,.columns{grid-template-columns:1fr 1fr}header{flex-direction:column}.actions{justify-content:flex-start}}
@media(max-width:560px){.grid,.columns,dl{grid-template-columns:1fr}.statusline{align-items:flex-start;flex-direction:column}.metric strong{font-size:24px}}
</style>
</head>
<body>
<header>
  <div>
    <p class="eyebrow">TrendPulse</p>
    <h1>Status Dashboard</h1>
  </div>
  <nav class="actions">
    <a href="/">Digest</a>
    <a href="/api/status">JSON</a>
  </nav>
</header>

<div class="statusline">
  <span class="pill ${status.status}">${escapeHtmlServer(status.status)}</span>
  <span>Snapshot ${escapeHtmlServer(status.generated_at)}</span>
</div>

<section class="grid">
  ${metricHtml('Latest digest', status.digest.has_latest ? status.digest.latest_date ?? 'available' : 'missing', formatAge(status.digest.latest_age_seconds))}
  ${metricHtml('Digest history', countLabel(status.digest.history_count, status.digest.history_count_truncated), 'archived daily digests')}
  ${metricHtml('Raw collections', countLabel(status.collection.raw_collection_count, status.collection.raw_collection_count_truncated), formatAge(status.collection.last_collection_age_seconds))}
  ${metricHtml('Delivery registrations', countLabel(status.usage.delivery_registrations, status.usage.delivery_registrations_truncated), 'paid delivery targets')}
</section>

<section class="columns">
  <div class="panel">
    <h2>Latest Digest</h2>
    <dl>
      <dt>Generated</dt><dd>${escapeHtmlServer(status.digest.latest_generated_at ?? 'none')}</dd>
      <dt>Themes</dt><dd>${escapeHtmlServer(String(status.digest.theme_count))}</dd>
      <dt>Source items</dt><dd>${escapeHtmlServer(String(Object.values(status.digest.source_counts).reduce((sum, n) => sum + n, 0)))}</dd>
    </dl>
  </div>
  <div class="panel">
    <h2>Source Counts</h2>
    <table><tbody>${sourceRows}</tbody></table>
  </div>
</section>

<section class="columns">
  <div class="panel">
    <h2>Usage</h2>
    <dl>
      <dt>Custom digest caches</dt><dd>${escapeHtmlServer(countLabel(status.usage.custom_digest_caches, status.usage.custom_digest_caches_truncated))}</dd>
      <dt>Premium enabled</dt><dd>${status.config.premium_enabled ? 'yes' : 'no'}</dd>
      <dt>Email delivery</dt><dd>${status.config.email_delivery_enabled ? 'configured' : 'not configured'}</dd>
    </dl>
  </div>
  <div class="panel">
    <h2>Operations</h2>
    <dl>
      <dt>Last manual run</dt><dd>${escapeHtmlServer(status.operations.manual_run_last_at ?? 'none')}</dd>
      <dt>Manual cooldown</dt><dd>${escapeHtmlServer(String(status.operations.manual_run_cooldown_seconds))}s</dd>
      <dt>Last collection</dt><dd>${escapeHtmlServer(status.collection.last_collection_at ?? 'none')}</dd>
    </dl>
  </div>
</section>

<section class="panel">
  <h2>Recent Collections</h2>
  <ul>${recentCollectionRows}</ul>
</section>

<footer>
  <p>Operational and usage counts are derived from TrendPulse KV state. Count values ending in + reached the dashboard scan limit.</p>
</footer>
</body>
</html>`;
}

// === HTTP ===

async function handleLatest(_req: Request, env: Env): Promise<Response> {
  const v = await env.TP_DIGEST.get(LATEST_KEY);
  if (!v) {
    return Response.json({
      message: 'no digest yet — first cron run produces it within hours',
      hint: 'POST /api/run-now to trigger collection in the meantime (rate-limited)',
    }, { status: 202 });
  }
  return new Response(v, { headers: { 'Content-Type': 'application/json' } });
}

async function handleHistory(_req: Request, env: Env): Promise<Response> {
  const list = await env.TP_DIGEST.list({ prefix: DIGEST_KEY_PREFIX, limit: 30 });
  const out: Digest[] = [];
  for (const k of list.keys) {
    if (k.name === LATEST_KEY) continue;
    const v = await env.TP_DIGEST.get(k.name);
    if (v) try { out.push(JSON.parse(v) as Digest); } catch {}
  }
  return Response.json({
    count: out.length,
    digests: out.sort((a, b) => b.date_label.localeCompare(a.date_label)),
  });
}

async function handleRunNow(_req: Request, env: Env): Promise<Response> {
  // Manual trigger — useful for first-run.
  // Cheap rate-limit: only allow if we haven't run in last 30 min.
  const last = await env.TP_DATA.get(MANUAL_RUN_KEY);
  if (last && Date.now() - Number(last) < MANUAL_RUN_COOLDOWN_MS) {
    return Response.json({ error: 'manual rate limit; try later' }, { status: 429 });
  }
  await env.TP_DATA.put(MANUAL_RUN_KEY, String(Date.now()), { expirationTtl: 60 * 60 });
  await runCron(env);
  return handleLatest(_req, env);
}

async function handleStatus(_req: Request, env: Env): Promise<Response> {
  return Response.json(await buildStatus(env), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function handleDashboard(_req: Request, env: Env): Promise<Response> {
  return new Response(renderDashboard(await buildStatus(env)), {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/digest/latest') return handleLatest(req, env);
    if (url.pathname === '/api/digest/history') return handleHistory(req, env);
    if (url.pathname === '/api/run-now' && req.method === 'POST') return handleRunNow(req, env);
    if (url.pathname === '/api/status') return handleStatus(req, env);
    if (url.pathname === '/api/config') return handleConfig(env);
    if (url.pathname === '/dashboard' || url.pathname === '/dashboard.html') return handleDashboard(req, env);
    // --- Premium (Lemon Squeezy subscription required) ---
    if (url.pathname === '/api/license/check') return handleLicenseCheck(req, env, url);
    if (url.pathname === '/api/digest/custom') return handleCustomDigest(req, env, url);
    if (url.pathname === '/api/delivery') return handleDelivery(req, env, url);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
