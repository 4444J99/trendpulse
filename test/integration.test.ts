import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRunScheduled, type Digest, type Env } from '../src/index';

type Spy<T extends (...args: any[]) => any> = T & { calls: Parameters<T>[] };

class MemoryKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, _options?: unknown): Promise<void> {
    this.store.set(key, String(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options: { prefix?: string; limit?: number } = {}) {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const keys = [...this.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((name) => ({ name }));

    return { keys, list_complete: true, cursor: undefined };
  }

  value(key: string): string | undefined {
    return this.store.get(key);
  }
}

type TestEnv = Env & {
  AI: { run: Spy<(model: string, input: any) => Promise<{ response: string }>> };
  ASSETS: { fetch: Spy<(req: Request) => Promise<Response>> };
  TP_DATA: MemoryKV;
  TP_DIGEST: MemoryKV;
};

function spy<T extends (...args: any[]) => any>(impl: T): Spy<T> {
  const calls: Parameters<T>[] = [];
  const fn = ((...args: Parameters<T>) => {
    calls.push(args);
    return impl(...args);
  }) as Spy<T>;
  fn.calls = calls;
  return fn;
}

function makeEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  const env = {
    AI: { run: spy(async (_model: string, _input: any) => ({ response: '{"one_line":"default","themes":[]}' })) },
    ASSETS: { fetch: spy(async (_req: Request) => new Response('asset fallback', { status: 200 })) },
    TP_DATA: new MemoryKV(),
    TP_DIGEST: new MemoryKV(),
    USER_AGENT: 'TrendPulse integration tests',
    CHECKOUT_URL: 'https://checkout.example/trendpulse',
  } as TestEnv;

  return Object.assign(env, overrides);
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://trendpulse.test${path}`, init);
}

async function fetchWorker(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(request(path, init), env);
}

async function readJson<T = any>(resp: Response): Promise<T> {
  return resp.json() as Promise<T>;
}

function digestBody(oneLine: string): Pick<Digest, 'one_line' | 'themes'> {
  return {
    one_line: oneLine,
    themes: [{
      name: 'Agent tooling',
      rationale: 'HN, GitHub, arxiv, and Reddit all mention agent systems.',
      example_titles: ['Agent platforms reach production'],
      signal_strength: 'rising',
    }],
  };
}

function urlFromInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function stubExternalFetch() {
  const fetchMock = spy(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlFromInput(input);

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
    if (url === 'https://api.lemonsqueezy.com/v1/licenses/validate') {
      const key = new URLSearchParams(String(init?.body ?? '')).get('license_key');
      return Response.json({
        valid: key === 'team-key',
        license_key: {
          status: key === 'team-key' ? 'active' : 'inactive',
          expires_at: null,
        },
        meta: {
          variant_name: 'Team',
          customer_email: 'buyer@example.test',
        },
        error: key === 'team-key' ? undefined : 'license inactive',
      });
    }
    if (url === 'https://hooks.example.test/trendpulse') {
      return Response.json({ ok: true });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function runScheduled(env: Env): Promise<void> {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waits.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;

  await worker.scheduled({} as ScheduledEvent, env, ctx);
  await Promise.all(waits);
}

describe('integration: main TrendPulse flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T14:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs collection, exposes the digest, unlocks premium customization, and pushes saved delivery', async () => {
    const aiResponses = [
      digestBody("Agent tooling is the day's cross-source theme"),
      digestBody('Agent infrastructure dominates your watchlist'),
      digestBody('Scheduled digest refresh is complete'),
    ];
    const env = makeEnv({
      AI: {
        run: spy(async () => ({
          response: JSON.stringify(aiResponses.shift() ?? digestBody('fallback digest')),
        })),
      },
    });
    const fetchMock = stubExternalFetch();

    const emptyLatest = await fetchWorker(env, '/api/digest/latest');
    expect(emptyLatest.status).toBe(202);
    expect(await readJson(emptyLatest)).toMatchObject({
      message: expect.stringMatching(/no digest yet/),
    });

    const config = await fetchWorker(env, '/api/config');
    expect(await readJson(config)).toMatchObject({
      checkout_url: 'https://checkout.example/trendpulse',
      premium_enabled: true,
      email_delivery: false,
    });

    const runNow = await handleRunScheduled(request('/internal/run-scheduled', {method:'POST',body:JSON.stringify({target:'trendpulse',capability:'trend-digests'})}), env);
    expect(runNow.status).toBe(200);
    const generated = await readJson<Digest>(await fetchWorker(env, '/api/digest/latest'));
    expect(generated).toMatchObject({
      date_label: '2026-06-20',
      one_line: "Agent tooling is the day's cross-source theme",
      source_counts: {
        hn: 1,
        github: 1,
        arxiv: 1,
        'reddit-ml': 1,
        'reddit-prog': 1,
      },
    });
    expect(fetchMock.calls.some(([input]) => urlFromInput(input).includes('created:>2026-06-13'))).toBe(true);
    expect(env.TP_DIGEST.value('digest:latest')).toBeTruthy();
    expect(env.TP_DIGEST.value('digest:2026-06-20')).toBeTruthy();

    const latest = await fetchWorker(env, '/api/digest/latest');
    expect(latest.status).toBe(200);
    expect(await readJson<Digest>(latest)).toMatchObject({
      one_line: "Agent tooling is the day's cross-source theme",
    });

    const history = await fetchWorker(env, '/api/digest/history');
    expect(await readJson(history)).toMatchObject({
      count: 1,
      digests: [expect.objectContaining({ date_label: '2026-06-20' })],
    });

    const status = await fetchWorker(env, '/api/status');
    expect(await readJson(status)).toMatchObject({
      name: 'TrendPulse',
      has_latest_digest: true,
      last_collections: ['2026-06-20T14:00:00.000Z'],
    });

    const rateLimited = await fetchWorker(env, '/api/run-now', { method: 'POST' });
    expect(rateLimited.status).toBe(503);
    expect(await readJson(rateLimited)).toEqual({ error: 'Manual collection is unavailable; digests update automatically.' });

    const license = await fetchWorker(env, '/api/license/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: 'team-key' }),
    });
    expect(license.status).toBe(200);
    expect(await readJson(license)).toMatchObject({
      valid: true,
      tier: 'team',
      status: 'active',
    });

    const custom = await fetchWorker(env, '/api/digest/custom?key=team-key&keywords=agent&sources=hn,github');
    expect(custom.status).toBe(200);
    expect(await readJson(custom)).toMatchObject({
      tier: 'team',
      one_line: 'Agent infrastructure dominates your watchlist',
      matched: 2,
      filters: { keywords: ['agent'], sources: ['hn', 'github'] },
      source_counts: { hn: 1, github: 1 },
    });
    expect(env.AI.run.calls[1][1].messages[0].content).toContain('topics matching: agent');
    expect(env.AI.run.calls[1][1].messages[1].content).toContain('(github) org/agent-runtime');

    const savedDelivery = await fetchWorker(env, '/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: 'team-key',
        webhook: 'https://hooks.example.test/trendpulse',
        webhook_secret: 'signing-secret',
        keywords: ['Agent'],
        sources: ['hn', 'github'],
      }),
    });
    expect(savedDelivery.status).toBe(200);
    expect(await readJson(savedDelivery)).toEqual({
      ok: true,
      registered: {
        email: false,
        webhook: true,
        filters: { keywords: ['agent'], sources: ['hn', 'github'] },
      },
      tier: 'team',
    });

    const delivery = await fetchWorker(env, '/api/delivery?key=team-key');
    expect(delivery.status).toBe(200);
    expect(await readJson(delivery)).toMatchObject({
      tier: 'team',
      registration: {
        tier: 'team',
        webhook: 'https://hooks.example.test/trendpulse',
        filters: { keywords: ['agent'], sources: ['hn', 'github'] },
      },
    });

    vi.setSystemTime(new Date('2026-06-20T18:00:00.000Z'));
    await runScheduled(env);

    expect(env.AI.run.calls).toHaveLength(3);
    const webhookCall = fetchMock.calls.find(([input]) => urlFromInput(input) === 'https://hooks.example.test/trendpulse');
    expect(webhookCall).toBeTruthy();
    const webhookInit = webhookCall?.[1] as RequestInit;
    expect(webhookInit.method).toBe('POST');
    expect(webhookInit.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-TrendPulse-Event': 'digest',
      'X-TrendPulse-Signature': expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const webhookPayload = JSON.parse(String(webhookInit.body));
    expect(webhookPayload).toMatchObject({
      event: 'digest',
      digest: {
        one_line: 'Agent infrastructure dominates your watchlist',
        filters: { keywords: ['agent'], sources: ['hn', 'github'] },
        matched: 2,
      },
    });
  });

