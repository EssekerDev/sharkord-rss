import type { PluginContext, PluginSettings } from '@sharkord/plugin-sdk';
import * as http from 'node:http';
import * as https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import Parser from 'rss-parser';
import manifest from '../../manifest.json';
import {
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  type FeedConfig,
  type FeedStatus
} from '../shared/types';

type SettingsDefinition = readonly [
  {
    key: 'feeds';
    name: string;
    description: string;
    type: 'string';
    defaultValue: string;
  }
];

type FeedSettings = PluginSettings<SettingsDefinition>;

type ParsedItem = {
  guid?: string;
  id?: string;
  title?: string;
  link?: string;
  isoDate?: string;
  pubDate?: string;
};

type ParsedFeed = {
  items?: ParsedItem[];
};

type MarkStats = {
  indexed: number;
  ignoredMissingId: number;
  ignoredDuplicate: number;
};

type PostStats = {
  posted: number;
  ignoredSeen: number;
  ignoredMissingId: number;
};

class FeedError extends Error {
  public code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
  }
}

// Runtime tuning is intentionally centralized for easier production debugging.
// The tick runs `syncFeedsFromSettings` (cheap: a snapshot compare with an
// early return when unchanged) plus a `nextPollAt` filter, so a short period
// is fine. We keep it short because Sharkord's admin dialog does NOT emit a
// `setting:set` event when an admin saves: dialog-saved configs would otherwise
// only be picked up at the next 60-second tick. 10 s keeps the perceived
// "save -> first article posted" latency low without adding measurable load.
const POLL_TICK_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const SEND_DELAY_MS = 500;
const BOOTSTRAP_POST_LIMIT = 10;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_SEEN_PER_FEED = 1000;
const FEEDS_SETTING = 'feeds';
const USER_AGENT = `sharkord-rss/${manifest.version} (+https://github.com/EssekerDev/sharkord-rss)`;

const parser = new Parser<Record<string, unknown>, ParsedItem>();

const statuses = new Map<string, FeedStatus>();
const seenArticles = new Map<string, Set<string>>();
let settingsRef: FeedSettings | undefined;
let intervalId: ReturnType<typeof setInterval> | undefined;
let polling = false;
let settingsSnapshot = '';
// Cache of the raw settings value seen during the last sync. The scheduler tick
// runs every POLL_TICK_MS and re-reads settings; if the value is byte-identical
// to the previous tick we skip parsing entirely so `parseStoredFeeds` does not
// re-log `ctx.error` for the same invalid JSON every 10 s.
let rawSnapshot = '';
let unsubscribeSettings: (() => void) | undefined;

// Pure helper exposed for testing: produces a deterministic signature for any
// settings value (string passthrough; structured value stringified). Falls back
// to '' when the input is unstringifiable (e.g. `undefined`) so callers can
// always rely on a string for equality checks.
const computeRawSettingsSignature = (raw: unknown): string =>
  typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? '');

// Both the scheduler tick and Sharkord's setting:set event can trigger a sync
// or poll concurrently. We chain through this Promise so the two paths never
// mutate `statuses` / `seenArticles` at the same time.
let syncChain: Promise<void> = Promise.resolve();

const runSerialized = <T>(task: () => Promise<T>): Promise<T> => {
  const next = syncChain.then(task, task);
  syncChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

// Article-id memory is capped per feed so long-running deployments cannot grow
// the seen set without bound. The eviction strategy is FIFO via Set insertion
// order, which is sufficient because feeds present newest items first.
const rememberSeen = (seen: Set<string>, id: string): void => {
  seen.add(id);
  while (seen.size > MAX_SEEN_PER_FEED) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
};

// RSS content often mixes HTML, XML entities, and occasionally percent-encoded
// fragments. The helpers below reduce that into short, safe text snippets.
const stripHtml = (content: string): string => {
  return content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
};

const decodePercentEncoding = (content: string): string => {
  return content.replace(/%(?:[0-9a-f]{2})+/gi, (match) => {
    try {
      return decodeURIComponent(match);
    } catch {
      return match;
    }
  });
};

// Named entities commonly seen in RSS/Atom titles (content decoding, NOT UI i18n).
// Hoisted to module scope so the object is allocated once instead of on every call.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  ccedil: '\u00e7',
  eacute: '\u00e9',
  egrave: '\u00e8',
  ecirc: '\u00ea',
  euml: '\u00eb',
  agrave: '\u00e0',
  acirc: '\u00e2',
  auml: '\u00e4',
  icirc: '\u00ee',
  iuml: '\u00ef',
  ocirc: '\u00f4',
  ouml: '\u00f6',
  ugrave: '\u00f9',
  ucirc: '\u00fb',
  uuml: '\u00fc',
  nbsp: ' ',
  quot: '"',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: '...',
  lt: '<',
  gt: '>'
};

