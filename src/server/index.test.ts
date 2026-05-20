import { describe, expect, test } from 'bun:test';
import { DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '../shared/types';
import type { FeedStatus } from '../shared/types';
import {
  cleanText,
  decodeEntities,
  escapeHtml,
  expandIPv6,
  FeedError,
  formatArticleDate,
  getBackoffDelayMs,
  getSafePublicUrl,
  isPrivateAddress,
  isPrivateHostname,
  isPrivateIPv4,
  normalizeUrl,
  parseStoredFeeds,
  rememberSeen,
  stripHtml,
  validatePublicHttpUrl
} from './index';

// Small factory for a FeedStatus that the math/dedup helpers can consume.
const makeStatus = (overrides: Partial<FeedStatus> = {}): FeedStatus => ({
  url: 'https://example.com/feed.xml',
  channelId: 1,
  intervalMinutes: 15,
  postOnBootstrap: false,
  bootstrappedAt: undefined,
  lastPolledAt: null,
  articlesPosted: 0,
  errorCount: 0,
  nextPollAt: null,
  backoffUntil: null,
  backoffDelayMinutes: null,
  ...overrides
});

describe('shared constants', () => {
  test('default + minimum intervals are exposed and sane', () => {
    expect(DEFAULT_INTERVAL_MINUTES).toBe(15);
    expect(MIN_INTERVAL_MINUTES).toBe(1);
  });
});

describe('isPrivateIPv4', () => {
  test('rejects loopback, RFC1918, link-local, broadcast, "this network"', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '255.255.255.255'
    ]) {
      expect(isPrivateIPv4(ip)).toBe(true);
    }
  });

  test('rejects RFC 6598 Carrier-Grade NAT 100.64.0.0/10 (incl. Alibaba metadata)', () => {
    expect(isPrivateIPv4('100.64.0.1')).toBe(true);
    expect(isPrivateIPv4('100.100.100.200')).toBe(true);
    expect(isPrivateIPv4('100.127.255.255')).toBe(true);
  });

  test('allows public IPv4 outside reserved ranges', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    expect(isPrivateIPv4('100.63.255.255')).toBe(false); // just below CGN
    expect(isPrivateIPv4('100.128.0.0')).toBe(false); // just above CGN
    expect(isPrivateIPv4('172.15.0.1')).toBe(false); // just below RFC1918
    expect(isPrivateIPv4('172.32.0.1')).toBe(false); // just above RFC1918
  });

  test('rejects malformed input as not-private (validation belongs elsewhere)', () => {
    expect(isPrivateIPv4('999.0.0.1')).toBe(false);
    expect(isPrivateIPv4('not-an-ip')).toBe(false);
    expect(isPrivateIPv4('10.0.0')).toBe(false);
  });
});

