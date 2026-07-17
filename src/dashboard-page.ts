/** Static HTML for the mission-control dashboard, served by dashboard.ts. */

export const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NewsTeam — Mission Control</title>
<link rel="icon" type="image/svg+xml" href="/favicon.ico">
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
    --event-line-border: #1c2128;
    --pill-blue-bg: #1f6feb33; --pill-green-bg: #23883433; --pill-red-bg: #f8514933;
  }
  [data-theme="light"] {
    --bg: #f6f8fa; --surface: #ffffff; --border: #d0d7de;
    --text: #1f2328; --muted: #656d76; --accent: #0969da;
    --green: #1a7f37; --yellow: #9a6700; --red: #cf222e;
    --event-line-border: #d8dee4;
    --pill-blue-bg: #ddf4ff; --pill-green-bg: #dafbe1; --pill-red-bg: #ffebe9;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    font-size: 13px; background: var(--bg); color: var(--text);
    padding: 20px; line-height: 1.5;
  }
  h1 { font-size: 16px; color: var(--accent); margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 11px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px;
  }
  .card h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--muted); margin-bottom: 10px; border-bottom: 1px solid var(--border);
    padding-bottom: 6px;
  }
  .stat-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .stat-label { color: var(--muted); }
  .stat-value { color: var(--text); font-weight: 600; }
  .stat-value.green { color: var(--green); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.red { color: var(--red); }
  .full-width { grid-column: 1 / -1; }
  .agent-section { margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .agent-section:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .agent-name { color: var(--accent); font-weight: 600; font-size: 12px; margin-bottom: 4px; }
  .feed-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .feed-table th {
    text-align: left; color: var(--muted); font-weight: normal;
    padding: 4px 8px; border-bottom: 1px solid var(--border);
  }
  .feed-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .feed-table tr:last-child td { border-bottom: none; }
  .feed-table th.num, .feed-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .event-log {
    max-height: 360px; overflow-y: auto; font-size: 11px;
    background: var(--bg); border-radius: 4px; padding: 8px;
  }
  .event-line { padding: 2px 0; border-bottom: 1px solid var(--event-line-border); display: flex; gap: 8px; }
  .event-time { color: var(--muted); white-space: nowrap; flex-shrink: 0; min-width: 140px; }
  .event-name { color: var(--accent); white-space: nowrap; flex-shrink: 0; min-width: 140px; }
  .event-data { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .pill {
    display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px;
    background: var(--pill-blue-bg); color: var(--accent);
  }
  .pill.on { background: var(--pill-green-bg); color: var(--green); }
  .pill.off { background: var(--pill-red-bg); color: var(--red); }
  .refresh-note { color: var(--muted); font-size: 10px; text-align: right; margin-top: 8px; }
  .theme-toggle {
    position: fixed; top: 16px; right: 16px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px;
    color: var(--muted); font-family: inherit; font-size: 12px; cursor: pointer;
  }
  .theme-toggle:hover { color: var(--accent); border-color: var(--accent); }
  .chat-link {
    position: fixed; top: 16px; right: 72px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px;
    color: var(--muted); font-family: inherit; font-size: 12px; text-decoration: none;
  }
  .chat-link:hover { color: var(--accent); border-color: var(--accent); }
  @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<!--LOCAL_CHAT_LINK-->
<button class="theme-toggle" id="theme-toggle" title="Toggle light/dark mode"></button>
<h1>NewsTeam — Mission Control</h1>
<div class="subtitle">localhost dashboard — auto-refreshes every 30s</div>

<div class="grid">
  <div class="card full-width" id="status-card">
    <h2>Status</h2>
    <div id="status-body">Loading...</div>
  </div>
  <div class="card full-width" id="feeds-card">
    <h2>Feeds</h2>
    <div id="feeds-body">Loading...</div>
  </div>
  <div class="card full-width" id="events-card">
    <h2>Event Log <span class="pill" id="event-count"></span></h2>
    <div class="event-log" id="events-body">Loading...</div>
  </div>
</div>

<div class="refresh-note">Last refresh: <span id="last-refresh">—</span></div>

<script>
const $ = (id) => document.getElementById(id);

function esc(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function statRow(label, value, cls) {
  return '<div class="stat-row"><span class="stat-label">' + esc(label) +
    '</span><span class="stat-value ' + (cls||'') + '">' + value + '</span></div>';
}

function costColor(pct) {
  if (pct > 80) return 'red';
  if (pct > 50) return 'yellow';
  return 'green';
}

function fmt$(cents) { return '$' + (cents / 100).toFixed(3); }
function fmtN(n) { return new Intl.NumberFormat('en-US').format(n); }

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

function timeAgo(isoStr) {
  if (!isoStr) return '\\u2014';
  const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (diff < 60) return Math.floor(diff) + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function formatEventTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ts; }
}

function summarizeData(data) {
  if (!data || typeof data !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const s = (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\\t\\n\\r]+/g, ' ').trim();
    parts.push(k + '=' + (s.length > 40 ? s.slice(0, 40) + '\\u2026' : s));
  }
  return parts.join(' \\u00b7 ');
}

async function refresh() {
  try {
    const [status, cost, feeds, events] = await Promise.all([
      fetchJson('/api/status'),
      fetchJson('/api/cost'),
      fetchJson('/api/feeds'),
      fetchJson('/api/events?n=80'),
    ]);

    // Status card — per-agent
    let statusHtml = '<div class="agent-section">' +
      statRow('Uptime', esc(status.uptime)) +
      statRow('Started', esc(new Date(status.started_at).toLocaleString())) +
      statRow('Memory', esc(status.memory_mb) + ' MB') +
      statRow('Agents', esc(status.agent_count)) +
      statRow('Default chat model', status.default_chat_model_label ? esc(status.default_chat_model_label) : '\\u2014') +
      (status.default_digest_model_label
        ? statRow('Default digest model', esc(status.default_digest_model_label))
        : '') +
      '</div>';

    for (const a of status.agents) {
      const sessPct = a.session.max_session_cost_cents > 0
        ? (a.session.cost_cents / a.session.max_session_cost_cents) * 100 : 0;
      statusHtml += '<div class="agent-section">' +
        '<div class="agent-name">' + esc(a.id) + '</div>' +
        statRow('Channels', esc(a.channels)) +
        statRow('Chat model', esc(a.chat_model_label || '\\u2014')) +
        statRow('Digest model', esc(a.digest_model_label || '\\u2014')) +
        statRow('Turns', esc(fmtN(a.session.turns))) +
        statRow('Tokens', esc(fmtN(a.session.input_tokens)) + ' in / ' + esc(fmtN(a.session.output_tokens)) + ' out') +
        statRow('Session cost', esc(fmt$(a.session.cost_cents)) + ' / ' + esc(fmt$(a.session.max_session_cost_cents)),
          costColor(sessPct)) +
        statRow('Feeds', a.feeds_enabled
          ? '<span class="pill on">enabled</span>'
          : '<span class="pill off">disabled</span>') +
        '</div>';
    }
    // Cost section (appended to status card)
    const monthPct = cost.monthly_budget_cents
      ? (cost.month.cost_cents / cost.monthly_budget_cents) * 100 : 0;
    statusHtml += '<div class="agent-section">' +
      '<div class="agent-name">Cost Ledger</div>' +
      statRow('Today', esc(fmt$(cost.today.cost_cents)) + ' (' + esc(cost.today.turns) + ' turns)') +
      statRow('Month', esc(fmt$(cost.month.cost_cents)) + ' (' + esc(cost.month.turns) + ' turns, ' + esc(cost.month.days) + 'd)') +
      (cost.monthly_budget_cents
        ? statRow('Budget', esc(fmt$(cost.month.cost_cents)) + ' / ' + esc(fmt$(cost.monthly_budget_cents)) +
            ' (' + esc(monthPct.toFixed(1)) + '%)', costColor(monthPct))
        : '') +
      '</div>';

    $('status-body').innerHTML = statusHtml;

    // Feeds card — per-agent
    let feedsHtml = '';
    if (!feeds.agents || feeds.agents.length === 0) {
      feedsHtml = '<span style="color:var(--muted)">No feeds configured</span>';
    } else {
      for (const af of feeds.agents) {
        feedsHtml += '<div class="agent-section"><div class="agent-name">' + esc(af.agent_id) + '</div>';
        if (af.feeds.length === 0) {
          feedsHtml += '<span style="color:var(--muted)">No feeds</span>';
        } else {
          const state = af.state || {};
          feedsHtml += '<table class="feed-table"><tr><th>Feed</th><th>Type</th><th>Interval</th><th>Last Check</th><th class="num">Pending</th><th>Oldest Pending</th></tr>';
          for (const f of af.feeds) {
            const fState = state[f.id] || {};
            feedsHtml += '<tr><td>' + esc(f.name || f.id) + '</td><td>' + esc(f.type || '\\u2014') +
              '</td><td>' + esc(f.check_interval_minutes || '\\u2014') + 'm</td><td>' +
              esc(timeAgo(fState.last_check)) + '</td><td class="num">' +
              esc(fmtN(f.pending_count || 0)) + '</td><td>' +
              esc(timeAgo(f.oldest_pending_published)) + '</td></tr>';
          }
          feedsHtml += '</table>';
        }
        feedsHtml += '<div style="margin-top:8px">' +
          statRow('Pending items', '<strong>' + esc(af.pending_count) + '</strong>') +
          statRow('Oldest pending', esc(timeAgo(af.oldest_pending_published))) +
          statRow('Max queue age', esc(af.max_queue_age_hours) + 'h') +
          statRow('Max content age', af.max_content_age_hours ? esc(af.max_content_age_hours) + 'h' : '\\u2014') +
          statRow('Digest times', af.digest_times.length ? esc(af.digest_times.join(', ')) + ' PT' : '\\u2014') +
          statRow('Waking hours', esc(af.waking_hours) || '\\u2014') +
          '</div></div>';
      }
    }
    $('feeds-body').innerHTML = feedsHtml;

    // Events card
    $('event-count').textContent = events.count + ' events';
    if (events.events.length === 0) {
      $('events-body').innerHTML = '<span style="color:var(--muted)">No events today</span>';
    } else {
      const reversed = [...events.events].reverse();
      $('events-body').innerHTML = reversed.map(e =>
        '<div class="event-line">' +
        '<span class="event-time">' + esc(formatEventTime(e.ts)) + '</span>' +
        '<span class="event-name">' + esc(e.event || '') + '</span>' +
        '<span class="event-data">' + esc(summarizeData(e.data)) + '</span>' +
        '</div>'
      ).join('');
    }

    $('last-refresh').textContent = new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Dashboard refresh failed:', err);
  }
}

// Theme toggle
(function() {
  const saved = localStorage.getItem('newsteam-theme');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  function updateLabel() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    $('theme-toggle').textContent = isLight ? '\\u263e dark' : '\\u2600 light';
  }
  $('theme-toggle').addEventListener('click', function() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('newsteam-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('newsteam-theme', 'light');
    }
    updateLabel();
  });
  updateLabel();
})();

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