// Guard against feeds containing entities outside the Unicode range
// (`&#999999999999;`): `String.fromCodePoint` throws `RangeError` for any
// codepoint above 0x10FFFF, which would otherwise crash the title parse and
// send the feed into backoff.
const safeFromCodePoint = (codePoint: number): string => {
  return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
};

const decodeEntities = (content: string): string => {
  return decodePercentEncoding(content)
    .replace(/&#(\d+);/g, (_match, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      safeFromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&([a-z]+);/gi, (match, entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? match);
};

const cleanText = (content: string): string => {
  return decodeEntities(stripHtml(content));
};

const escapeHtml = (content: string): string => {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// SSRF guard. `isPrivateAddress` takes a raw IPv4 or IPv6 string and reports
// whether it falls in a loopback, link-local, broadcast, or RFC1918/ULA range.
// `isPrivateHostname` adds string-level checks (localhost, bracketed IPv6)
// and delegates the numeric work to `isPrivateAddress`.

// Expand any valid IPv6 representation into 8 numeric hextets, or return
// undefined when the input cannot be parsed. Handles `::` shorthand and
// uncompressed forms (`0:0:0:0:0:0:0:1`, `0000::1`, etc.).
const expandIPv6 = (address: string): number[] | undefined => {
  const doubleColonCount = (address.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return undefined;

  const [leftPart, rightPart] = address.includes('::')
    ? address.split('::')
    : [address, undefined];

  const left = leftPart ? leftPart.split(':') : [];
  const right = rightPart !== undefined ? (rightPart === '' ? [] : rightPart.split(':')) : [];
  const missing = 8 - left.length - right.length;
  if (rightPart === undefined && missing !== 0) return undefined;
  if (missing < 0) return undefined;

  const all = [...left, ...Array(missing).fill('0'), ...right];
  if (all.length !== 8) return undefined;

  const parsed = all.map((h) => Number.parseInt(h || '0', 16));
  if (parsed.some((v) => Number.isNaN(v) || v < 0 || v > 0xffff)) return undefined;
  return parsed;
};

const isPrivateIPv4 = (address: string): boolean => {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4) return false;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 255 && b === 255) return true;
  // RFC 6598 Carrier-Grade NAT (100.64.0.0/10). Several cloud providers host
  // their instance-metadata service in this range (e.g. Alibaba's 100.100.100.200),
  // so it must be treated as private even though it is not RFC 1918.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
};

const isPrivateAddress = (address: string): boolean => {
  const bare = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const family = isIP(bare);

  if (family === 4) return isPrivateIPv4(bare);

  if (family === 6) {
    // IPv4-mapped IPv6 with dotted-decimal IPv4 in any prefix form:
    // `::ffff:127.0.0.1`, `::ffff:0:127.0.0.1`, or the fully expanded
    // `0:0:0:0:0:ffff:127.0.0.1`. The hex-only form (`::ffff:7f00:1`) is
    // handled after `expandIPv6` below because `parseInt` cannot mix
    // hex hextets and dotted-quads in a single pass.
    const mapped = /^(?:0*:)*0*:?ffff:(?:0*:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
    if (mapped && mapped[1]) return isPrivateIPv4(mapped[1]);

    // Expand `::` so loopback / unspecified are detected in every textual
    // form, not just the canonical `::` / `::1` (e.g. `0:0:0:0:0:0:0:1`,
    // `0000::1`, etc. — a `URL` parser would normally canonicalise these,
    // but the function is also used as a defense-in-depth check on raw IPs).
    const expanded = expandIPv6(bare);
    if (expanded) {
      if (expanded.every((hextet) => hextet === 0)) return true; // ::
      if (expanded.slice(0, 7).every((h) => h === 0) && expanded[7] === 1) return true; // ::1

      // IPv4-mapped IPv6 in any hextet form, e.g. `::ffff:7f00:1` (hex) or the
      // fully expanded `0:0:0:0:0:ffff:127.0.0.1`. The dotted-decimal regex
      // above only catches the compact textual form; this branch recovers the
      // embedded IPv4 from hextets[6..7] so SSRF checks apply after expansion.
      if (
        expanded.slice(0, 5).every((h) => h === 0) &&
        expanded[5] === 0xffff
      ) {
        const h6 = expanded[6] ?? 0;
        const h7 = expanded[7] ?? 0;
        const ipv4 = `${(h6 >> 8) & 0xff}.${h6 & 0xff}.${(h7 >> 8) & 0xff}.${h7 & 0xff}`;
        return isPrivateIPv4(ipv4);
      }

      const first = expanded[0] ?? 0;
      if (first >= 0xfc00 && first <= 0xfdff) return true; // Unique local
      if (first >= 0xfe80 && first <= 0xfebf) return true; // Link-local
    }
    return false;
  }

  return false;
};

const isPrivateHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isPrivateAddress(host);
};

// Single source of truth for "is this URL a safe outbound HTTP(S) target".
// Used at settings-save (`normalizeUrl`) and on every redirect target
// (`fetchFeedXml`) so both paths apply identical checks.
const validatePublicHttpUrl = (rawUrl: string): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FeedError('INVALID_URL', 'Invalid feed URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new FeedError('INVALID_URL', 'Invalid feed URL protocol.');
  }
  if (isPrivateHostname(url.hostname)) {
    throw new FeedError('PRIVATE_HOST', 'Refusing to use a private or loopback feed host.');
  }
  return url;
};

