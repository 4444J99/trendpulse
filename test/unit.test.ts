import { describe, it, expect } from 'vitest';
import {
  tierFromVariant,
  tierMeets,
  licenseFromRequest,
  tryParseJson,
  parseFilters,
  applyFilters,
  normalizeSearchQuery,
  digestMatchesSearch,
  validWebhookUrl,
  escapeHtmlServer,
} from '../src/index';

describe('tierFromVariant', () => {
  it('maps team/enterprise/business variants to team', () => {
    expect(tierFromVariant('Team')).toBe('team');
    expect(tierFromVariant('Enterprise plan')).toBe('team');
    expect(tierFromVariant('Business')).toBe('team');
  });

  it('defaults any other (active) variant to pro', () => {
    expect(tierFromVariant('Pro')).toBe('pro');
    expect(tierFromVariant('')).toBe('pro');
    expect(tierFromVariant(null)).toBe('pro');
    expect(tierFromVariant(undefined)).toBe('pro');
  });
});

describe('tierMeets', () => {
  it('honors the free < pro < team ordering', () => {
    expect(tierMeets('team', 'pro')).toBe(true);
    expect(tierMeets('pro', 'pro')).toBe(true);
    expect(tierMeets('pro', 'team')).toBe(false);
    expect(tierMeets('free', 'pro')).toBe(false);
  });
});

describe('licenseFromRequest', () => {
  const url = new URL('https://x/api?key=fromquery');

  it('prefers the Authorization Bearer token', () => {
    const req = new Request('https://x', { headers: { Authorization: 'Bearer abc123' } });
    expect(licenseFromRequest(req, new URL('https://x'))).toBe('abc123');
  });

  it('falls back to the X-License-Key header', () => {
    const req = new Request('https://x', { headers: { 'X-License-Key': 'hdrkey' } });
    expect(licenseFromRequest(req, new URL('https://x'))).toBe('hdrkey');
  });

  it('falls back to the query param then the body', () => {
    const req = new Request('https://x');
    expect(licenseFromRequest(req, url)).toBe('fromquery');
    expect(licenseFromRequest(req, new URL('https://x'), { license_key: 'bodykey' })).toBe('bodykey');
  });

  it('returns null when no key is present', () => {
    expect(licenseFromRequest(new Request('https://x'), new URL('https://x'))).toBeNull();
  });
});

describe('tryParseJson', () => {
  it('parses plain JSON and code-fenced JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts the JSON object embedded in surrounding prose', () => {
    expect(tryParseJson('Here you go: {"ok":true} thanks')).toEqual({ ok: true });
  });

  it('passes objects through and returns null on garbage', () => {
    expect(tryParseJson({ a: 1 })).toEqual({ a: 1 });
    expect(tryParseJson('not json')).toBeNull();
    expect(tryParseJson(null)).toBeNull();
  });
});

describe('parseFilters', () => {
  it('normalizes keywords and validates sources', () => {
    const f = parseFilters(new URLSearchParams('keywords=AI, LLMs ,&sources=hn,bogus,arxiv'));
    expect(f.keywords).toEqual(['ai', 'llms']);
    expect(f.sources).toEqual(['hn', 'arxiv']);
  });

  it('defaults to all sources when none are valid', () => {
    const f = parseFilters(new URLSearchParams('sources=nope'));
    expect(f.sources).toEqual(['hn', 'github', 'arxiv', 'reddit-ml', 'reddit-prog']);
  });
});

describe('applyFilters', () => {
  const raw = {
    hn: [
      { source: 'hn' as const, title: 'New LLM release', url: 'u1', collected_at: 't' },
      { source: 'hn' as const, title: 'Gardening tips', url: 'u2', collected_at: 't' },
    ],
    arxiv: [{ source: 'arxiv' as const, title: 'Paper on transformers', url: 'u3', collected_at: 't' }],
  };

  it('keeps only selected sources', () => {
    const out = applyFilters(raw, { keywords: [], sources: ['hn'] });
    expect(Object.keys(out)).toEqual(['hn']);
    expect(out.hn).toHaveLength(2);
  });

  it('keeps only keyword-matching items and drops emptied sources', () => {
    const out = applyFilters(raw, { keywords: ['llm'], sources: ['hn', 'arxiv'] });
    expect(out.hn).toHaveLength(1);
    expect(out.hn[0].title).toBe('New LLM release');
    expect(out.arxiv).toBeUndefined();
  });
});

describe('digestMatchesSearch', () => {
  const digest = {
    generated_at: '2026-06-19T13:00:00.000Z',
    date_label: '2026-06-19',
    one_line: 'Agent infrastructure spending is rising',
    source_counts: {},
    themes: [{
      name: 'Runtime budgets',
      rationale: 'Teams are optimizing inference and tool calls.',
      example_titles: ['Agent runtime cost controls'],
      signal_strength: 'rising' as const,
    }],
  };

  it('normalizes whitespace and casing', () => {
    expect(normalizeSearchQuery('  Agent   Runtime  ')).toBe('agent runtime');
  });

  it('matches digest headlines and themes', () => {
    expect(digestMatchesSearch(digest, 'agent runtime')).toBe(true);
    expect(digestMatchesSearch(digest, 'hardware')).toBe(false);
  });
});

describe('validWebhookUrl', () => {
  it('accepts http(s) URLs and rejects others', () => {
    expect(validWebhookUrl('https://example.com/hook')).toBe(true);
    expect(validWebhookUrl('http://example.com')).toBe(true);
    expect(validWebhookUrl('ftp://example.com')).toBe(false);
    expect(validWebhookUrl('https://user:pass@example.com/hook')).toBe(false);
    expect(validWebhookUrl('not a url')).toBe(false);
  });
});

describe('escapeHtmlServer', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtmlServer('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(escapeHtmlServer(null)).toBe('');
  });
});
