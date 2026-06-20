import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import worker, {
  applyFilters,
  digestToHtml,
  parseFilters,
  tierMeets,
  tryParseJson,
  validWebhookUrl,
} from '../src/index.ts';

const originalFetch = globalThis.fetch;

class MemoryKV {
  store = new Map();

  async get(key) {
    return this.store.get(key) ?? null;
  }

  async put(key, value, _options) {
    this.store.set(key, String(value));
  }

  async delete(key) {
    this.store.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const keys = [...this.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((name) => ({ name }));

    return { keys, list_complete: true, cursor: undefined };
  }

  value(key) {
    return this.store.get(key);
  }
}

function spy(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
}

function makeEnv(overrides = {}) {
  const env = {
    AI: { run: spy(async () => ({ response: '{"one_line":"default","themes":[]}' })) },
    ASSETS: { fetch: spy(async () => new Response('asset fallback', { status: 200 })) },
    TP_DATA: new MemoryKV(),
    TP_DIGEST: new MemoryKV(),
    USER_AGENT: 'TrendPulse tests',
    CHECKOUT_URL: 'https://checkout.example/trendpulse',
  };

  return Object.assign(env, overrides);
}

function setFetch(fn) {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fn,
  });
}

function request(path, init) {
  return new Request(`https://trendpulse.test${path}`, init);
}

async function fetchWorker(env, path, init) {
  return worker.fetch(request(path, init), env);
}

async function readJson(resp) {
  return resp.json();
}

function item(source, title, extra = {}) {
  return {
    source,
    title,
    url: `https://example.test/${source}/${encodeURIComponent(title)}`,
    collected_at: '2026-06-19T00:00:00.000Z',
    ...extra,
  };
}

function digest(dateLabel, oneLine = `Digest for ${dateLabel}`) {
  return {
    generated_at: `${dateLabel}T13:00:00.000Z`,
    date_label: dateLabel,
    one_line: oneLine,
    themes: [],
    source_counts: { hn: 1 },
  };
}

function stubLicenseFetch(options = {}) {
  const fetchMock = spy(async (input) => {
    const url = String(input);
    if (url !== 'https://api.lemonsqueezy.com/v1/licenses/validate') {
      throw new Error(`unexpected fetch: ${url}`);
    }

    return Response.json({
      valid: options.valid ?? true,
      license_key: {
        status: options.status ?? 'active',
        expires_at: null,
      },
      meta: {
        variant_name: options.variantName ?? 'Pro',
        customer_email: options.email ?? 'buyer@example.test',
      },
      error: options.error,
    });
  });

  setFetch(fetchMock);
  return fetchMock;
}

function collectionResponse(url) {
  if (url === 'https://hacker-news.firebaseio.com/v0/topstories.json') {
    return Response.json([101, 102]);
  }
  if (url === 'https://hacker-news.firebaseio.com/v0/item/101.json') {
    return Response.json({
      title: 'Agent platforms reach production',
      url: 'https://news.example.test/agents',
      score: 120,
      descendants: 34,
    });
  }
  if (url === 'https://hacker-news.firebaseio.com/v0/item/102.json') {
    return Response.json({ deleted: true });
  }
  if (url.startsWith('https://api.github.com/search/repositories')) {
    return Response.json({
      items: [{
        full_name: 'org/agent-runtime',
        description: 'Open source runtime for AI agents',
        html_url: 'https://github.com/org/agent-runtime',
        stargazers_count: 420,
      }],
    });
  }
  if (url.startsWith('https://export.arxiv.org/api/query')) {
    return new Response(`
      <feed>
        <entry>
          <title>Efficient agent planning for tool use</title>
          <id>https://arxiv.org/abs/2606.00001</id>
          <summary>Methods for production agent planning.</summary>
        </entry>
      </feed>
    `);
  }
  if (url.startsWith('https://www.reddit.com/r/MachineLearning')) {
    return new Response(`
      <feed>
        <entry>
          <title><![CDATA[Agent benchmarks discussion]]></title>
          <link href="https://reddit.example.test/r/MachineLearning/agent-benchmarks"/>
        </entry>
      </feed>
    `);
  }
  if (url.startsWith('https://www.reddit.com/r/programming')) {
    return new Response(`
      <feed>
        <entry>
          <title>Tool calling frameworks in production</title>
          <link href="https://reddit.example.test/r/programming/tool-calling"/>
        </entry>
      </feed>
    `);
  }
  return null;
}