// Store a canonical feed URL so dedupe, settings persistence, and logs all use
// the same key even if users paste URLs with whitespace or fragments.
const normalizeUrl = (rawUrl: string): string => {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new FeedError('INVALID_URL', 'Invalid feed URL.');
  }
  const url = validatePublicHttpUrl(trimmed);
  url.hash = '';
  return url.toString();
};

// Keep polling intervals predictable and avoid very aggressive feed loops.
const normalizeInterval = (intervalMinutes?: number): number => {
  if (typeof intervalMinutes !== 'number' || !Number.isFinite(intervalMinutes)) {
    return DEFAULT_INTERVAL_MINUTES;
  }

  return Math.max(MIN_INTERVAL_MINUTES, Math.floor(intervalMinutes));
};

// The setting is persisted as a JSON string; parse it defensively and skip any
// invalid entry so one bad row never breaks the whole plugin.
const parseStoredFeeds = (raw: unknown, ctx?: PluginContext): FeedConfig[] => {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((feed, index): FeedConfig[] => {
      try {
        if (!feed || typeof feed !== 'object') {
          throw new FeedError('INVALID_FEED', 'Feed setting row must be an object.');
        }

        const candidate = feed as Partial<FeedConfig>;
        if (typeof candidate.url !== 'string') {
          throw new FeedError('INVALID_FEED', 'Feed URL must be a string.');
        }
        if (typeof candidate.channelId !== 'number') {
          throw new FeedError('INVALID_FEED', 'Feed channelId must be a number.');
        }

        return [
          {
            url: normalizeUrl(candidate.url),
            channelId: candidate.channelId,
            intervalMinutes: normalizeInterval(candidate.intervalMinutes),
            postOnBootstrap: candidate.postOnBootstrap === true,
            bootstrappedAt:
              typeof candidate.bootstrappedAt === 'number' &&
              Number.isFinite(candidate.bootstrappedAt)
                ? candidate.bootstrappedAt
                : undefined
          }
        ];
      } catch (error) {
        ctx?.error('RSS settings skipped an invalid feed entry', {
          index,
          reason: error instanceof Error ? error.message : String(error)
        });
        return [];
      }
    });
  } catch (error) {
    ctx?.error('RSS settings parse failed', {
      reason: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
};

// Only persist the editable feed fields plus `bootstrappedAt`. Runtime-only
// status fields (errorCount, nextPollAt, etc.) stay in memory.
const serializeFeeds = (): FeedConfig[] => {
  return Array.from(
    statuses.values(),
    ({ url, channelId, intervalMinutes, postOnBootstrap, bootstrappedAt }) => ({
      url,
      channelId,
      intervalMinutes,
      postOnBootstrap: postOnBootstrap === true,
      bootstrappedAt
    })
  );
};

const persistFeeds = (): void => {
  settingsRef?.set(FEEDS_SETTING, JSON.stringify(serializeFeeds()));
};

// Build or refresh runtime status while preserving useful counters where possible.
const createStatus = (config: FeedConfig, existing?: FeedStatus): FeedStatus => {
  const now = Date.now();
  const normalNextPollAt = now + config.intervalMinutes * 60_000;
  const hasBackoff = existing?.backoffUntil !== null && existing?.backoffUntil !== undefined;
  const intervalUnchanged = existing?.intervalMinutes === config.intervalMinutes;
  const shouldKeepSchedule = hasBackoff || intervalUnchanged;
  const nextPollAt = shouldKeepSchedule
    ? (existing?.nextPollAt ?? normalNextPollAt)
    : normalNextPollAt;

  return {
    ...config,
    bootstrappedAt: existing?.bootstrappedAt ?? config.bootstrappedAt,
    lastPolledAt: existing?.lastPolledAt ?? null,
    articlesPosted: existing?.articlesPosted ?? 0,
    errorCount: existing?.errorCount ?? 0,
    nextPollAt,
    backoffUntil: existing?.backoffUntil ?? null,
    backoffDelayMinutes: existing?.backoffDelayMinutes ?? null
  };
};

const getNormalPollDelayMs = (status: FeedStatus): number => {
  return status.intervalMinutes * 60_000;
};

// Backoff is runtime-only: failed feeds wait longer without changing settings.
const getBackoffDelayMs = (status: FeedStatus): number => {
  const boundedExponent = Math.min(status.errorCount, 16);
  return Math.min(getNormalPollDelayMs(status) * 2 ** boundedExponent, MAX_BACKOFF_MS);
};

const scheduleNextNormalPoll = (status: FeedStatus): void => {
  status.nextPollAt = Date.now() + getNormalPollDelayMs(status);
  status.backoffUntil = null;
  status.backoffDelayMinutes = null;
};

const scheduleNextBackoffPoll = (status: FeedStatus): void => {
  const delayMs = getBackoffDelayMs(status);
  const nextPollAt = Date.now() + delayMs;

  status.nextPollAt = nextPollAt;
  status.backoffUntil = nextPollAt;
  status.backoffDelayMinutes = Math.ceil(delayMs / 60_000);
};

const getArticleId = (item: ParsedItem): string | undefined => {
  return item.guid || item.id || item.link || item.title;
};

// Apply the same public-HTTP(S) rules to article links before rendering them
// in messages, but return `undefined` instead of throwing so message
// formatting can simply drop unsafe URLs without try/catch at every call site.
const getSafePublicUrl = (rawUrl: string | undefined): string | undefined => {
  if (!rawUrl) return undefined;
  try {
    const url = validatePublicHttpUrl(rawUrl.trim());
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
};

const padDatePart = (value: number): string => {
  return value.toString().padStart(2, '0');
};

// Keep article dates locale-neutral because the server renderer does not know
// which interface language each reader uses.
const formatArticleDate = (item: ParsedItem): string | undefined => {
  const rawDate = item.isoDate || item.pubDate;
  if (!rawDate) return undefined;

  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return undefined;

  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());

  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

// Custom DNS lookup used by every outbound feed request. Resolving here (rather
// than letting rss-parser do its own fetch) lets us reject any answer that
// maps to a private/loopback address before a TCP socket is opened, closing
// the DNS rebinding gap that a hostname-only check leaves open.
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

const safeLookup = (
  hostname: string,
  options: unknown,
  callback: LookupCallback
): void => {
  const wantsAll =
    typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;

  dnsLookup(hostname, { all: true, verbatim: true, family: 0 }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }

    const list = Array.isArray(addresses) ? addresses : [];
    const safe = list.filter((entry) => !isPrivateAddress(entry.address));

    if (safe.length === 0) {
      // FeedError already carries `.code = 'PRIVATE_HOST'` from its constructor,
      // which satisfies `NodeJS.ErrnoException`'s `.code` expectation at runtime.
      const reason = new FeedError(
        'PRIVATE_HOST',
        `Refusing to connect to private address for ${hostname}.`
      ) as unknown as NodeJS.ErrnoException;
      callback(reason);
      return;
    }

    if (wantsAll) {
      callback(null, safe);
      return;
    }

    const chosen = safe[0]!;
    callback(null, chosen.address, chosen.family);
  });
};

type FetchOutcome = { kind: 'body'; body: string } | { kind: 'redirect'; location: string };

const fetchOnce = (url: URL): Promise<FetchOutcome> => {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const requestModule = url.protocol === 'https:' ? https : http;
    const request = requestModule.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5'
        },
        lookup: safeLookup as unknown as typeof dnsLookup,
        signal: controller.signal
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers['location'];
          response.resume();
          clearTimeout(timeoutId);

          if (!location || typeof location !== 'string') {
            reject(new FeedError('FETCH_FAILED', 'Redirect missing Location header.'));
            return;
          }

          try {
            resolve({ kind: 'redirect', location: new URL(location, url).toString() });
          } catch {
            reject(new FeedError('FETCH_FAILED', 'Invalid redirect Location header.'));
          }
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          clearTimeout(timeoutId);
          reject(new FeedError('FETCH_FAILED', `Feed responded with HTTP ${status}.`));
          return;
        }

        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
          response.resume();
          clearTimeout(timeoutId);
          reject(new FeedError('FEED_TOO_LARGE', 'Feed response exceeded size limit.'));
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;

        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_FEED_BYTES) {
            clearTimeout(timeoutId);
            request.destroy();
            reject(new FeedError('FEED_TOO_LARGE', 'Feed response exceeded size limit.'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          clearTimeout(timeoutId);
          resolve({ kind: 'body', body: Buffer.concat(chunks).toString('utf8') });
        });

        response.on('error', (responseError) => {
          clearTimeout(timeoutId);
          reject(
            new FeedError(
              'FETCH_FAILED',
              responseError.message || 'Feed response stream error.'
            )
          );
        });
      }
    );

    request.on('error', (requestError) => {
      clearTimeout(timeoutId);
      if (controller.signal.aborted) {
        reject(new FeedError('FETCH_TIMEOUT', 'Feed request timed out.'));
        return;
      }
      if (requestError instanceof FeedError) {
        reject(requestError);
        return;
      }
      reject(new FeedError('FETCH_FAILED', requestError.message || 'Feed request failed.'));
    });

    request.end();
  });
};