describe('expandIPv6', () => {
  test('expands compressed and uncompressed forms identically', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('0:0:0:0:0:0:0:1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('0000:0000:0000:0000:0000:0000:0000:0001')).toEqual([
      0, 0, 0, 0, 0, 0, 0, 1
    ]);
    expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('parses regular addresses', () => {
    expect(expandIPv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  test('rejects invalid forms', () => {
    expect(expandIPv6('1::2::3')).toBeUndefined();
    expect(expandIPv6('xyz::1')).toBeUndefined();
  });
});

describe('isPrivateAddress', () => {
  test('IPv6 loopback in every textual form (B3 regression)', () => {
    for (const addr of [
      '::1',
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '0000::1'
    ]) {
      expect(isPrivateAddress(addr)).toBe(true);
    }
  });

  test('IPv6 unspecified address ::', () => {
    expect(isPrivateAddress('::')).toBe(true);
    expect(isPrivateAddress('0:0:0:0:0:0:0:0')).toBe(true);
  });

  test('IPv6 ULA (fc00::/7) and link-local (fe80::/10)', () => {
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fdff:ffff::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('febf::1')).toBe(true);
  });

  test('IPv4-mapped IPv6 inherits IPv4 privacy', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:0:192.168.1.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  test('public IPv6 is allowed', () => {
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false); // Cloudflare
  });

  test('strips IPv6 brackets', () => {
    expect(isPrivateAddress('[::1]')).toBe(true);
  });

  test('IPv4 paths still work through isPrivateAddress', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('100.100.100.200')).toBe(true); // B1
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('isPrivateHostname', () => {
  test('rejects localhost variants', () => {
    expect(isPrivateHostname('localhost')).toBe(true);
    expect(isPrivateHostname('foo.localhost')).toBe(true);
    expect(isPrivateHostname('LOCALHOST')).toBe(true);
  });

  test('rejects private IPs literal', () => {
    expect(isPrivateHostname('192.168.1.1')).toBe(true);
    expect(isPrivateHostname('100.100.100.200')).toBe(true);
    expect(isPrivateHostname('[::1]')).toBe(true);
  });

  test('allows public hostnames and IPs', () => {
    expect(isPrivateHostname('example.com')).toBe(false);
    expect(isPrivateHostname('8.8.8.8')).toBe(false);
    expect(isPrivateHostname('hnrss.org')).toBe(false);
  });
});

describe('validatePublicHttpUrl + normalizeUrl', () => {
  test('accepts and canonicalises a public https URL', () => {
    const url = validatePublicHttpUrl('https://example.com/feed.xml');
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('example.com');
  });

  test('rejects malformed URL', () => {
    expect(() => validatePublicHttpUrl('not a url')).toThrow(FeedError);
  });

  test('rejects non-http schemes', () => {
    expect(() => validatePublicHttpUrl('ftp://example.com/feed.xml')).toThrow(FeedError);
    expect(() => validatePublicHttpUrl('file:///etc/passwd')).toThrow(FeedError);
  });

  test('rejects private hosts (literal IP and localhost)', () => {
    expect(() => validatePublicHttpUrl('http://127.0.0.1/feed.xml')).toThrow(FeedError);
    expect(() => validatePublicHttpUrl('http://localhost/feed.xml')).toThrow(FeedError);
    expect(() => validatePublicHttpUrl('http://[::1]/feed.xml')).toThrow(FeedError);
    // B1 regression: a CGN URL (Alibaba metadata) must be rejected.
    expect(() => validatePublicHttpUrl('http://100.100.100.200/feed.xml')).toThrow(FeedError);
  });

  test('normalizeUrl trims and strips fragment', () => {
    expect(normalizeUrl('  https://example.com/feed.xml#frag  ')).toBe(
      'https://example.com/feed.xml'
    );
  });

  test('normalizeUrl rejects empty string', () => {
    expect(() => normalizeUrl('')).toThrow(FeedError);
    expect(() => normalizeUrl('   ')).toThrow(FeedError);
  });
});

describe('getSafePublicUrl', () => {
  test('returns canonical URL for public http(s)', () => {
    expect(getSafePublicUrl('https://example.com/article#x')).toBe(
      'https://example.com/article'
    );
    expect(getSafePublicUrl('http://example.com/article')).toBe(
      'http://example.com/article'
    );
  });

  test('returns undefined for malformed input', () => {
    expect(getSafePublicUrl('not a url')).toBeUndefined();
    expect(getSafePublicUrl(undefined)).toBeUndefined();
    expect(getSafePublicUrl('')).toBeUndefined();
  });

  test('returns undefined for non-http schemes', () => {
    expect(getSafePublicUrl('javascript:alert(1)')).toBeUndefined();
    expect(getSafePublicUrl('ftp://example.com/x')).toBeUndefined();
  });

  test('returns undefined for private hosts', () => {
    expect(getSafePublicUrl('http://127.0.0.1/x')).toBeUndefined();
    expect(getSafePublicUrl('http://localhost/x')).toBeUndefined();
    expect(getSafePublicUrl('http://192.168.1.1/x')).toBeUndefined();
  });
});

describe('parseStoredFeeds', () => {
  test('returns [] on malformed JSON', () => {
    expect(parseStoredFeeds('{not json}')).toEqual([]);
  });

  test('returns [] on non-array JSON', () => {
    expect(parseStoredFeeds('"hello"')).toEqual([]);
    expect(parseStoredFeeds('{"feeds":[]}')).toEqual([]);
  });

  test('accepts a valid feed and applies default intervalMinutes', () => {
    const feeds = parseStoredFeeds(
      JSON.stringify([{ url: 'https://example.com/feed.xml', channelId: 2 }])
    );
    expect(feeds).toEqual([
      {
        url: 'https://example.com/feed.xml',
        channelId: 2,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        postOnBootstrap: false,
        bootstrappedAt: undefined
      }
    ]);
  });

  test('clamps too-small intervals to MIN_INTERVAL_MINUTES', () => {
    const feeds = parseStoredFeeds(
      JSON.stringify([
        { url: 'https://example.com/feed.xml', channelId: 2, intervalMinutes: 0 }
      ])
    );
    expect(feeds[0]!.intervalMinutes).toBe(MIN_INTERVAL_MINUTES);
  });

  test('skips rows missing required fields, keeps valid ones', () => {
    const feeds = parseStoredFeeds(
      JSON.stringify([
        { url: 'https://example.com/feed.xml', channelId: 2 },
        { channelId: 3 }, // missing url
        { url: 'https://example.com/other.xml' }, // missing channelId
        { url: 'https://example.com/third.xml', channelId: 'not-a-number' }
      ])
    );
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.url).toBe('https://example.com/feed.xml');
  });

  test('skips rows with private hosts (defense-in-depth at parse time)', () => {
    const feeds = parseStoredFeeds(
      JSON.stringify([
        { url: 'http://127.0.0.1/feed.xml', channelId: 2 },
        { url: 'https://example.com/feed.xml', channelId: 3 }
      ])
    );
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.url).toBe('https://example.com/feed.xml');
  });

  test('preserves bootstrappedAt round-trip', () => {
    const feeds = parseStoredFeeds(
      JSON.stringify([
        {
          url: 'https://example.com/feed.xml',
          channelId: 2,
          intervalMinutes: 15,
          postOnBootstrap: true,
          bootstrappedAt: 1700000000000
        }
      ])
    );
    expect(feeds[0]!.bootstrappedAt).toBe(1700000000000);
    expect(feeds[0]!.postOnBootstrap).toBe(true);
  });

  test('accepts an already-parsed array input', () => {
    const feeds = parseStoredFeeds([
      { url: 'https://example.com/feed.xml', channelId: 2 }
    ]);
    expect(feeds).toHaveLength(1);
  });
});

describe('getBackoffDelayMs', () => {
  // POLL_TICK_MS-independent: formula is intervalMinutes*60_000 * 2^errorCount, capped at 6h.
  const MIN = 60_000;
  const SIX_HOURS = 6 * 60 * 60_000;

  test('starts at intervalMinutes * 1 when no errors recorded', () => {
    expect(getBackoffDelayMs(makeStatus({ intervalMinutes: 1, errorCount: 0 }))).toBe(MIN);
  });

  test('doubles per consecutive error', () => {
    expect(getBackoffDelayMs(makeStatus({ intervalMinutes: 1, errorCount: 1 }))).toBe(MIN * 2);
    expect(getBackoffDelayMs(makeStatus({ intervalMinutes: 1, errorCount: 2 }))).toBe(MIN * 4);
    expect(getBackoffDelayMs(makeStatus({ intervalMinutes: 1, errorCount: 3 }))).toBe(MIN * 8);
  });

  test('caps at MAX_BACKOFF_MS regardless of error count', () => {
    expect(getBackoffDelayMs(makeStatus({ intervalMinutes: 1, errorCount: 16 }))).toBe(SIX_HOURS);
    expect(getBackoffDelayMs(makeStatus({ intervalMinutes: 1, errorCount: 999 }))).toBe(SIX_HOURS);
  });
});

describe('rememberSeen', () => {
  test('adds new ids and skips no-ops for duplicates', () => {
    const seen = new Set<string>();
    rememberSeen(seen, 'a');
    rememberSeen(seen, 'b');
    rememberSeen(seen, 'a');
    expect([...seen]).toEqual(['a', 'b']);
  });

  test('evicts oldest entries beyond the per-feed cap (FIFO)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1005; i += 1) rememberSeen(seen, `id-${i}`);
    expect(seen.size).toBe(1000);
    // First 5 ids should be evicted, last id should still be present.
    expect(seen.has('id-0')).toBe(false);
    expect(seen.has('id-4')).toBe(false);
    expect(seen.has('id-5')).toBe(true);
    expect(seen.has('id-1004')).toBe(true);
  });
});

describe('formatArticleDate', () => {
  test('formats isoDate as YYYY-MM-DD HH:MM in local time, zero-padded', () => {
    // Build a deterministic date in local time and feed back its ISO form.
    const localDate = new Date(2024, 0, 5, 7, 4); // Jan 5 2024, 07:04 local
    const result = formatArticleDate({ isoDate: localDate.toISOString() });
    expect(result).toBe('2024-01-05 07:04');
  });

  test('falls back to pubDate when isoDate is missing', () => {
    const localDate = new Date(2024, 5, 30, 23, 59);
    const result = formatArticleDate({ pubDate: localDate.toISOString() });
    expect(result).toBe('2024-06-30 23:59');
  });

  test('returns undefined for missing or invalid input', () => {
    expect(formatArticleDate({})).toBeUndefined();
    expect(formatArticleDate({ isoDate: 'not-a-date' })).toBeUndefined();
  });
});

describe('stripHtml + decodeEntities + cleanText', () => {
  test('stripHtml removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
    expect(stripHtml('a  \n  b')).toBe('a b');
  });

  test('decodeEntities handles named, numeric, and hex entities', () => {
    expect(decodeEntities('Caf&eacute; &amp; Th&eacute;')).toBe('Café & Thé');
    expect(decodeEntities('&#233;')).toBe('é');
    expect(decodeEntities('&#xE9;')).toBe('é');
  });

  test('decodeEntities is safe against codepoints > 0x10FFFF (B2 regression)', () => {
    // Without the safeFromCodePoint guard, this would throw a RangeError and
    // break the surrounding cleanText/formatArticleMessage pipeline.
    expect(() => decodeEntities('explode &#999999999999; here')).not.toThrow();
    // The bad entity is stripped to an empty string, surrounding text kept.
    expect(decodeEntities('explode &#999999999999; here')).toBe('explode  here');
  });

  test('cleanText chains strip + decode', () => {
    expect(cleanText('<p>Caf&eacute; &amp; Th&eacute;</p>')).toBe('Café & Thé');
  });
});

describe('escapeHtml', () => {
  test('escapes the 5 HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
  });

  test('is a no-op on plain text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