function stubCollectionFetch() {
  const fetchMock = spy(async (input) => {
    const url = String(input);
    const response = collectionResponse(url);
    if (response) return response;
    throw new Error(`unexpected fetch: ${url}`);
  });

  setFetch(fetchMock);
  return fetchMock;
}

afterEach(() => {
  setFetch(originalFetch);
});

describe('helpers', () => {
  it('parses JSON from loose AI responses', () => {
    assert.equal(tryParseJson(null), null);
    assert.equal(tryParseJson('not json'), null);
    assert.deepEqual(tryParseJson('```json\n{"ok":true}\n```'), { ok: true });
    assert.deepEqual(tryParseJson('prefix {"one_line":"agents","themes":[]} suffix'), {
      one_line: 'agents',
      themes: [],
    });
  });

  it('normalizes filters and applies source and keyword constraints', () => {
    const filters = parseFilters(new URLSearchParams('keywords= AI ,Agents,,&sources=hn,bad,github'));
    assert.deepEqual(filters, { keywords: ['ai', 'agents'], sources: ['hn', 'github'] });

    const defaulted = parseFilters(new URLSearchParams('sources=unknown'));
    assert.deepEqual(defaulted.sources, ['hn', 'github', 'arxiv', 'reddit-ml', 'reddit-prog']);

    const raw = {
      hn: [
        item('hn', 'AI agents move into operations'),
        item('hn', 'Database release notes'),
      ],
      github: [item('github', 'Scheduler library', { summary: 'Agents orchestration primitives' })],
      arxiv: [item('arxiv', 'Compiler optimization survey')],
    };

    assert.deepEqual(applyFilters(raw, filters), {
      hn: [raw.hn[0]],
      github: [raw.github[0]],
    });
  });

  it('checks tier ordering, webhook URLs, and HTML escaping', () => {
    assert.equal(tierMeets('team', 'pro'), true);
    assert.equal(tierMeets('pro', 'team'), false);
    assert.equal(validWebhookUrl('https://hooks.example.test/trendpulse'), true);
    assert.equal(validWebhookUrl('ftp://hooks.example.test/trendpulse'), false);
    assert.equal(validWebhookUrl('not a url'), false);

    const html = digestToHtml({
      generated_at: '2026-06-19T13:00:00.000Z',
      date_label: '2026-06-19',
      one_line: '<script>alert(1)</script>',
      themes: [{
        name: 'Agents & Tools',
        rationale: 'Usage > demos',
        example_titles: [],
        signal_strength: 'rising',
      }],
      source_counts: {},
    });

    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Agents &amp; Tools/);
  });
});