const fetchFeedXml = async (initialUrl: string): Promise<string> => {
  let currentUrl = initialUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const url = validatePublicHttpUrl(currentUrl);
    const outcome = await fetchOnce(url);
    if (outcome.kind === 'body') return outcome.body;
    currentUrl = outcome.location;
  }

  throw new FeedError('TOO_MANY_REDIRECTS', 'Feed exceeded the redirect limit.');
};

// Outbound fetching is wrapped so we can pin DNS resolution to non-private
// addresses, cap response size, and feed the raw XML into rss-parser without
// surrendering control of the network stack.
const parseFeed = async (url: string): Promise<ParsedFeed> => {
  const body = await fetchFeedXml(url);
  return (await parser.parseString(body)) as ParsedFeed;
};

// Output is plain, sanitizer-safe HTML using only inline tags (`<strong>`,
// `<a>`, `<br>`). We deliberately avoid wrapping in `<p>`: Sharkord replaces a
// link to a tweet/YouTube URL with a block-level embed, and a block element
// inside a `<p>` is invalid HTML (hydration error). Keeping the content inline
// lets such an embed sit as a valid sibling instead. Sharkord still renders its
// own rich link preview (image, title, description) below the message.
const formatArticleMessage = (item: ParsedItem): string => {
  const title = cleanText(item.title || 'Untitled article');
  const link = getSafePublicUrl(item.link);
  const articleDate = formatArticleDate(item);

  const parts: string[] = [`<strong>${escapeHtml(title)}</strong>`];

  const footer: string[] = [];
  if (articleDate) footer.push(escapeHtml(articleDate));
  if (link) {
    footer.push(
      `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Read article</a>`
    );
  }
  if (footer.length > 0) parts.push(footer.join(' · '));

  return parts.join('<br>');
};

