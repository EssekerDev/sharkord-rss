import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '../shared/types';
import type { TFeedView, TSaveFeed } from '../types';
import { callAction, useStoreSelector } from './sdk';

const emptyDraft = (): TSaveFeed => ({
  url: '',
  channelId: 0,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  postOnBootstrap: false
});

const feedHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const cardStyle: CSSProperties = {
  background: 'var(--card, var(--background))',
  color: 'var(--card-foreground, var(--foreground))',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 8px)',
  padding: '16px'
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 600,
  marginBottom: '6px'
};

const hintStyle: CSSProperties = {
  display: 'block',
  color: 'var(--muted-foreground)',
  fontSize: '12px',
  marginTop: '6px'
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--background)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 8px)',
  padding: '8px 10px',
  fontSize: '14px'
};

const primaryButtonStyle: CSSProperties = {
  background: 'var(--primary)',
  color: 'var(--primary-foreground)',
  border: 'none',
  borderRadius: 'var(--radius, 8px)',
  padding: '8px 14px',
  fontSize: '14px',
  cursor: 'pointer'
};

const outlineButtonStyle: CSSProperties = {
  background: 'transparent',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 8px)',
  padding: '8px 14px',
  fontSize: '14px',
  cursor: 'pointer'
};

const Feeds = memo(() => {
  const channels = useStoreSelector((state) => state.channels);

  const [feeds, setFeeds] = useState<TFeedView[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | undefined>();
  const [draft, setDraft] = useState<TSaveFeed>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const textChannels = useMemo(
    () => channels.filter((channel) => channel.type === 'TEXT'),
    [channels]
  );

  const isNew = selectedUrl === '';
  const selected = feeds.find((feed) => feed.url === selectedUrl);

  const run = useCallback(async (work: () => Promise<TFeedView[]>) => {
    setBusy(true);
    setError('');

    try {
      const list = await work();
      setFeeds(list);
      return list;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    run(() => callAction('list', {})).finally(() => setLoading(false));
  }, [run]);

  const edit = useCallback((feed: TFeedView | undefined) => {
    setSelectedUrl(feed?.url ?? '');
    setDraft(
      feed
        ? {
            url: feed.url,
            channelId: feed.channelId,
            intervalMinutes: feed.intervalMinutes,
            postOnBootstrap: feed.postOnBootstrap === true
          }
        : emptyDraft()
    );
    setError('');
  }, []);

  const onSave = useCallback(async () => {
    const payload: TSaveFeed = {
      url: draft.url,
      channelId: draft.channelId,
      intervalMinutes: draft.intervalMinutes,
      postOnBootstrap: draft.postOnBootstrap === true
    };

    const list = await run(() =>
      selected
        ? callAction('update', { ...payload, previousUrl: selected.url })
        : callAction('create', payload)
    );

    if (!list) return;

    const saved = list.find((feed) => feed.url === payload.url.trim());
    if (saved) edit(saved);
  }, [draft, edit, run, selected]);

  const onDelete = useCallback(async () => {
    if (!selected || !confirm(`Stop following ${selected.url}?`)) return;

    if (await run(() => callAction('remove', { url: selected.url }))) {
      setSelectedUrl(undefined);
    }
  }, [run, selected]);

  const channelName = useCallback(
    (id: number) =>
      textChannels.find((channel) => channel.id === id)?.name ?? `channel ${id}`,
    [textChannels]
  );

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '24px',
        alignItems: 'flex-start'
      }}
    >
      <div style={{ width: '100%', maxWidth: '288px', flexShrink: 0 }}>
        <div style={{ ...cardStyle, padding: '8px' }}>
          {loading ? (
            <p style={{ ...hintStyle, textAlign: 'center', padding: '16px' }}>Loading…</p>
          ) : feeds.length ? (
            feeds.map((feed) => {
              const active = feed.url === selectedUrl;
              return (
                <button
                  key={feed.url}
                  type="button"
                  onClick={() => edit(feed)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active
                      ? 'var(--accent-foreground, var(--foreground))'
                      : 'var(--foreground)',
                    border: 'none',
                    borderRadius: 'var(--radius, 8px)',
                    padding: '8px 12px',
                    cursor: 'pointer'
                  }}
                >
                  <span style={{ display: 'block', fontSize: '14px', fontWeight: 600 }}>
                    {feedHost(feed.url)}
                  </span>
                  <span style={{ display: 'block', fontSize: '12px', color: 'var(--muted-foreground)' }}>
                    #{channelName(feed.channelId)} · every {feed.intervalMinutes} min
                    {feed.errorCount > 0 ? ` · ${feed.errorCount} error(s)` : ''}
                  </span>
                </button>
              );
            })
          ) : (
            <p style={{ ...hintStyle, textAlign: 'center', padding: '16px' }}>No feeds yet.</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => edit(undefined)}
          style={{ ...outlineButtonStyle, width: '100%', marginTop: '8px' }}
        >
          New feed
        </button>
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        {selected || isNew ? (
          <div style={cardStyle}>
            <h2 style={{ margin: '0 0 4px', fontSize: '18px' }}>
              {selected ? 'Edit feed' : 'New feed'}
            </h2>
            <p style={{ margin: '0 0 20px', color: 'var(--muted-foreground)', fontSize: '13px' }}>
              New articles are posted to the text channel you pick. Existing articles
              are not re-posted after the first import.
            </p>

            {error ? (
              <p
                role="alert"
                style={{
                  color: 'var(--destructive, #ef4444)',
                  fontSize: '13px',
                  marginBottom: '16px'
                }}
              >
                {error}
              </p>
            ) : null}

            <label style={labelStyle} htmlFor="rss-url">
              Feed URL
            </label>
            <input
              id="rss-url"
              value={draft.url}
              placeholder="https://hnrss.org/frontpage"
              onChange={(event) =>
                setDraft((current) => ({ ...current, url: event.target.value }))
              }
              style={inputStyle}
            />
            <span style={{ ...hintStyle, marginBottom: '16px' }}>
              Public http(s) RSS or Atom URL. Private and loopback hosts are refused.
            </span>

            <label style={labelStyle} htmlFor="rss-channel">
              Channel
            </label>
            <select
              id="rss-channel"
              value={draft.channelId ? String(draft.channelId) : ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  channelId: Number(event.target.value)
                }))
              }
              style={inputStyle}
            >
              <option value="">Pick a text channel…</option>
              {textChannels.map((channel) => (
                <option key={channel.id} value={String(channel.id)}>
                  #{channel.name}
                </option>
              ))}
            </select>

            <div style={{ height: '16px' }} />

            <label style={labelStyle} htmlFor="rss-interval">
              Poll interval (minutes)
            </label>
            <input
              id="rss-interval"
              type="number"
              min={MIN_INTERVAL_MINUTES}
              value={draft.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  intervalMinutes: Number(event.target.value)
                }))
              }
              style={inputStyle}
            />
            <span style={{ ...hintStyle, marginBottom: '16px' }}>
              Minimum {MIN_INTERVAL_MINUTES} minute. Defaults to {DEFAULT_INTERVAL_MINUTES}.
            </span>

            <label
              htmlFor="rss-bootstrap"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px',
                margin: '8px 0 20px'
              }}
            >
              <span>
                <span style={{ display: 'block', fontSize: '13px', fontWeight: 600 }}>
                  Post existing articles on first add
                </span>
                <span style={{ display: 'block', color: 'var(--muted-foreground)', fontSize: '12px' }}>
                  Posts up to 10 current items the first time this feed is added.
                </span>
              </span>
              <input
                id="rss-bootstrap"
                type="checkbox"
                checked={draft.postOnBootstrap === true}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    postOnBootstrap: event.target.checked
                  }))
                }
              />
            </label>

            {selected ? (
              <p style={{ ...hintStyle, marginBottom: '16px' }}>
                Posted {selected.articlesPosted} article
                {selected.articlesPosted === 1 ? '' : 's'}
                {selected.lastPolledAt
                  ? ` · last poll ${new Date(selected.lastPolledAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
                  : ' · not polled yet'}
                {selected.backoffUntil
                  ? ` · backing off until ${new Date(selected.backoffUntil).toISOString().slice(0, 16).replace('T', ' ')} UTC`
                  : ''}
              </p>
            ) : null}

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '8px',
                flexWrap: 'wrap'
              }}
            >
              {selected ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDelete}
                  style={{
                    ...outlineButtonStyle,
                    color: 'var(--destructive, #ef4444)',
                    borderColor: 'var(--destructive, #ef4444)'
                  }}
                >
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSelectedUrl(undefined)}
                  style={outlineButtonStyle}
                >
                  Cancel
                </button>
                <button type="button" disabled={busy} onClick={onSave} style={primaryButtonStyle}>
                  {busy ? 'Saving…' : selected ? 'Save changes' : 'Add feed'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={cardStyle}>
            <p style={{ ...hintStyle, textAlign: 'center', padding: '48px 16px' }}>
              {feeds.length
                ? 'Pick a feed to edit it, or add another one.'
                : 'Add a feed to start posting new articles into a text channel.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
});

export { Feeds };