describe('public Worker API', () => {
  it('reports empty state and serves config, status, and asset fallback', async () => {
    const env = makeEnv();

    const latest = await fetchWorker(env, '/api/digest/latest');
    assert.equal(latest.status, 202);
    assert.match((await readJson(latest)).message, /no digest yet/);

    const config = await fetchWorker(env, '/api/config');
    assert.deepEqual(await readJson(config), {
      checkout_url: 'https://checkout.example/trendpulse',
      premium_enabled: true,
      email_delivery: false,
      features: {
        pro: ['custom filters', 'email delivery', 'historical search'],
        team: ['everything in pro', 'webhook delivery', 'custom sources'],
      },
    });

    const status = await fetchWorker(env, '/api/status');
    const statusBody = await readJson(status);
    assert.equal(statusBody.name, 'TrendPulse');
    assert.equal(statusBody.status, 'initializing');
    assert.equal(statusBody.digest.has_latest, false);
    assert.equal(statusBody.digest.history_count, 0);
    assert.deepEqual(statusBody.collection.recent_collections, []);
    assert.equal(statusBody.usage.delivery_registrations, 0);
    assert.equal(statusBody.usage.custom_digest_caches, 0);
    assert.equal(statusBody.config.premium_enabled, true);
    assert.equal(statusBody.config.email_delivery_enabled, false);

    const dashboard = await fetchWorker(env, '/dashboard');
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get('Content-Type'), /text\/html/);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /Status Dashboard/);
    assert.match(dashboardHtml, /Delivery registrations/);

    const fallback = await fetchWorker(env, '/not-an-api-route');
    assert.equal(await fallback.text(), 'asset fallback');
    assert.equal(env.ASSETS.fetch.calls.length, 1);
  });

  it('returns the latest digest and sorted history', async () => {
    const env = makeEnv();
    const manualRunStartedAt = Date.now();
    await env.TP_DATA.put('raw:2026-06-19T08:00:00.000Z', JSON.stringify({ hn: [] }));
    await env.TP_DATA.put('raw:2026-06-19T12:00:00.000Z', JSON.stringify({ hn: [item('hn', 'Latest collection item')] }));
    await env.TP_DATA.put('delivery:abc123', JSON.stringify({ email: 'ops@example.test' }));
    await env.TP_DATA.put('last_manual_run', String(manualRunStartedAt));
    const latestDigest = digest('2026-06-19', 'Newest digest');
    latestDigest.generated_at = new Date().toISOString();
    await env.TP_DIGEST.put('digest:2026-06-17', JSON.stringify(digest('2026-06-17')));
    await env.TP_DIGEST.put('digest:2026-06-19', JSON.stringify(digest('2026-06-19')));
    await env.TP_DIGEST.put('digest:latest', JSON.stringify(latestDigest));
    await env.TP_DIGEST.put('digest:bad', 'not json');
    await env.TP_DIGEST.put('custom:2026-06-19:abc123', JSON.stringify(digest('2026-06-19', 'Custom digest')));

    const latest = await fetchWorker(env, '/api/digest/latest');
    assert.equal(latest.status, 200);
    assert.equal((await readJson(latest)).one_line, 'Newest digest');

    const history = await fetchWorker(env, '/api/digest/history');
    const body = await readJson(history);
    assert.equal(body.count, 2);
    assert.deepEqual(body.digests.map((d) => d.date_label), ['2026-06-19', '2026-06-17']);

    const status = await fetchWorker(env, '/api/status');
    const statusBody = await readJson(status);
    assert.equal(statusBody.status, 'healthy');
    assert.equal(statusBody.digest.has_latest, true);
    assert.equal(statusBody.digest.latest_date, '2026-06-19');
    assert.equal(statusBody.digest.latest_generated_at, latestDigest.generated_at);
    assert.equal(statusBody.digest.theme_count, 0);
    assert.deepEqual(statusBody.digest.source_counts, { hn: 1 });
    assert.equal(statusBody.digest.history_count, 2);
    assert.equal(statusBody.collection.raw_collection_count, 2);
    assert.equal(statusBody.collection.last_collection_at, '2026-06-19T12:00:00.000Z');
    assert.deepEqual(statusBody.collection.recent_collections, [
      '2026-06-19T12:00:00.000Z',
      '2026-06-19T08:00:00.000Z',
    ]);
    assert.equal(statusBody.usage.delivery_registrations, 1);
    assert.equal(statusBody.usage.custom_digest_caches, 1);
    assert.equal(statusBody.operations.manual_run_last_at, new Date(manualRunStartedAt).toISOString());
    assert.equal(statusBody.operations.manual_run_cooldown_seconds > 0, true);
  });
});

