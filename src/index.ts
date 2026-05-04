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

interface Env {
  AI: any;
  ASSETS: Fetcher;
  TP_DATA: KVNamespace;
  TP_DIGEST: KVNamespace;
  USER_AGENT: string;
}

type Source = 'hn' | 'github' | 'arxiv' | 'reddit-ml' | 'reddit-prog';

interface Item {
  source: Source;
  title: string;
  url: string;
  score?: number;
  comments?: number;
  collected_at: string;
  summary?: string;
}

interface Digest {
  generated_at: string;
  date_label: string;       // YYYY-MM-DD
  themes: { name: string; rationale: string; example_titles: string[]; signal_strength: 'rising' | 'steady' | 'spike' }[];
  one_line: string;
  source_counts: Record<string, number>;
}

const RAW_KEY_PREFIX = 'raw:';
const DIGEST_KEY_PREFIX = 'digest:';
const LATEST_KEY = 'digest:latest';

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

function tryParseJson(s: unknown): any | null {
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

async function synthesizeDigest(items: Record<string, Item[]>, env: Env): Promise<Digest> {
  const allTitles: string[] = [];
  for (const [src, list] of Object.entries(items)) {
    for (const it of list) {
      const meta = it.score != null ? ` [${it.score}]` : '';
      allTitles.push(`(${src}) ${it.title}${meta}`);
    }
  }
  const corpus = allTitles.slice(0, 200).join('\n');

  let aiResp: any;
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: DIGEST_SYSTEM },
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

async function runCron(env: Env) {
  const items = await collectAll(env);
  const stamp = new Date().toISOString();
  await env.TP_DATA.put(`${RAW_KEY_PREFIX}${stamp}`, JSON.stringify(items), { expirationTtl: 60 * 60 * 24 * 14 });

  const digest = await synthesizeDigest(items, env);
  const dateKey = digest.date_label;
  await env.TP_DIGEST.put(`${DIGEST_KEY_PREFIX}${dateKey}`, JSON.stringify(digest));
  await env.TP_DIGEST.put(LATEST_KEY, JSON.stringify(digest));
  console.log(`trendpulse: digest generated for ${dateKey}, ${digest.themes.length} themes`);
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
  const key = 'last_manual_run';
  const last = await env.TP_DATA.get(key);
  if (last && Date.now() - Number(last) < 30 * 60 * 1000) {
    return Response.json({ error: 'manual rate limit; try later' }, { status: 429 });
  }
  await env.TP_DATA.put(key, String(Date.now()), { expirationTtl: 60 * 60 });
  await runCron(env);
  return handleLatest(_req, env);
}

async function handleStatus(_req: Request, env: Env): Promise<Response> {
  const list = await env.TP_DATA.list({ prefix: RAW_KEY_PREFIX, limit: 5 });
  const recent = list.keys.map(k => k.name.replace(RAW_KEY_PREFIX, ''));
  return Response.json({
    name: 'TrendPulse',
    last_collections: recent,
    has_latest_digest: (await env.TP_DIGEST.get(LATEST_KEY)) != null,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/digest/latest') return handleLatest(req, env);
    if (url.pathname === '/api/digest/history') return handleHistory(req, env);
    if (url.pathname === '/api/run-now' && req.method === 'POST') return handleRunNow(req, env);
    if (url.pathname === '/api/status') return handleStatus(req, env);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