  it('keeps premium endpoints paywalled until a valid subscription is supplied', async () => {
    const env = makeEnv();

    const custom = await fetchWorker(env, '/api/digest/custom?keywords=agent');
    expect(custom.status).toBe(402);
    expect(await readJson(custom)).toMatchObject({
      error: expect.stringMatching(/premium feature/),
      your_status: 'missing',
      your_tier: 'free',
      upgrade: 'https://checkout.example/trendpulse',
    });

    const delivery = await fetchWorker(env, '/api/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: 'https://hooks.example.test/trendpulse' }),
    });
    expect(delivery.status).toBe(402);
    expect(await readJson(delivery)).toMatchObject({
      error: expect.stringMatching(/premium feature/),
      your_status: 'missing',
    });
  });

  it('falls back to static assets for non-API routes', async () => {
    const env = makeEnv();

    const fallback = await fetchWorker(env, '/');
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe('asset fallback');
    expect(env.ASSETS.fetch.calls).toHaveLength(1);
  });

  it('POST /internal/run-scheduled handles trend-digests named capability and returns structured receipt', async () => {
    stubExternalFetch();
    const env = makeEnv({
      AI: {
        run: spy(async () => ({
          response: JSON.stringify(digestBody('Scheduled digest refresh is complete')),
        })),
      },
    });

    const res = await handleRunScheduled(request('/internal/run-scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scheduler-RID': 'test-run-tp' },
      body: JSON.stringify({
        scheduledTime: 1794103200000,
        cron: '0 1,5,9,13,17,21 * * *',
        target: 'trendpulse',
        contractVersion: 2,
        capability: 'trend-digests',
        runId: 'trendpulse:test:1',
      }),
    }), env);
    expect(res.status).toBe(200);
    const body = await readJson(res) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.state).toBe('completed');
    expect(body.completedItems).toBe(1);
    expect(body.pendingItems).toBe(0);
    expect(body.details).toBeDefined();

    // Rejects unsupported capability
    const badCap = await handleRunScheduled(request('/internal/run-scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: 'bad-capability' }),
    }), env);
    expect(badCap.status).toBe(400);

    // Rejects invalid target
    const badTarget = await handleRunScheduled(request('/internal/run-scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'other-target', capability: 'trend-digests' }),
    }), env);
    expect(badTarget.status).toBe(400);
  });
});