describe('license and premium routes', () => {
  it('validates and caches Lemon Squeezy license checks', async () => {
    const env = makeEnv();
    const fetchMock = stubLicenseFetch({ variantName: 'Team' });

    const first = await fetchWorker(env, '/api/license/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: 'team-key' }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await readJson(first), {
      valid: true,
      tier: 'team',
      status: 'active',
      expires_at: null,
      error: null,
    });

    const second = await fetchWorker(env, '/api/license/check?key=team-key', { method: 'POST' });
    assert.equal(second.status, 200);
    assert.equal(fetchMock.calls.length, 1);
  });

  it('returns payment-required responses when no active license is supplied', async () => {
    const env = makeEnv();

    const license = await fetchWorker(env, '/api/license/check', { method: 'POST' });
    assert.equal(license.status, 402);
    assert.deepEqual(await readJson(license), {
      valid: false,
      tier: 'free',
      status: 'missing',
      expires_at: null,
      error: 'no license key provided',
    });

    const custom = await fetchWorker(env, '/api/digest/custom?keywords=agents');
    assert.equal(custom.status, 402);
    const body = await readJson(custom);
    assert.match(body.error, /premium feature/);
    assert.equal(body.upgrade, 'https://checkout.example/trendpulse');
  });

  it('builds and caches custom digests from the latest raw collection', async () => {
    const env = makeEnv({
      AI: {
        run: spy(async () => ({
          response: 'model says {"one_line":"Agent infrastructure is rising","themes":[{"name":"Agent infra","rationale":"Multiple sources mention agents","example_titles":["Agent platforms reach production"],"signal_strength":"rising"}]} done',
        })),
      },
    });
    stubLicenseFetch({ variantName: 'Pro' });

    await env.TP_DATA.put('raw:2026-06-18T10:00:00.000Z', JSON.stringify({
      hn: [item('hn', 'Older item')],
    }));
    await env.TP_DATA.put('raw:2026-06-19T10:00:00.000Z', JSON.stringify({
      hn: [item('hn', 'Agent platforms reach production', { score: 12 })],
      github: [item('github', 'Scheduler library', { summary: 'Agent orchestration primitives' })],
      arxiv: [item('arxiv', 'Compiler optimization survey')],
    }));

    const first = await fetchWorker(env, '/api/digest/custom?key=pro-key&keywords=agent&sources=hn,github,bad');
    assert.equal(first.status, 200);
    const body = await readJson(first);
    assert.equal(body.tier, 'pro');
    assert.equal(body.one_line, 'Agent infrastructure is rising');
    assert.equal(body.matched, 2);
    assert.deepEqual(body.filters, { keywords: ['agent'], sources: ['hn', 'github'] });
    assert.deepEqual(body.source_counts, { hn: 1, github: 1 });

    assert.equal(env.AI.run.calls.length, 1);
    const aiPayload = env.AI.run.calls[0][1];
    assert.match(aiPayload.messages[0].content, /topics matching: agent/);
    assert.match(aiPayload.messages[1].content, /\(hn\) Agent platforms reach production \[12\]/);

    const cached = await fetchWorker(env, '/api/digest/custom?key=pro-key&keywords=agent&sources=hn,github,bad');
    assert.equal(cached.status, 200);
    const cachedBody = await readJson(cached);
    assert.equal(cachedBody.one_line, 'Agent infrastructure is rising');
    assert.equal(cachedBody.matched, 2);
    assert.equal(env.AI.run.calls.length, 1);
  });

  it('enforces delivery input and tier constraints', async () => {
    const env = makeEnv();
    stubLicenseFetch({ variantName: 'Pro' });

    const noTarget = await fetchWorker(env, '/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: 'pro-key' }),
    });
    assert.equal(noTarget.status, 400);
    assert.deepEqual(await readJson(noTarget), { error: 'provide an `email` and/or `webhook` target' });

    const badEmail = await fetchWorker(env, '/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: 'pro-key', email: 'not-email' }),
    });
    assert.equal(badEmail.status, 400);
    assert.deepEqual(await readJson(badEmail), { error: 'invalid email address' });

    const teamOnly = await fetchWorker(env, '/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: 'pro-key', webhook: 'https://hooks.example.test/trendpulse' }),
    });
    assert.equal(teamOnly.status, 402);
    const teamOnlyBody = await readJson(teamOnly);
    assert.equal(teamOnlyBody.detail, 'requires team tier');
    assert.equal(teamOnlyBody.your_tier, 'pro');
  });

  it('stores, reads, and removes team delivery registrations', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'resend-secret' });
    stubLicenseFetch({ variantName: 'Team' });

    const saved = await fetchWorker(env, '/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: 'team-key',
        email: 'ops@example.test',
        webhook: 'https://hooks.example.test/trendpulse',
        webhook_secret: 'signing-secret',
        keywords: ['Agents', 'Cloud'],
        sources: ['hn', 'bogus', 'github'],
      }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await readJson(saved), {
      ok: true,
      registered: {
        email: true,
        webhook: true,
        filters: { keywords: ['agents', 'cloud'], sources: ['hn', 'github'] },
      },
      tier: 'team',
    });

    const read = await fetchWorker(env, '/api/delivery', {
      headers: { Authorization: 'Bearer team-key' },
    });
    assert.equal(read.status, 200);
    const body = await readJson(read);
    assert.equal(body.tier, 'team');
    assert.equal(body.email_delivery_available, true);
    assert.equal(body.registration.tier, 'team');
    assert.equal(body.registration.email, 'ops@example.test');
    assert.equal(body.registration.webhook, 'https://hooks.example.test/trendpulse');
    assert.equal(body.registration.webhook_secret, 'signing-secret');
    assert.match(body.registration.license_hash, /^[a-f0-9]{64}$/);

    const removed = await fetchWorker(env, '/api/delivery', {
      method: 'DELETE',
      headers: { 'X-License-Key': 'team-key' },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await readJson(removed), { ok: true, removed: true });

    const after = await fetchWorker(env, '/api/delivery?key=team-key');
    assert.equal(after.status, 200);
    assert.equal((await readJson(after)).registration, null);
  });

  it('revalidates delivery registrations before cron sends', async () => {
    const env = makeEnv({ RESEND_API_KEY: 'resend-secret' });
    let licenseStatus = 'active';
    const delivered = [];
    const fetchMock = spy(async (input) => {
      const url = String(input);
      if (url === 'https://api.lemonsqueezy.com/v1/licenses/validate') {
        return Response.json({
          valid: licenseStatus === 'active',
          license_key: { status: licenseStatus, expires_at: null },
          meta: { variant_name: 'Team', customer_email: 'buyer@example.test' },
          error: licenseStatus === 'active' ? undefined : `license ${licenseStatus}`,
        });
      }

      const collection = collectionResponse(url);
      if (collection) return collection;

      if (url === 'https://api.resend.com/emails' || url === 'https://hooks.example.test/trendpulse') {
        delivered.push(url);
        return Response.json({ ok: true });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });
    setFetch(fetchMock);

    const saved = await fetchWorker(env, '/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: 'team-key',
        email: 'ops@example.test',
        webhook: 'https://hooks.example.test/trendpulse',
      }),
    });
    assert.equal(saved.status, 200);

    const read = await fetchWorker(env, '/api/delivery?key=team-key');
    const registration = (await readJson(read)).registration;
    assert.equal(registration.license_key, undefined);

    for (const key of [...env.TP_DATA.store.keys()]) {
      if (key.startsWith('lic:')) await env.TP_DATA.delete(key);
    }
    const activeRun = await fetchWorker(env, '/api/run-now', { method: 'POST' });
    assert.equal(activeRun.status, 200);
    assert.deepEqual(delivered.sort(), [
      'https://api.resend.com/emails',
      'https://hooks.example.test/trendpulse',
    ]);

    await env.TP_DATA.delete('last_manual_run');
    for (const key of [...env.TP_DATA.store.keys()]) {
      if (key.startsWith('lic:')) await env.TP_DATA.delete(key);
    }
    delivered.length = 0;
    licenseStatus = 'expired';

    const expiredRun = await fetchWorker(env, '/api/run-now', { method: 'POST' });
    assert.equal(expiredRun.status, 200);
    assert.deepEqual(delivered, []);
  });
});