// Bootstrap indexing marks existing articles as seen without posting them.
// This prevents an existing feed from flooding a channel when the plugin starts.
const markExisting = (feedUrl: string, items: ParsedItem[]): MarkStats => {
  const seen = seenArticles.get(feedUrl) ?? new Set<string>();
  const stats: MarkStats = {
    indexed: 0,
    ignoredMissingId: 0,
    ignoredDuplicate: 0
  };

  for (const item of items) {
    const id = getArticleId(item);
    if (!id) {
      stats.ignoredMissingId += 1;
      continue;
    }

    if (seen.has(id)) {
      stats.ignoredDuplicate += 1;
      continue;
    }

    rememberSeen(seen, id);
    stats.indexed += 1;
  }

  seenArticles.set(feedUrl, seen);
  return stats;
};

// Normal polling posts unseen entries oldest-first, then marks each article as
// seen immediately so a later failure cannot duplicate already-sent messages.
const postNewItems = async (
  ctx: PluginContext,
  status: FeedStatus,
  items: ParsedItem[]
): Promise<PostStats> => {
  const seen = seenArticles.get(status.url) ?? new Set<string>();
  const stats: PostStats = {
    posted: 0,
    ignoredSeen: 0,
    ignoredMissingId: 0
  };

  for (const item of [...items].reverse()) {
    const id = getArticleId(item);
    if (!id) {
      stats.ignoredMissingId += 1;
      continue;
    }

    if (seen.has(id)) {
      stats.ignoredSeen += 1;
      continue;
    }

    rememberSeen(seen, id);
    await ctx.messages.send(status.channelId, formatArticleMessage(item));
    stats.posted += 1;
    await sleep(SEND_DELAY_MS);
  }

  seenArticles.set(status.url, seen);
  return stats;
};