it('public scheduler ingress refuses forged identity before effects', async () => {
  const env = makeEnv();
  const response = await fetchWorker(env, '/internal/run-scheduled', {
    method:'POST', headers:{'X-Scheduler-RID':'forged'},
    body:JSON.stringify({target:'forged', capability:'trend-digests'}),
  });
  expect(response.status).toBe(404);
  expect(env.TP_DATA.store.size).toBe(0);
  expect(env.AI.run.calls).toHaveLength(0);
});

it('private ingress requires explicit target and capability', async () => {
  stubExternalFetch();
  try {
    for (const payload of [{capability:'trend-digests'}, {target:'trendpulse'}]) {
      const env = makeEnv();
      const response = await handleRunScheduled(request('/internal/run-scheduled', {method:'POST',body:JSON.stringify(payload)}), env);
      expect(response.status).toBe(400);
      expect(env.TP_DATA.store.size).toBe(0);
    }
  } finally {vi.unstubAllGlobals();}
});

it.each(['source', 'inference', 'delivery'])('scheduled receipt cannot complete with failed %s', async (failure) => {
    const external = stubExternalFetch();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((failure === 'source' && urlFromInput(input).includes('api.github.com')) ||
          (failure === 'delivery' && urlFromInput(input).includes('delivery.example'))) {
        return new Response('unavailable', {status:503});
      }
      return external(input, init);
    });
    const env = makeEnv({AI:{run:spy(async () => {
      if (failure === 'inference') throw new Error('inference unavailable');
      return {response:JSON.stringify(digestBody('Scheduled digest'))};
    })}});
    if (failure === 'delivery') await env.TP_DATA.put('delivery:test', JSON.stringify({tier:'team',webhook:'https://delivery.example/webhook'}));
    try {
      const response = await handleRunScheduled(request('/internal/run-scheduled', {method:'POST',body:JSON.stringify({target:'trendpulse',capability:'trend-digests'})}), env);
      const body = await response.json() as {ok:boolean;state?:string};
      expect(body.ok).toBe(false);
      expect(body.state).not.toBe('completed');
    } finally {vi.unstubAllGlobals();}
});
it('public manual refresh cannot execute collection outside admission accounting', async () => {
 stubExternalFetch();
 try {
 const env=makeEnv();
 const response=await fetchWorker(env,'/api/run-now',{method:'POST'});
 expect(response.status).toBe(503);
 expect(env.TP_DATA.store.size).toBe(0);
 expect(env.TP_DIGEST.store.size).toBe(0);
 } finally {vi.unstubAllGlobals();}
});