describe('collection and cron path', () => {
  it('collects sources, synthesizes a digest, stores raw/digest KV, and rate-limits manual reruns', async () => {
    const expectedDate = new Date().toISOString().slice(0, 10);
    const expectedSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const env = makeEnv({
      AI: {
        run: spy(async () => ({
          response: JSON.stringify({
            one_line: "Agent tooling is the day's cross-source theme",
            themes: [{
              name: 'Agent tooling',
              rationale: 'HN, GitHub, arxiv, and Reddit all mention agent systems.',
              example_titles: ['Agent platforms reach production'],
              signal_strength: 'rising',
            }],
          }),
        })),
      },
    });
    const fetchMock = stubCollectionFetch();

    const first = await fetchWorker(env, '/api/run-now', { method: 'POST' });
    assert.equal(first.status, 200);
    const body = await readJson(first);
    assert.equal(body.date_label, expectedDate);
    assert.equal(body.one_line, "Agent tooling is the day's cross-source theme");
    assert.deepEqual(body.source_counts, {
      hn: 1,
      github: 1,
      arxiv: 1,
      'reddit-ml': 1,
      'reddit-prog': 1,
    });

    assert.ok(fetchMock.calls.some(([input]) => String(input).includes(`created:>${expectedSince}`)));
    assert.equal(env.AI.run.calls.length, 1);

    const rawKeys = await env.TP_DATA.list({ prefix: 'raw:' });
    assert.equal(rawKeys.keys.length, 1);
    const raw = JSON.parse(env.TP_DATA.value(rawKeys.keys[0].name));
    assert.equal(raw.hn.length, 1);
    assert.equal(raw.github.length, 1);

    assert.ok(env.TP_DIGEST.value(`digest:${body.date_label}`));
    assert.ok(env.TP_DIGEST.value('digest:latest'));

    const aiPayload = env.AI.run.calls[0][1];
    assert.match(aiPayload.messages[1].content, /\(github\) org\/agent-runtime/);
    assert.match(aiPayload.messages[1].content, /Open source runtime for AI agents \[420\]/);
    assert.match(aiPayload.messages[1].content, /\(reddit-prog\) Tool calling frameworks in production/);

    const second = await fetchWorker(env, '/api/run-now', { method: 'POST' });
    assert.equal(second.status, 429);
    assert.deepEqual(await readJson(second), { error: 'manual rate limit; try later' });
  });
});