// Optional bootstrap posting is deliberately capped to keep first setup safe.
const postBootstrapItems = async (
  ctx: PluginContext,
  status: FeedStatus,
  items: ParsedItem[]
): Promise<PostStats> => {
  return postNewItems(ctx, status, items.slice(0, BOOTSTRAP_POST_LIMIT));
};

// Polling is shared by the scheduler and by bootstrapping. It logs counts for
// parsed, posted, skipped, and invalid articles.
const pollFeed = async (
  ctx: PluginContext,
  feedUrl: string,
  bootstrap: boolean
): Promise<number> => {
  const status = statuses.get(feedUrl);
  if (!status) throw new FeedError('FEED_NOT_FOUND', 'Feed not found.');

  try {
    ctx.debug(`RSS feed ${bootstrap ? 'bootstrap' : 'poll'} started: ${feedUrl}`);
    const parsed = await parseFeed(status.url);
    const items = parsed.items ?? [];
    let posted = 0;

    if (bootstrap) {
      // Bootstrap posting is one-shot: once a feed has been bootstrapped, a
      // plugin reload only re-indexes silently rather than re-posting the
      // initial articles a second time.
      const shouldPostBootstrap =
        status.postOnBootstrap === true && status.bootstrappedAt === undefined;
      const postStats = shouldPostBootstrap
        ? await postBootstrapItems(ctx, status, items)
        : { posted: 0, ignoredSeen: 0, ignoredMissingId: 0 };
      const stats = markExisting(status.url, items);
      posted = postStats.posted;
      if (status.bootstrappedAt === undefined) {
        status.bootstrappedAt = Date.now();
        persistFeeds();
      }
      ctx.debug(
        `RSS feed bootstrap completed: ${feedUrl} parsed=${items.length} posted=${postStats.posted} bootstrapLimit=${BOOTSTRAP_POST_LIMIT} indexed=${stats.indexed} ignoredAlreadySeen=${postStats.ignoredSeen} ignoredMissingId=${stats.ignoredMissingId} ignoredDuplicate=${stats.ignoredDuplicate} postedOnBootstrap=${shouldPostBootstrap}`
      );
    } else {
      const stats = await postNewItems(ctx, status, items);
      posted = stats.posted;
      ctx.debug(
        `RSS feed poll completed: ${feedUrl} parsed=${items.length} posted=${stats.posted} ignoredAlreadySeen=${stats.ignoredSeen} ignoredMissingId=${stats.ignoredMissingId}`
      );
    }

    status.lastPolledAt = Date.now();
    status.errorCount = 0;
    status.articlesPosted += posted;
    scheduleNextNormalPoll(status);

    return posted;
  } catch (error) {
    status.errorCount += 1;
    scheduleNextBackoffPoll(status);
    ctx.error(`RSS feed poll failed: ${feedUrl}`, {
      feedUrl,
      error: error instanceof Error ? error.message : String(error),
      errorCount: status.errorCount,
      backoffDelayMinutes: status.backoffDelayMinutes,
      backoffUntil: status.backoffUntil
    });
    return 0;
  }
};

// The scheduler runs once per minute and checks per-feed nextPollAt values.
// `polling` prevents overlapping ticks when a slow feed is still being parsed,
// and `runSerialized` queues this work behind any in-flight settings sync so
// the event handler and the scheduler never mutate runtime maps concurrently.
const pollDueFeeds = async (ctx: PluginContext): Promise<void> => {
  if (polling) return;
  polling = true;

  try {
    await runSerialized(async () => {
      await syncFeedsFromSettings(ctx);
      const now = Date.now();
      for (const feed of statuses.values()) {
        if ((feed.nextPollAt ?? 0) <= now) {
          await pollFeed(ctx, feed.url, false);
        }
      }
    });
  } finally {
    polling = false;
  }
};

// Verify a configured channel still exists and is a text channel. Checking this
// at sync time surfaces a feed pointing at a missing/non-text channel immediately
// instead of failing silently until an article is posted.
const isTextChannel = async (ctx: PluginContext, channelId: number): Promise<boolean> => {
  try {
    const channel = (await ctx.data.getChannel(channelId)) as { type?: string } | undefined;
    return channel?.type === 'TEXT';
  } catch {
    return false;
  }
};

// The admin-only plugin settings dialog writes the whole feed list at once;
// syncing keeps the runtime maps aligned with that persisted source of truth.
// `rawOverride` lets callers pass the fresh value straight from a `setting:set`
// event payload, bypassing `settingsRef.get(...)` which can briefly return a
// stale value while the event is being dispatched (this caused newly-added
// feeds to not bootstrap until the next scheduler tick).
const syncFeedsFromSettings = async (
  ctx: PluginContext,
  rawOverride?: unknown
): Promise<void> => {
  if (!settingsRef) return;

  const raw = rawOverride !== undefined ? rawOverride : settingsRef.get(FEEDS_SETTING);

  // Scheduler-driven syncs (no override) early-return when the raw blob is
  // unchanged, so `parseStoredFeeds` only logs an admin error once per typo
  // instead of once every POLL_TICK_MS. Event-driven syncs always proceed
  // because the admin just saved and expects fresh log output.
  const rawSig = computeRawSettingsSignature(raw);
  if (rawOverride === undefined && rawSig === rawSnapshot) return;
  rawSnapshot = rawSig;

  const configs = parseStoredFeeds(raw, ctx);
  const snapshot = JSON.stringify(configs);
  if (snapshot === settingsSnapshot) return;

  ctx.debug(`RSS settings sync started: configuredFeeds=${configs.length}`);
  const nextUrls = new Set(configs.map((feed) => feed.url));

  for (const url of statuses.keys()) {
    if (!nextUrls.has(url)) {
      ctx.debug(`RSS settings sync removed feed: ${url}`);
      statuses.delete(url);
      seenArticles.delete(url);
    }
  }

  // Validate every channel up front in parallel. The mutation/bootstrap loop
  // below stays sequential on purpose (avoid hammering many feeds at once on
  // first sync and avoid concurrent mutations of `statuses`/`seenArticles`).
  const channelValidity = await Promise.all(
    configs.map((config) => isTextChannel(ctx, config.channelId))
  );

  for (let i = 0; i < configs.length; i += 1) {
    const config = configs[i]!;
    if (!channelValidity[i]) {
      ctx.error('RSS feed skipped: target text channel not found', {
        url: config.url,
        channelId: config.channelId
      });
      statuses.delete(config.url);
      seenArticles.delete(config.url);
      continue;
    }

    const existing = statuses.get(config.url);
    const status = createStatus(config, existing);
    statuses.set(config.url, status);

    if (!existing) {
      await pollFeed(ctx, status.url, true);
    } else {
      ctx.debug(
        `RSS settings sync updated feed: ${status.url} intervalMinutes=${status.intervalMinutes} channelId=${status.channelId}`
      );
    }
  }

  settingsSnapshot = snapshot;
  ctx.debug(`RSS settings sync completed: activeFeeds=${statuses.size}`);
};

// React to the feeds setting being saved from the plugin settings dialog.
// We pass `payload.value` straight through so the sync sees the fresh JSON
// even if Sharkord's settings store has not finished committing yet.
const registerSettingsListener = (ctx: PluginContext): void => {
  unsubscribeSettings = ctx.events.on('setting:set', async (payload) => {
    if (payload.key !== FEEDS_SETTING) return;
    if (payload.pluginId && payload.pluginId !== ctx.pluginId) return;

    ctx.debug('RSS settings update event received; syncing feeds now.');
    await runSerialized(() => syncFeedsFromSettings(ctx, payload.value));
  });
};

const onLoad = async (ctx: PluginContext): Promise<void> => {
  ctx.log('Sharkord RSS plugin loaded');

  settingsRef = await ctx.settings.register([
    {
      key: FEEDS_SETTING,
      name: 'RSS feeds (JSON)',
      description:
        'A JSON array of feeds. Each entry: {"url": string, "channelId": number, "intervalMinutes"?: number, "postOnBootstrap"?: boolean}. ' +
        'Example: [{"url":"https://hnrss.org/frontpage","channelId":2,"intervalMinutes":15,"postOnBootstrap":false}]. ' +
        'channelId is the numeric ID of a text channel. Only public http(s) feed URLs are accepted; invalid rows are ignored.',
      type: 'string',
      defaultValue: '[]'
    }
  ] as const);

  await syncFeedsFromSettings(ctx);
  registerSettingsListener(ctx);
  intervalId = setInterval(() => {
    pollDueFeeds(ctx).catch((error) => ctx.error('RSS polling loop failed', error));
  }, POLL_TICK_MS);
};

// Unload must release timers and listeners because Sharkord can disable or
// reload plugins without restarting the whole server process.
const onUnload = (ctx: PluginContext): void => {
  if (intervalId) clearInterval(intervalId);
  unsubscribeSettings?.();
  unsubscribeSettings = undefined;
  intervalId = undefined;
  polling = false;
  settingsSnapshot = '';
  rawSnapshot = '';
  statuses.clear();
  seenArticles.clear();
  settingsRef = undefined;
  ctx.log('Sharkord RSS plugin unloaded');
};

// Internal helpers are also exported so the test suite (`index.test.ts`) can
// exercise them directly. The plugin runtime only consumes `onLoad`/`onUnload`,
// and the bundler tree-shakes the rest out of the production bundle.
export {
  cleanText,
  computeRawSettingsSignature,
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
  onLoad,
  onUnload,
  parseStoredFeeds,
  rememberSeen,
  stripHtml,
  validatePublicHttpUrl
};
