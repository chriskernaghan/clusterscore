/* ========================================================================
   Clusterscore — client-side app logic
   Internal link audits for any CMS, all in the browser.
   ======================================================================== */

// Hardcoded proxy URL — users never see or configure this.
// Update this constant when the Worker URL changes.
const PROXY_URL = 'https://lucky-shape-acff.chris-cf7.workers.dev';

// ============================================================================
// WAF (We Are Founders) integration
// ----------------------------------------------------------------------------
// Clusterscore is built by We Are Founders. After an audit completes, we
// surface a newsletter signup and a few recommended articles.
//
// To update the article recommendations, edit WAF_ARTICLES below. Keep the
// list at 3 entries — the layout assumes a 3-column grid (stacks on mobile).
// ============================================================================

const WAF_SITE = 'https://wearefounders.uk';
const WAF_SIGNUP_ENDPOINT = WAF_SITE + '/members/api/send-magic-link';

const WAF_ARTICLES = [
  {
    title: 'Cursor AI: the editor changing how founders ship',
    description: 'A practical look at why so many indie hackers have switched their entire workflow over to Cursor.',
    url: 'https://wearefounders.uk/cursor/',
  },
  {
    title: 'Lindy AI review: is it worth it for solo founders?',
    description: 'An honest assessment of Lindy\'s AI-agent platform for one-person businesses.',
    url: 'https://wearefounders.uk/lindy-ai-review-2026-is-it-worth-it-for-solo-founders/',
  },
  {
    // PLACEHOLDER — swap with a real WAF article URL before deploying
    title: 'How to fix internal linking on your site',
    description: 'A practical playbook for boosting orphan pages and strengthening topic clusters.',
    url: 'https://wearefounders.uk/',
  },
];

// Anonymous event tracking. Fire-and-forget; never blocks the UI.
// Only sends an event name, nothing else. No IP, no fingerprint, no metadata.
function track(eventName) {
  try {
    // Use sendBeacon if available (survives page unloads), else background fetch
    const url = PROXY_URL.replace(/\/+$/, '') + '/event?name=' + encodeURIComponent(eventName);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url);
    } else {
      fetch(url, { method: 'GET', keepalive: true, mode: 'no-cors' }).catch(() => {});
    }
  } catch (e) {
    // Tracking must never break the app
  }
}

const STORAGE_KEYS = {
  config: 'cs_config',
  clusters: 'cs_clusters',
  snapshots: 'cs_snapshots',
  currentAudit: 'cs_current_audit',
  // Boolean-ish flag: '1' once the browser has completed an audit.
  // Used to fire repeat_visit / repeat_audit events for return-user analytics.
  hasAudited: 'cs_has_audited',
};
const MAX_SNAPSHOTS = 10;

const DEFAULT_CLUSTERS = [
  { name: 'Cursor', keywords: ['cursor'] },
  { name: 'Lindy', keywords: ['lindy'] },
  { name: 'Turbotic', keywords: ['turbotic'] },
  { name: 'Hypefury', keywords: ['hypefury'] },
  { name: 'Replit', keywords: ['replit'] },
  { name: 'Claude', keywords: ['claude'] },
  { name: 'AI Coding', keywords: ['ai-coding', 'ai code', 'code editor', 'copilot', 'windsurf'] },
  { name: 'Pricing', keywords: ['pricing'] },
];

// ---------- State ----------

const state = {
  config: {
    source: 'autodetect', // 'autodetect' | 'wordpress' | 'webflow' | 'ghost' | 'sitemap'
    siteUrl: '',           // domain entered for autodetect, wordpress, webflow
    apiKey: '',            // Ghost only
    ghostUrl: '',          // Ghost site URL
    sitemapUrl: '',        // manual sitemap mode
    includePatterns: '',
    excludePatterns: '',
    // Cached discovery result (so we can run the audit after confirming)
    resolvedSitemapUrl: '',
  },
  clusters: [...DEFAULT_CLUSTERS],
  snapshots: [],
  audit: null,
  sort: { key: 'inbound', dir: 'asc' },
  filter: 'all',
  graphFocus: null,
  search: '',
  expanded: new Set(),
};

// ---------- Storage ----------

function loadFromStorage() {
  try {
    const cfg = localStorage.getItem(STORAGE_KEYS.config);
    if (cfg) {
      const loaded = JSON.parse(cfg);
      state.config = {
        source: 'autodetect',
        siteUrl: '',
        apiKey: '',
        ghostUrl: '',
        sitemapUrl: '',
        includePatterns: '',
        excludePatterns: '',
        resolvedSitemapUrl: '',
        ...loaded,
      };
      // Backwards-compat: migrate old configs where siteUrl meant ghostUrl
      if (state.config.source === 'ghost' && !state.config.ghostUrl && state.config.siteUrl) {
        state.config.ghostUrl = state.config.siteUrl;
      }
    }

    const cls = localStorage.getItem(STORAGE_KEYS.clusters);
    if (cls) {
      state.clusters = JSON.parse(cls);
      // Any cluster loaded with keywords that differ from its auto-derived value
      // is treated as user-customised, so editing the name won't overwrite them.
      for (const c of state.clusters) {
        const derived = (c.name || '').trim().toLowerCase();
        const current = (c.keywords || []).join(', ');
        if (current && current !== derived) {
          c._keywordsTouched = true;
        }
      }
    }

    const snaps = localStorage.getItem(STORAGE_KEYS.snapshots);
    if (snaps) state.snapshots = JSON.parse(snaps);

    const audit = localStorage.getItem(STORAGE_KEYS.currentAudit);
    if (audit) state.audit = JSON.parse(audit);
  } catch (e) {
    console.warn('Storage load failed', e);
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(state.config));
}
function saveClusters() {
  // Strip internal-only flags (prefixed with _) before persisting
  const clean = state.clusters.map(({ name, keywords }) => ({ name, keywords }));
  localStorage.setItem(STORAGE_KEYS.clusters, JSON.stringify(clean));
}
function saveSnapshots() {
  localStorage.setItem(STORAGE_KEYS.snapshots, JSON.stringify(state.snapshots));
}
function saveAudit() {
  if (state.audit) {
    localStorage.setItem(STORAGE_KEYS.currentAudit, JSON.stringify(state.audit));
  }
}

// ---------- Toast ----------

function toast(message, type = '') {
  const container = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 200ms';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 220);
  }, 3500);
}

// ---------- Ghost API ----------

async function fetchAllPosts(siteUrl, apiKey, onProgress) {
  const url = siteUrl.replace(/\/+$/, '');
  const out = [];
  for (const resource of ['posts', 'pages']) {
    let page = 1;
    while (true) {
      const endpoint =
        `${url}/ghost/api/content/${resource}/` +
        `?key=${encodeURIComponent(apiKey)}&limit=100&page=${page}` +
        `&fields=id,title,slug,url,html,updated_at,published_at`;
      // Always route Ghost through the proxy so CORS works regardless of how
      // the user's Ghost is configured behind Cloudflare.
      const fetchUrl = PROXY_URL.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(endpoint);
      const resp = await fetch(fetchUrl, { headers: { Accept: 'application/json' } });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Ghost API returned ${resp.status} ${resp.statusText}. ${text.slice(0, 200)}`);
      }
      const data = await resp.json();
      const batch = data[resource] || [];
      for (const item of batch) {
        item._resource = resource;
        out.push(item);
      }
      onProgress?.(`Fetched ${out.length} ${resource}...`);
      const pages = data.meta?.pagination?.pages || 1;
      if (page >= pages) break;
      page++;
    }
  }
  return out;
}

// ---------- Sitemap source ----------

// Default URL patterns to skip in sitemap mode. These are obvious non-content URLs
// that appear in sitemaps on most CMSs (tag archives, author pages, paginated
// archives, sitemap indexes themselves, feeds, etc.).
const DEFAULT_EXCLUDE_PATTERNS = [
  '/tag/', '/tags/', '/category/', '/categories/',
  '/author/', '/authors/', '/page/',
  '/wp-admin/', '/wp-content/', '/wp-includes/',
  '/feed/', '/feed.xml', '/rss', '/atom.xml',
  '/sitemap', '/robots.txt', '/.well-known/',
  '/login', '/signup', '/account', '/checkout', '/cart',
];

function shouldIncludeUrl(url, config) {
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  if (!path || path === '/') return false; // homepage is rarely useful in this audit

  // Built-in defaults
  for (const pat of DEFAULT_EXCLUDE_PATTERNS) {
    if (path.toLowerCase().includes(pat)) return false;
  }
  // User excludes (comma-separated substrings)
  const userExcludes = (config.excludePatterns || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const pat of userExcludes) {
    if (path.toLowerCase().includes(pat.toLowerCase())) return false;
  }
  // User includes — if set, URL must match at least one
  const userIncludes = (config.includePatterns || '').split(',').map(s => s.trim()).filter(Boolean);
  if (userIncludes.length) {
    if (!userIncludes.some(pat => path.toLowerCase().includes(pat.toLowerCase()))) return false;
  }
  return true;
}

function proxiedFetch(proxyUrl, target) {
  const u = proxyUrl.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(target);
  return fetch(u);
}

async function fetchSitemapUrls(sitemapUrl, proxyUrl, onProgress) {
  // Recursively handles sitemap indexes (sitemap of sitemaps) and regular urlsets
  const allUrls = new Set();
  const queue = [sitemapUrl];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    onProgress?.(`Fetching sitemap: ${shortUrl(current)}`);
    const resp = await proxiedFetch(proxyUrl, current);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Sitemap fetch failed (${resp.status}): ${errText.slice(0, 150)}`);
    }
    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Sitemap XML parse error. Is the URL really a sitemap?');
    }

    // Sitemap index? -> collect nested sitemaps
    const nestedSitemaps = doc.querySelectorAll('sitemap > loc');
    if (nestedSitemaps.length) {
      nestedSitemaps.forEach(loc => {
        const u = loc.textContent.trim();
        if (u && !visited.has(u)) queue.push(u);
      });
      continue;
    }

    // Regular urlset -> collect page URLs
    doc.querySelectorAll('url > loc').forEach(loc => {
      const u = loc.textContent.trim();
      if (u) allUrls.add(u);
    });
  }

  return [...allUrls];
}

// Discover and filter the sitemap URL list WITHOUT fetching page HTML. Slugs are
// recoverable from URLs alone, so this is enough to drive cluster suggestions
// before the (potentially long) page fetch begins.
async function resolveSitemapUrls(config, onProgress) {
  if (!config.sitemapUrl) throw new Error('Sitemap URL is required.');
  const allUrls = await fetchSitemapUrls(config.sitemapUrl, PROXY_URL, onProgress);
  const filtered = allUrls.filter(u => shouldIncludeUrl(u, config));
  onProgress?.(`Sitemap returned ${allUrls.length} URLs (${filtered.length} after filtering).`);
  return filtered;
}

// Fetch page HTML for a pre-resolved URL list. Streaming hooks:
//   opts.onPage(post)       — fired as each page resolves (streaming rows in)
//   opts.onThreshold(total) — fired once when `thresholdCount` pages have resolved
//                             (the modal→dashboard handoff point)
async function fetchPagesForUrls(filtered, opts = {}) {
  const { onProgress, onPage, onThreshold, thresholdCount } = opts;
  const CONCURRENCY = 6;
  const posts = [];
  let fetched = 0;
  let failed = 0;
  let thresholdFired = false;

  async function fetchOne(url) {
    let post = null;
    try {
      const resp = await proxiedFetch(PROXY_URL, url);
      if (!resp.ok) { failed++; return null; }
      const html = await resp.text();
      const meta = extractMetaFromHtml(html);
      post = {
        id: url,
        title: meta.title || url,
        slug: extractSlug(url),
        url,
        html,
        _resource: 'sitemap',
      };
      return post;
    } catch (e) {
      failed++;
      return null;
    } finally {
      fetched++;
      if (post) { try { onPage?.(post); } catch (e) {} }
      if (!thresholdFired && thresholdCount && fetched >= thresholdCount) {
        thresholdFired = true;
        try { onThreshold?.(filtered.length); } catch (e) {}
      }
      if (fetched % 5 === 0 || fetched === filtered.length) {
        onProgress?.(`Fetching pages... ${fetched} of ${filtered.length}${failed ? ` (${failed} failed)` : ''}`);
      }
    }
  }

  const queue = filtered.slice();
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
    workers.push((async () => {
      while (queue.length) {
        const next = queue.shift();
        const p = await fetchOne(next);
        if (p) posts.push(p);
      }
    })());
  }
  await Promise.all(workers);

  onProgress?.(`Fetched ${posts.length} pages.`);
  return posts;
}

// Back-compat wrapper: original single-call API (discover + fetch, no streaming).
async function fetchAllFromSitemap(config, onProgress) {
  const filtered = await resolveSitemapUrls(config, onProgress);
  return fetchPagesForUrls(filtered, { onProgress });
}

function extractMetaFromHtml(html) {
  // Tiny pull of <title> and <meta name="description">
  const wrapper = document.createElement('div');
  // Drop scripts/styles before parse so we don't accidentally execute anything
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  wrapper.innerHTML = cleaned;
  const titleEl = wrapper.querySelector('title');
  return { title: titleEl ? titleEl.textContent.trim() : '' };
}

function extractSlug(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path.split('/').pop() || '';
  } catch { return ''; }
}

function shortUrl(u) {
  try {
    const p = new URL(u);
    return p.pathname.length > 40 ? p.pathname.slice(0, 37) + '...' : p.pathname;
  } catch { return u; }
}

// ---------- Link extraction ----------

function extractLinksAndWords(htmlStr) {
  if (!htmlStr) return { links: [], words: 0 };
  // Parse via a detached element so the browser handles malformed HTML
  const wrapper = document.createElement('div');
  wrapper.innerHTML = htmlStr;
  const links = [];
  wrapper.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href) links.push(href);
  });
  const text = wrapper.textContent || '';
  const words = (text.match(/\b\w+\b/g) || []).length;
  return { links, words };
}

function normalizePath(href, internalHosts, siteUrl) {
  if (!href) return null;
  href = href.trim();
  if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return null;
  let abs;
  try {
    abs = new URL(href, siteUrl + '/');
  } catch (e) {
    return null;
  }
  if (abs.host && !internalHosts.has(abs.host.toLowerCase())) return null;
  let path = abs.pathname || '/';
  if (!path.endsWith('/') && !/\.[a-z0-9]+$/i.test(path.split('/').pop() || '')) {
    path += '/';
  }
  return path;
}

// ---------- Audit ----------

function runAuditBuild(siteUrl, posts, previousSnapshot) {
  const parsed = new URL(siteUrl);
  const siteHost = parsed.host.toLowerCase();
  const siteUrlClean = `${parsed.protocol}//${parsed.host}`;

  const internalHosts = new Set([siteHost]);
  for (const post of posts) {
    try {
      const h = new URL(post.url).host.toLowerCase();
      if (h) internalHosts.add(h);
    } catch (e) {}
  }

  const byId = new Map();
  const pathToId = new Map();
  // Tracks the canonical post chosen for each normalized path, so that
  // sitemaps with duplicate URLs (http/https, trailing slash, casing) collapse to one.
  const seenPaths = new Map(); // normalized path key -> post.id

  for (const post of posts) {
    const { links, words } = extractLinksAndWords(post.html || '');
    let path;
    try {
      path = new URL(post.url).pathname || '/';
    } catch (e) {
      path = '/';
    }
    if (!path.endsWith('/') && !/\.[a-z0-9]+$/i.test(path.split('/').pop() || '')) {
      path += '/';
    }

    // Dedup: lowercased path is the key (path itself preserved for display)
    const pathKey = path.toLowerCase();
    const existingId = seenPaths.get(pathKey);

    if (existingId !== undefined) {
      // Already saw this URL — merge into the existing record rather than
      // creating a second entry. Prefer the version with more words (often
      // the canonical page over a stripped variant) and the longer title.
      const existing = byId.get(existingId);
      if (words > existing.words) {
        existing.words = words;
        // Newer/richer version may have better metadata
        if ((post.title || '').length > (existing.title || '').length) {
          existing.title = post.title || existing.title;
        }
        if ((post.slug || '').length > (existing.slug || '').length) {
          existing.slug = post.slug || existing.slug;
        }
        // Merge link lists (de-dupe while we're at it)
        const linkSet = new Set(existing.raw_links);
        for (const l of links) linkSet.add(l);
        existing.raw_links = [...linkSet];
      }
      continue;
    }

    seenPaths.set(pathKey, post.id);
    byId.set(post.id, {
      id: post.id,
      title: post.title || '(untitled)',
      slug: post.slug || '',
      path,
      raw_links: links,
      words,
      outbound_to: [],
      inbound_from: [],
    });
    // Store both the original-case and lowercased versions in pathToId
    // so link resolution works regardless of how a link was written.
    pathToId.set(path, post.id);
    pathToId.set(pathKey, post.id);
  }

  let totalLinks = 0;
  let unresolved = 0;
  const edges = [];
  for (const record of byId.values()) {
    const seen = new Set();
    for (const href of record.raw_links) {
      const norm = normalizePath(href, internalHosts, siteUrlClean);
      if (!norm || norm === record.path) continue;
      // Case-insensitive lookup so /Blog/ and /blog/ resolve to the same post
      const targetId = pathToId.get(norm) || pathToId.get(norm.toLowerCase());
      if (!targetId) { unresolved++; continue; }
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      totalLinks++;
      edges.push([record.id, targetId]);
      const target = byId.get(targetId);
      record.outbound_to.push({ path: target.path, title: target.title });
      target.inbound_from.push({ path: record.path, title: record.title });
    }
  }

  // Build items with deltas
  const prevByPath = new Map();
  if (previousSnapshot?.posts) {
    for (const p of previousSnapshot.posts) prevByPath.set(p.path, p);
  }

  const items = [];
  for (const r of byId.values()) {
    const inbound = r.inbound_from.length;
    const outbound = r.outbound_to.length;
    const prev = prevByPath.get(r.path);
    items.push({
      id: r.id,
      title: r.title,
      slug: r.slug,
      path: r.path,
      words: r.words,
      inbound,
      outbound,
      inbound_delta: prev ? inbound - (prev.inbound || 0) : 0,
      outbound_delta: prev ? outbound - (prev.outbound || 0) : 0,
      inbound_from: r.inbound_from.slice().sort((a, b) => a.title.localeCompare(b.title)),
      outbound_to: r.outbound_to.slice().sort((a, b) => a.title.localeCompare(b.title)),
    });
  }

  const orphans = items.filter(i => i.inbound === 0).length;
  const underlinked = items.filter(i => i.inbound < 3).length;
  const avgInbound = items.length
    ? Math.round((items.reduce((s, i) => s + i.inbound, 0) / items.length) * 10) / 10
    : 0;

  // Cluster densities
  const clusterResults = state.clusters.map(c => {
    const ids = new Set();
    const kws = c.keywords.map(k => k.toLowerCase()).filter(Boolean);
    for (const item of items) {
      const hay = (item.slug + ' ' + item.title).toLowerCase();
      if (kws.some(k => hay.includes(k))) ids.add(item.id);
    }
    const n = ids.size;
    if (n < 2) {
      return { name: c.name, post_count: n, density: null, internal_links: 0, possible_links: 0, weakest: [] };
    }
    const perInbound = new Map();
    const perOutbound = new Map();
    ids.forEach(id => { perInbound.set(id, 0); perOutbound.set(id, 0); });
    let internal = 0;
    for (const [src, tgt] of edges) {
      if (ids.has(src) && ids.has(tgt)) {
        internal++;
        perInbound.set(tgt, perInbound.get(tgt) + 1);
        perOutbound.set(src, perOutbound.get(src) + 1);
      }
    }
    const possible = n * (n - 1);
    const density = possible ? Math.round((internal / possible) * 1000) / 10 : 0;
    const itemsById = new Map(items.map(i => [i.id, i]));
    const scored = [...ids].map(id => ({
      combined: perInbound.get(id) + perOutbound.get(id),
      item: itemsById.get(id),
      cluster_inbound: perInbound.get(id),
      cluster_outbound: perOutbound.get(id),
    })).sort((a, b) => a.combined - b.combined);
    const weakest = scored.slice(0, 5).map(s => ({
      title: s.item.title,
      path: s.item.path,
      cluster_inbound: s.cluster_inbound,
      cluster_outbound: s.cluster_outbound,
    }));
    return {
      name: c.name,
      post_count: n,
      density,
      internal_links: internal,
      possible_links: possible,
      weakest,
    };
  });

  // Action queue: highest-leverage fixes
  const actions = buildActions(items, clusterResults);

  // --- Graph data: which cluster each item belongs to (first match wins) ---
  // Mirrors the keyword-match logic used for cluster density, so graph node
  // colours line up with how the cluster panel scores them.
  const itemCluster = {};
  for (const item of items) {
    const hay = (item.slug + ' ' + item.title).toLowerCase();
    for (const c of state.clusters) {
      const kws = c.keywords.map(k => k.toLowerCase()).filter(Boolean);
      if (kws.some(k => hay.includes(k))) { itemCluster[item.id] = c.name; break; }
    }
  }

  return {
    generated: new Date().toISOString(),
    site_url: siteUrlClean,
    site_host: siteHost,
    stats: {
      post_count: items.length,
      total_links: totalLinks,
      orphan_count: orphans,
      underlinked_count: underlinked,
      avg_inbound: avgInbound,
      unresolved_internal: unresolved,
    },
    items,
    clusters: clusterResults,
    actions,
    edges,
    item_cluster: itemCluster,
  };
}

function buildActions(items, clusters) {
  const actions = [];

  // 1. Substantial orphans (longest first)
  const substantialOrphans = items
    .filter(i => i.inbound === 0 && i.words >= 1000)
    .sort((a, b) => b.words - a.words)
    .slice(0, 3);
  for (const o of substantialOrphans) {
    actions.push({
      title: `Fix orphan: ${o.title}`,
      detail: `${o.words.toLocaleString()} words, zero inbound links. Add 2-3 inbound from related content.`,
      kind: 'orphan',
      path: o.path,
    });
  }

  // 2. Lonely contributors: posts that link out but receive nothing back
  const lonely = items
    .filter(i => i.inbound === 0 && i.outbound >= 3)
    .sort((a, b) => b.outbound - a.outbound)
    .slice(0, 2);
  for (const l of lonely) {
    actions.push({
      title: `Give equity back: ${l.title}`,
      detail: `Links to ${l.outbound} pages but receives nothing. Add inbound links.`,
      kind: 'lonely',
      path: l.path,
    });
  }

  // 3. Weak clusters
  const weakClusters = clusters
    .filter(c => c.density !== null && c.density < 20 && c.post_count >= 3)
    .sort((a, b) => a.density - b.density)
    .slice(0, 2);
  for (const c of weakClusters) {
    actions.push({
      title: `Strengthen cluster: ${c.name}`,
      detail: `Density ${c.density}% across ${c.post_count} posts. Link them together.`,
      kind: 'cluster',
      cluster: c.name,
    });
  }

  return actions.slice(0, 8);
}

// ---------- Rendering ----------

// Plain-English definitions for SEO terms used throughout the dashboard.
// Wired into the UI via the infoIcon() helper below — keep these short and
// jargon-free, since the whole point is to translate for non-SEO users.
const TERM_DEFINITIONS = {
  'internal links': 'The total number of links between pages on your own site. More is usually better, but distribution matters more than raw count.',
  'orphans': 'Pages with zero internal links pointing to them. Search engines may struggle to discover or rank them.',
  'under-linked': 'Pages with fewer than 3 internal links pointing to them. Not invisible like orphans, but starved of internal authority.',
  'avg inbound': 'The average number of internal links each page receives. A higher number suggests a well-connected site structure.',
  'lonely': 'A page that links out to many others but receives no links in return. It distributes equity without earning any back.',
  'cluster': 'A group of pages on a related topic, defined by keywords in their slugs or titles. Density measures how tightly they interlink.',
  'cluster density': 'The percentage of possible directional links between cluster members that actually exist. Above 50% is strong; below 20% means the cluster is loosely connected.',
};

function infoIcon(term) {
  const key = term.toLowerCase();
  const def = TERM_DEFINITIONS[key];
  if (!def) return '';
  return `<button type="button" class="info-icon" data-term="${escapeHtml(term)}" data-def="${escapeHtml(def)}" aria-label="What does ${escapeHtml(term)} mean?">?</button>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDelta(diff, { invert = false } = {}) {
  if (!diff) return '<span class="stat-delta flat">·</span>';
  const sign = diff > 0 ? '+' : '';
  let cls;
  if (invert) cls = diff < 0 ? 'up' : 'down';
  else cls = diff > 0 ? 'up' : 'down';
  return `<span class="stat-delta ${cls}">${sign}${diff} vs last run</span>`;
}

function rowDelta(diff) {
  if (!diff) return '';
  const sign = diff > 0 ? '+' : '';
  const cls = diff > 0 ? 'up' : 'down';
  return `<span class="row-delta ${cls}">${sign}${diff}</span>`;
}

function inboundBadge(count) {
  if (count === 0) return '<span class="badge orphan">orphan</span>';
  if (count < 3) return `<span class="badge low">${count}</span>`;
  if (count >= 10) return `<span class="badge good">${count}</span>`;
  return String(count);
}

function render() {
  const landing = document.getElementById('landingPage');
  const empty = document.getElementById('emptyState');
  const dash = document.getElementById('dashboard');
  const posts = document.getElementById('postsSection');
  const brandMeta = document.getElementById('brandMeta');
  const masthead = document.getElementById('masthead');
  const wafPromo = document.getElementById('wafPromo');
  const appFooter = document.getElementById('appFooter');

  if (state.audit) {
    landing?.classList.add('hidden');
    empty.classList.add('hidden');
    dash.classList.remove('hidden');
    posts.classList.remove('hidden');
    masthead?.classList.remove('hidden');
    wafPromo?.classList.remove('hidden');
    appFooter?.classList.remove('hidden');
    brandMeta.textContent = state.audit.site_host;
    renderRunMeta();
    renderHeadlineStats();
    renderClusters();
    renderTrend();
    renderGraph();
    renderActions();
    renderWafArticles();
    renderPostsTable();
    return;
  }

  if (isConfigReady()) {
    landing?.classList.add('hidden');
    empty.classList.remove('hidden');
    dash.classList.add('hidden');
    posts.classList.add('hidden');
    masthead?.classList.remove('hidden');
    wafPromo?.classList.add('hidden');
    appFooter?.classList.remove('hidden');
    brandMeta.textContent = state.config.siteUrl || state.config.sitemapUrl || 'Configured';
  } else {
    // First visit: show landing page only
    landing?.classList.remove('hidden');
    empty.classList.add('hidden');
    dash.classList.add('hidden');
    posts.classList.add('hidden');
    masthead?.classList.add('hidden');
    wafPromo?.classList.add('hidden');
    appFooter?.classList.add('hidden');
    // Track landing view once per session
    if (!state._landingTracked) {
      state._landingTracked = true;
      track('landing_viewed');
      // If the browser has completed an audit before, fire the categorical
      // "returning user" signal too. No identifier — just the fact.
      try {
        if (localStorage.getItem(STORAGE_KEYS.hasAudited) === '1') {
          track('repeat_visit');
        }
      } catch (e) { /* localStorage blocked, no-op */ }
    }
  }
}

// ---------- Progress history ("since you started") ----------
// Builds a momentum summary by differencing the oldest retained snapshot against
// the newest. Because snapshots are capped at MAX_SNAPSHOTS, "started" means the
// oldest *tracked* audit, not necessarily the literal first — the copy reflects that.

function computeProgressSummary(snapshots) {
  if (!snapshots || snapshots.length < 2) return null;
  const newest = snapshots[0].stats || {};
  const oldest = snapshots[snapshots.length - 1].stats || {};
  return {
    auditCount: snapshots.length,
    firstDate: snapshots[snapshots.length - 1].generated,
    latestDate: snapshots[0].generated,
    orphansFixed: (oldest.orphan_count || 0) - (newest.orphan_count || 0),
    linksAdded: (newest.total_links || 0) - (oldest.total_links || 0),
    underlinkedReduced: (oldest.underlinked_count || 0) - (newest.underlinked_count || 0),
    avgInboundDelta: Math.round(((newest.avg_inbound || 0) - (oldest.avg_inbound || 0)) * 10) / 10,
    postsDelta: (newest.post_count || 0) - (oldest.post_count || 0),
    orphansThen: oldest.orphan_count || 0, orphansNow: newest.orphan_count || 0,
    linksThen: oldest.total_links || 0, linksNow: newest.total_links || 0,
  };
}

// Render one progress stat with direction-aware framing. `goodWhenPositive`
// says whether a positive delta is an improvement (orphans fixed: yes;
// orphans added: a positive delta would be bad).
function progressStat(label, delta, goodWhenPositive, opts = {}) {
  const v = delta || 0;
  let cls = 'flat', sign = '';
  if (v > 0) { cls = goodWhenPositive ? 'up' : 'down'; sign = '+'; }
  else if (v < 0) { cls = goodWhenPositive ? 'down' : 'up'; }
  const display = opts.decimal ? v.toFixed(1) : Math.abs(v).toLocaleString();
  const shown = v < 0 ? '−' + display : (v > 0 ? sign + display : display);
  return `
    <div class="progress-stat">
      <div class="progress-stat-value ${cls}">${shown}</div>
      <div class="progress-stat-label">${escapeHtml(label)}</div>
    </div>`;
}

function openHistoryModal() {
  const summary = computeProgressSummary(state.snapshots);
  const modal = document.getElementById('historyModal');
  const backdrop = document.getElementById('historyBackdrop');
  const body = document.getElementById('historyBody');
  if (!modal || !body) return;

  if (!summary) {
    body.innerHTML = `
      <p class="history-empty">Run at least two audits and your progress will show up here — net orphans fixed, internal links added, and more. Re-run after you've made some changes to see the difference.</p>`;
  } else {
    const first = new Date(summary.firstDate);
    const dateStr = first.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    // Headline sentence adapts to whether things improved overall
    const improved = summary.orphansFixed > 0 || summary.linksAdded > 0;
    const headline = improved
      ? `Since your first tracked audit on ${dateStr}, your internal linking has moved in the right direction.`
      : `Here's how things have changed since your first tracked audit on ${dateStr}.`;

    body.innerHTML = `
      <p class="history-lede">${headline}</p>
      <div class="progress-grid">
        ${progressStat('orphans fixed', summary.orphansFixed, true)}
        ${progressStat('internal links added', summary.linksAdded, true)}
        ${progressStat('under-linked pages cleared', summary.underlinkedReduced, true)}
        ${progressStat('avg inbound change', summary.avgInboundDelta, true, { decimal: true })}
      </div>
      <div class="history-endpoints">
        <span>Orphans: <strong>${summary.orphansThen}</strong> → <strong>${summary.orphansNow}</strong></span>
        <span>Links: <strong>${summary.linksThen.toLocaleString()}</strong> → <strong>${summary.linksNow.toLocaleString()}</strong></span>
        <span>${summary.auditCount} audits tracked</span>
      </div>`;
  }

  modal.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

function closeHistoryModal() {
  document.getElementById('historyModal')?.classList.add('hidden');
  document.getElementById('historyBackdrop')?.classList.add('hidden');
}

function renderRunMeta() {
  const el = document.getElementById('runMeta');
  const d = new Date(state.audit.generated);
  // Show a "view history" link only once there's more than one audit to compare
  const canShowHistory = (state.snapshots?.length || 0) >= 2;
  el.innerHTML = `Last audit · ${escapeHtml(d.toLocaleString())} · ${state.audit.stats.post_count} posts scanned` +
    (canShowHistory ? ` · <button type="button" class="run-meta-link" id="viewHistoryBtn">view progress</button>` : '');
  if (canShowHistory) {
    document.getElementById('viewHistoryBtn')?.addEventListener('click', openHistoryModal);
  }
}

function renderHeadlineStats() {
  const el = document.getElementById('headlineStats');
  const s = state.audit.stats;
  const prev = state.snapshots[1]?.stats;
  const stats = [
    { label: 'Internal links', value: s.total_links,
      delta: prev ? formatDelta(s.total_links - (prev.total_links || 0)) : '' },
    { label: 'Orphans', value: s.orphan_count,
      delta: prev ? formatDelta(s.orphan_count - (prev.orphan_count || 0), { invert: true }) : '' },
    { label: 'Under-linked', value: s.underlinked_count,
      delta: prev ? formatDelta(s.underlinked_count - (prev.underlinked_count || 0), { invert: true }) : '' },
    { label: 'Avg inbound', value: s.avg_inbound,
      delta: prev ? formatDelta(Math.round((s.avg_inbound - (prev.avg_inbound || 0)) * 10) / 10) : '' },
  ];
  el.innerHTML = stats.map(s => `
    <div class="headline-stat">
      <div class="stat-label">${s.label}${infoIcon(s.label)}</div>
      <div class="stat-value">${s.value.toLocaleString()}</div>
      ${s.delta}
    </div>
  `).join('');
}

function renderClusters() {
  const el = document.getElementById('clusterGrid');
  if (!state.audit.clusters.length) {
    el.innerHTML = `
      <div class="empty-cluster-prompt">
        <div class="empty-cluster-prompt-body">
          <h4>One step left: add your topic clusters</h4>
          <p>This is the heart of Clusterscore. A cluster is a topic — like "pricing" or "founders" — and we score how tightly the pages in it link to each other. It's the part most SEO tools miss. Takes about a minute, and the rest of your audit below is ready now either way.</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="emptyClusterAddBtn">Add clusters</button>
      </div>
    `;
    document.getElementById('emptyClusterAddBtn')?.addEventListener('click', () => {
      openDrawer();
      // Once the drawer is open, scroll to the cluster editor section
      setTimeout(() => {
        document.getElementById('clusterEditor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 200);
    });
    return;
  }
  el.innerHTML = state.audit.clusters.map(c => {
    if (c.density === null) {
      return `<div class="cluster-card">
        <div class="cluster-name">${escapeHtml(c.name)}</div>
        <div class="cluster-density muted">—</div>
        <div class="cluster-meta">${c.post_count} post${c.post_count === 1 ? '' : 's'} · need 2+ to score</div>
      </div>`;
    }
    let cls = 'bad';
    if (c.density >= 50) cls = 'good';
    else if (c.density >= 20) cls = 'amber';
    return `<div class="cluster-card">
      <div class="cluster-name">${escapeHtml(c.name)}</div>
      <div class="cluster-density ${cls}">${c.density}%</div>
      <div class="cluster-meta">${c.internal_links}/${c.possible_links} · ${c.post_count} posts</div>
    </div>`;
  }).join('');
}

function renderTrend() {
  const el = document.getElementById('trendChart');
  const points = state.snapshots
    .slice()
    .reverse()
    .map(s => s.stats?.total_links)
    .filter(v => typeof v === 'number');
  if (points.length < 2) {
    el.innerHTML = '<div class="trend-empty">Run the audit again to start seeing a trend</div>';
    return;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 100;
  const h = 100;
  const stepX = w / (points.length - 1);
  const coords = points.map((v, i) => ({
    x: i * stepX,
    y: h - ((v - min) / range) * h * 0.85 - 8,
  }));
  const linePath = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c.x.toFixed(2) + ',' + c.y.toFixed(2)).join(' ');
  const areaPath = linePath + ` L${w},${h} L0,${h} Z`;
  const dots = coords.map(c => `<circle cx="${c.x}" cy="${c.y}" r="1.6" fill="#443fde"/>`).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:140px;width:100%">
      <path d="${areaPath}" fill="#ecebfc"/>
      <path d="${linePath}" fill="none" stroke="#443fde" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
      ${dots}
    </svg>
    <div style="display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:10px;color:var(--ink-3);margin-top:8px;text-transform:uppercase;letter-spacing:0.08em">
      <span>${points[0].toLocaleString()}</span>
      <span>${points[points.length - 1].toLocaleString()}</span>
    </div>
  `;
}

// ---------- Link graph (force-directed, hand-rolled, no deps) ----------
// Same compute-then-paint approach as renderTrend(): run a fixed number of
// simulation ticks synchronously, then draw the settled positions once.
// No animation loop. Handles a few hundred nodes comfortably.

const CLUSTER_PALETTE = [
  '#443fde', '#2a9d8f', '#e76f51', '#e9c46a', '#9b5de5',
  '#00bbf9', '#f15bb5', '#588157', '#bc6c25', '#48cae4',
];

// Deterministic RNG so the same audit lays out identically each render
// (Math.random would reshuffle the graph every time, which is jarring).
function csMulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulateGraph(items, edges, opts = {}) {
  const W = opts.width || 800;
  const H = opts.height || 520;
  const TICKS = opts.ticks || 300;
  const rand = csMulberry32(items.length * 2654435761 + edges.length);
  const cx = W / 2, cy = H / 2;

  const nodes = items.map(it => ({
    id: it.id,
    inbound: it.inbound,
    outbound: it.outbound,
    degree: it.inbound + it.outbound,
    orphan: it.inbound === 0,
    x: cx + (rand() - 0.5) * W * (it.inbound === 0 ? 0.95 : 0.5),
    y: cy + (rand() - 0.5) * H * (it.inbound === 0 ? 0.95 : 0.5),
    vx: 0, vy: 0,
  }));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));

  const links = [];
  for (const [s, t] of edges) {
    const si = idx.get(s), ti = idx.get(t);
    if (si === undefined || ti === undefined) continue;
    links.push([si, ti]);
  }

  const REPULSION = 900, SPRING = 0.02, SPRING_LEN = 42, CENTER = 0.012, DAMP = 0.85;

  for (let tick = 0; tick < TICKS; tick++) {
    const cool = 1 - tick / TICKS;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = rand() - 0.5; dy = rand() - 0.5; }
        const force = (REPULSION / d2) * cool;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force, fy = (dy / d) * force;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    for (const [si, ti] of links) {
      const a = nodes[si], b = nodes[ti];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (d - SPRING_LEN) * SPRING;
      const fx = (dx / d) * force, fy = (dy / d) * force;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const n of nodes) {
      if (n.orphan) {
        // Weaker centre pull + a small outward shove, so orphans ring the edge
        n.vx += (cx - n.x) * (CENTER * 0.35);
        n.vy += (cy - n.y) * (CENTER * 0.35);
        const ox = n.x - cx, oy = n.y - cy;
        const od = Math.sqrt(ox * ox + oy * oy) || 0.01;
        const push = 0.6 * cool;
        n.vx += (ox / od) * push; n.vy += (oy / od) * push;
      } else {
        n.vx += (cx - n.x) * CENTER;
        n.vy += (cy - n.y) * CENTER;
      }
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(16, Math.min(W - 16, n.x));
      n.y = Math.max(16, Math.min(H - 16, n.y));
    }
  }
  return { nodes, links, W, H };
}

function renderGraph() {
  const el = document.getElementById('graphChart');
  if (!el || !state.audit) return;
  const items = state.audit.items || [];
  const edges = state.audit.edges || [];

  if (items.length < 2) {
    el.innerHTML = '<div class="graph-empty">Not enough posts to draw a graph yet.</div>';
    return;
  }
  if (!edges.length) {
    el.innerHTML = '<div class="graph-empty">No internal links found to graph. Re-run the audit if this looks wrong.</div>';
    return;
  }

  const W = 800, H = 520;
  const { nodes } = simulateGraph(items, edges, { width: W, height: H, ticks: 300 });
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Cluster colours
  const clusterNames = (state.audit.clusters || []).map(c => c.name);
  const colorMap = {};
  clusterNames.forEach((name, i) => { colorMap[name] = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]; });
  const itemCluster = state.audit.item_cluster || {};

  // Node radius scales gently with degree so hubs read as bigger
  const radius = n => Math.max(2.5, Math.min(9, 2.5 + Math.sqrt(n.degree) * 1.1));

  // Edges first (under nodes), faint
  const edgeSvg = edges.map(([s, t]) => {
    const a = nodeById.get(s), b = nodeById.get(t);
    if (!a || !b) return '';
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#d8d8e8" stroke-width="0.6"/>`;
  }).join('');

  // Nodes
  const nodeSvg = nodes.map(n => {
    const cluster = itemCluster[n.id];
    const fill = n.orphan ? '#c4c4d0' : (cluster ? colorMap[cluster] : '#8a8a9a');
    const stroke = n.orphan ? '#a8a8b8' : 'rgba(0,0,0,0.15)';
    const nodeCluster = itemCluster[n.id] || '';
    return `<circle class="graph-node" data-id="${escapeHtml(String(n.id))}" data-title="${escapeHtml(itemTitle(n.id))}" data-in="${n.inbound}" data-out="${n.outbound}" data-orphan="${n.orphan ? '1' : '0'}" data-cluster="${escapeHtml(nodeCluster)}" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${radius(n).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"></circle>`;
  }).join('');

  // Legend: clusters present + orphan swatch
  const presentClusters = clusterNames.filter(name =>
    Object.values(itemCluster).includes(name));
  const legend = presentClusters.map(name =>
    `<span class="graph-legend-item"><span class="graph-legend-dot" style="background:${colorMap[name]}"></span>${escapeHtml(name)}</span>`
  ).join('') +
    `<span class="graph-legend-item"><span class="graph-legend-dot" style="background:#c4c4d0"></span>Orphan</span>`;

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="graph-svg" preserveAspectRatio="xMidYMid meet">
      <g class="graph-edges">${edgeSvg}</g>
      <g class="graph-nodes">${nodeSvg}</g>
    </svg>
    <div class="graph-legend">${legend}</div>
    <div class="graph-hint">Each dot is a page. Lines are internal links. Dots on the outer edge are orphans — pages nothing links to. Hover a dot for detail, click it to filter the table below.</div>
    <div class="graph-tooltip hidden" id="graphTooltip"></div>
  `;

  // Click a node -> filter the posts table to that node + its neighbours
  const tooltip = document.getElementById('graphTooltip');
  el.querySelectorAll('.graph-node').forEach(circle => {
    circle.addEventListener('click', () => {
      focusNodeInTable(circle.dataset.id);
    });
    // Hover -> show a readable tooltip explaining the node
    circle.addEventListener('mouseenter', () => {
      if (!tooltip) return;
      const d = circle.dataset;
      const inN = parseInt(d.in, 10), outN = parseInt(d.out, 10);
      const isOrphan = d.orphan === '1';
      // Plain-English status line so first-time users understand the dot
      let status;
      if (isOrphan) status = 'Orphan — no pages link to this one';
      else if (inN < 3) status = 'Under-linked — few pages link here';
      else if (inN >= 10) status = 'Hub — lots of pages link here';
      else status = 'Connected';
      const clusterLine = d.cluster ? `<div class="graph-tooltip-cluster">${escapeHtml(d.cluster)} cluster</div>` : '';
      tooltip.innerHTML = `
        <div class="graph-tooltip-title">${escapeHtml(d.title || '(untitled)')}</div>
        <div class="graph-tooltip-status">${status}</div>
        <div class="graph-tooltip-counts">${inN} in · ${outN} out</div>
        ${clusterLine}`;
      tooltip.classList.remove('hidden');
    });
    circle.addEventListener('mousemove', (e) => {
      if (!tooltip || tooltip.classList.contains('hidden')) return;
      // Position relative to the graph container, offset from the cursor
      const rect = el.getBoundingClientRect();
      let x = e.clientX - rect.left + 14;
      let y = e.clientY - rect.top + 14;
      // Keep it inside the container horizontally
      if (x + 200 > rect.width) x = e.clientX - rect.left - 200;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    });
    circle.addEventListener('mouseleave', () => {
      tooltip?.classList.add('hidden');
    });
  });
}

// Helper: post title by id (for tooltips)
function itemTitle(id) {
  const it = (state.audit?.items || []).find(i => String(i.id) === String(id));
  return it ? it.title : '';
}

// Filter the posts table to a node and everything it connects to (in or out).
function focusNodeInTable(id) {
  const items = state.audit?.items || [];
  const target = items.find(i => String(i.id) === String(id));
  if (!target) return;

  // Collect neighbour paths from the edge list
  const neighbours = new Set([target.path]);
  for (const [s, t] of (state.audit.edges || [])) {
    if (String(s) === String(id)) {
      const tn = items.find(i => String(i.id) === String(t));
      if (tn) neighbours.add(tn.path);
    }
    if (String(t) === String(id)) {
      const sn = items.find(i => String(i.id) === String(s));
      if (sn) neighbours.add(sn.path);
    }
  }

  // Drive the existing table via a dedicated focus set
  state.graphFocus = neighbours;
  state.filter = 'all';
  document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
  document.querySelector('.filter-btn[data-filter="all"]')?.classList.add('active');
  // Clear text search so it doesn't fight the focus filter
  state.search = '';
  const searchInput = document.getElementById('search');
  if (searchInput) searchInput.value = '';

  renderPostsTable();
  track('graph_node_focused');

  // Scroll the table into view and show a clear-focus affordance
  document.getElementById('postsSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showGraphFocusBanner(target.title, neighbours.size);
}

function showGraphFocusBanner(title, count) {
  let banner = document.getElementById('graphFocusBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'graphFocusBanner';
    banner.className = 'graph-focus-banner';
    const postsSub = document.getElementById('postsSub');
    postsSub?.parentElement?.appendChild(banner);
  }
  banner.innerHTML = `Showing <strong>${escapeHtml(title)}</strong> and its ${count - 1} connected page${count - 1 === 1 ? '' : 's'}. <button type="button" id="clearGraphFocus">Clear</button>`;
  banner.classList.remove('hidden');
  document.getElementById('clearGraphFocus')?.addEventListener('click', () => {
    state.graphFocus = null;
    banner.classList.add('hidden');
    renderPostsTable();
  });
}

function renderActions() {
  const el = document.getElementById('actionList');
  if (!state.audit.actions.length) {
    el.innerHTML = '<li class="action-item" style="padding-left:20px"><div class="action-title">No urgent actions detected.</div><div class="action-detail">Cluster densities and orphan counts look healthy.</div></li>';
    return;
  }
  const siteUrl = (state.audit.site_url || '').replace(/\/+$/, '');
  el.innerHTML = state.audit.actions.map(a => {
    // Cluster actions don't have a single URL to link to — render as a plain row
    if (!a.path) {
      return `
        <li class="action-item">
          <div class="action-title">${escapeHtml(a.title)}</div>
          <div class="action-detail">
            <span class="action-tag">${a.kind}${infoIcon(a.kind)}</span>${escapeHtml(a.detail)}
          </div>
        </li>
      `;
    }
    // Orphan/lonely actions link to the affected page in a new tab
    const href = siteUrl + a.path;
    return `
      <li class="action-item">
        <a class="action-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
          <div class="action-title">
            ${escapeHtml(a.title)}
            <svg class="action-external-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3h7v7M13 3L6.5 9.5M11 9v3.5A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-6A1.5 1.5 0 0 1 3.5 5H7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="action-detail">
            <span class="action-tag">${a.kind}${infoIcon(a.kind)}</span>${escapeHtml(a.detail)}
          </div>
        </a>
      </li>
    `;
  }).join('');
}

// ---------- WAF section ----------

function renderWafArticles() {
  const grid = document.getElementById('wafArticlesGrid');
  if (!grid) return;
  grid.innerHTML = WAF_ARTICLES.map(a => `
    <a class="waf-article-card" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">
      <div class="waf-article-title">${escapeHtml(a.title)}</div>
      <div class="waf-article-description">${escapeHtml(a.description)}</div>
      <div class="waf-article-cta">Read on We Are Founders →</div>
    </a>
  `).join('');
}

// Submits an email to Ghost's send-magic-link endpoint to subscribe the user.
// Ghost's portal endpoint typically allows CORS for cross-origin signup forms.
// If anything fails (CORS, network, server), we fall back to opening WAF's
// signup portal in a new tab so the user still gets routed correctly.
async function submitNewsletterSignup(email) {
  const feedback = document.getElementById('wafNewsletterFeedback');
  const btn = document.getElementById('wafNewsletterBtn');
  const setMsg = (msg, cls) => {
    feedback.textContent = msg;
    feedback.className = 'waf-newsletter-feedback ' + (cls || '');
  };

  btn.disabled = true;
  btn.textContent = 'Subscribing...';
  setMsg('', '');

  try {
    const resp = await fetch(WAF_SIGNUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, emailType: 'signup' }),
    });
    if (resp.ok) {
      setMsg('Check your inbox for a confirmation link.', 'success');
      btn.textContent = 'Subscribed';
      // Leave the button disabled so people don't double-submit
      return;
    }
    // Non-OK: fall through to fallback
    throw new Error('Signup endpoint returned ' + resp.status);
  } catch (e) {
    // CORS, network, or non-OK response — open WAF portal in a new tab
    window.open(WAF_SITE + '/#/portal/signup', '_blank', 'noopener');
    setMsg('Opening signup in a new tab.', '');
    btn.disabled = false;
    btn.textContent = 'Subscribe';
  }
}

function renderPostsTable() {
  const tbody = document.getElementById('rows');
  const search = state.search.toLowerCase();
  // Graph focus: if a node was clicked in the graph, restrict to its neighbour set
  const focusSet = state.graphFocus;
  let rows = state.audit.items.filter(p => {
    if (focusSet && !focusSet.has(p.path)) return false;
    if (state.filter === 'orphans' && p.inbound > 0) return false;
    if (state.filter === 'underlinked' && p.inbound >= 3) return false;
    if (state.filter === 'hubs' && p.inbound < 10) return false;
    if (state.filter === 'changed' && !p.inbound_delta && !p.outbound_delta) return false;
    if (search && !((p.title || '').toLowerCase().includes(search)
                  || (p.path || '').toLowerCase().includes(search)
                  || (p.slug || '').toLowerCase().includes(search))) return false;
    return true;
  });
  rows.sort((a, b) => {
    let av = a[state.sort.key];
    let bv = b[state.sort.key];
    if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return state.sort.dir === 'asc' ? -1 : 1;
    if (av > bv) return state.sort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = '';
  for (const p of rows) {
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.dataset.id = p.id;
    tr.innerHTML = `
      <td class="cell-title">${escapeHtml(p.title)}</td>
      <td class="cell-url">${escapeHtml(p.path)}</td>
      <td class="num">${inboundBadge(p.inbound)}${rowDelta(p.inbound_delta)}</td>
      <td class="num">${p.outbound}${rowDelta(p.outbound_delta)}</td>
      <td class="num">${p.words.toLocaleString()}</td>
    `;
    tr.addEventListener('click', () => toggleDetail(p.id));
    tbody.appendChild(tr);
    if (state.expanded.has(p.id)) {
      tbody.appendChild(buildDetailRow(p));
    }
  }
  document.getElementById('emptyTable').classList.toggle('hidden', rows.length > 0);
  document.getElementById('postsSub').textContent = `${rows.length} of ${state.audit.items.length}`;
}

function buildDetailRow(p) {
  const tr = document.createElement('tr');
  tr.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 5;
  const inHtml = p.inbound_from.length
    ? p.inbound_from.map(s => `<li><a href="${escapeHtml(state.audit.site_url + s.path)}" target="_blank">${escapeHtml(s.title)}</a><span class="detail-path">${escapeHtml(s.path)}</span></li>`).join('')
    : '<li class="detail-empty">No inbound internal links.</li>';
  const outHtml = p.outbound_to.length
    ? p.outbound_to.map(s => `<li><a href="${escapeHtml(state.audit.site_url + s.path)}" target="_blank">${escapeHtml(s.title)}</a><span class="detail-path">${escapeHtml(s.path)}</span></li>`).join('')
    : '<li class="detail-empty">No outbound internal links.</li>';
  td.innerHTML = `
    <div class="detail-section">
      <h4>Inbound (${p.inbound_from.length}) — pages linking to this post</h4>
      <ul class="detail-list">${inHtml}</ul>
    </div>
    <div class="detail-section">
      <h4>Outbound (${p.outbound_to.length}) — pages this post links to</h4>
      <ul class="detail-list">${outHtml}</ul>
    </div>
    <a class="detail-open-link" href="${escapeHtml(state.audit.site_url + p.path)}" target="_blank">Open post →</a>
  `;
  tr.appendChild(td);
  return tr;
}

function toggleDetail(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderPostsTable();
}

// ---------- Progressive (streaming) dashboard ----------
// For large sites we dismiss the loading modal partway through the fetch and
// reveal the dashboard shell, streaming per-page rows into the posts table as
// they arrive. Graph-level aggregates (orphans, inbound counts, cluster density)
// depend on the WHOLE link graph and cannot be computed until every page is in,
// so they render as skeletons until the final build swaps them for real numbers.

const STREAM = {
  active: false,
  total: 0,
  seenPaths: null,     // Set of normalized paths already streamed (dedupe)
  pending: [],         // rows awaiting the next flush
  flushScheduled: false,
};

// Streaming only pays off on big sites. Small sites finish so fast that the
// modal→handoff transition is just flicker, so below the floor we keep today's
// behaviour (modal to completion, then render once).
const STREAM_SMALL_SITE_FLOOR = 800;
function streamThresholdFor(total) {
  return Math.max(Math.ceil(total * 0.25), 500);
}
function shouldStream(total) {
  return total >= STREAM_SMALL_SITE_FLOOR;
}

// Reveal the dashboard shell with skeletons in place of graph-level aggregates,
// and an empty streaming table ready to receive rows. Called at the handoff.
function beginStreamingDashboard(total) {
  STREAM.active = true;
  STREAM.total = total;
  STREAM.seenPaths = new Set();
  STREAM.pending = [];

  hideProgress(); // dismiss the blocking modal — dashboard takes over

  // Show the dashboard + posts sections and masthead, hide landing/empty.
  document.getElementById('landingPage')?.classList.add('hidden');
  document.getElementById('emptyState')?.classList.add('hidden');
  document.getElementById('dashboard')?.classList.remove('hidden');
  document.getElementById('postsSection')?.classList.remove('hidden');
  document.getElementById('masthead')?.classList.remove('hidden');
  // Keep the promo/footer hidden until the real render, to avoid layout churn.
  document.getElementById('wafPromo')?.classList.add('hidden');
  document.getElementById('appFooter')?.classList.add('hidden');

  document.getElementById('dashboard')?.classList.add('is-streaming');

  renderSkeletonAggregates();

  // Prime the posts table for streaming.
  const tbody = document.getElementById('rows');
  if (tbody) tbody.innerHTML = '';
  document.getElementById('emptyTable')?.classList.add('hidden');
  const sub = document.getElementById('postsSub');
  if (sub) sub.textContent = `0 of ~${total.toLocaleString()} (loading…)`;

  // A persistent, non-blocking progress pill so the user knows work continues.
  showStreamPill(0, total);
}

// Headline stats + cluster/graph/action panels as skeletons. These are the
// numbers that require the full graph, so they stay "calculating" until the end.
function renderSkeletonAggregates() {
  const labels = ['Internal links', 'Orphans', 'Under-linked', 'Avg inbound'];
  const head = document.getElementById('headlineStats');
  if (head) {
    head.innerHTML = labels.map(l => `
      <div class="headline-stat is-skeleton" aria-busy="true">
        <div class="stat-label">${l}${infoIcon(l)}</div>
        <div class="stat-value"><span class="skeleton-bar skeleton-bar-lg"></span></div>
        <div class="stat-calc">calculating…</div>
      </div>
    `).join('');
  }
  const cg = document.getElementById('clusterGrid');
  if (cg) {
    cg.innerHTML = Array.from({ length: Math.max(1, state.clusters.length) || 3 }).map(() => `
      <div class="cluster-card is-skeleton" aria-busy="true">
        <span class="skeleton-bar skeleton-bar-md"></span>
        <span class="skeleton-bar skeleton-bar-sm"></span>
      </div>
    `).join('');
  }
  const graph = document.getElementById('graphChart');
  if (graph) graph.innerHTML = `<div class="graph-skeleton" aria-busy="true">Mapping your link graph once every page is in…</div>`;
  const actions = document.getElementById('actionList');
  if (actions) actions.innerHTML = `<li class="action-skeleton" aria-busy="true">Prioritising fixes once the full graph is ready…</li>`;
}

// Stream one fetched page into the provisional table. inbound/outbound are not
// yet known (they need the full graph), so those cells show a skeleton dash.
function streamRow(post) {
  if (!STREAM.active) return;
  let path;
  try {
    path = new URL(post.url).pathname || '/';
  } catch { path = '/'; }
  if (!path.endsWith('/') && !/\.[a-z0-9]+$/i.test(path.split('/').pop() || '')) path += '/';
  const key = path.toLowerCase();
  if (STREAM.seenPaths.has(key)) return; // dedupe (mirrors runAuditBuild)
  STREAM.seenPaths.add(key);

  const { words } = extractLinksAndWords(post.html || '');
  STREAM.pending.push({ title: post.title || '(untitled)', path, words });
  scheduleStreamFlush();
}

// Batch DOM writes to one per animation frame so a fast fetch doesn't thrash
// layout with thousands of individual insertions.
function scheduleStreamFlush() {
  if (STREAM.flushScheduled) return;
  STREAM.flushScheduled = true;
  requestAnimationFrame(() => {
    STREAM.flushScheduled = false;
    flushStreamRows();
  });
}

function flushStreamRows() {
  const tbody = document.getElementById('rows');
  if (!tbody || !STREAM.pending.length) return;
  const batch = STREAM.pending;
  STREAM.pending = [];
  const frag = document.createDocumentFragment();
  for (const r of batch) {
    const tr = document.createElement('tr');
    tr.className = 'row row-streaming';
    tr.innerHTML = `
      <td class="cell-title">${escapeHtml(r.title)}</td>
      <td class="cell-url">${escapeHtml(r.path)}</td>
      <td class="num"><span class="skeleton-bar skeleton-bar-xs"></span></td>
      <td class="num"><span class="skeleton-bar skeleton-bar-xs"></span></td>
      <td class="num">${r.words.toLocaleString()}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  const shown = STREAM.seenPaths.size;
  const sub = document.getElementById('postsSub');
  if (sub) sub.textContent = `${shown.toLocaleString()} of ~${STREAM.total.toLocaleString()} (loading…)`;
  updateStreamPill(shown, STREAM.total);
}

// Non-blocking progress pill (bottom corner) shown while streaming continues.
function showStreamPill(done, total) {
  let pill = document.getElementById('streamPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'streamPill';
    pill.className = 'stream-pill';
    pill.innerHTML = `<span class="stream-pill-dot"></span><span class="stream-pill-text"></span>`;
    document.body.appendChild(pill);
  }
  pill.classList.remove('hidden');
  updateStreamPill(done, total);
}
function updateStreamPill(done, total) {
  const pill = document.getElementById('streamPill');
  if (!pill) return;
  const txt = pill.querySelector('.stream-pill-text');
  if (txt) txt.textContent = `Fetching pages… ${done.toLocaleString()} of ${total.toLocaleString()}`;
}
function endStreaming() {
  STREAM.active = false;
  STREAM.pending = [];
  document.getElementById('dashboard')?.classList.remove('is-streaming');
  document.getElementById('streamPill')?.classList.add('hidden');
}

// ---------- Settings drawer ----------

function openDrawer() {
  populateDrawer();
  document.getElementById('drawerBackdrop').classList.remove('hidden');
  document.getElementById('settingsDrawer').classList.remove('hidden');
  track('settings_opened');
}
function closeDrawer() {
  document.getElementById('drawerBackdrop').classList.add('hidden');
  document.getElementById('settingsDrawer').classList.add('hidden');
}
function populateDrawer() {
  const source = state.config.source || 'autodetect';
  document.querySelectorAll('input[name="source"]').forEach(r => {
    r.checked = r.value === source;
  });
  updateSourceVisibility(source);

  document.getElementById('siteUrlInput').value = state.config.siteUrl || '';
  document.getElementById('ghostUrlInput').value = state.config.ghostUrl || '';
  document.getElementById('apiKeyInput').value = state.config.apiKey || '';
  document.getElementById('sitemapUrlInput').value = state.config.sitemapUrl || '';
  document.getElementById('includePatternsInput').value = state.config.includePatterns || '';
  document.getElementById('excludePatternsInput').value = state.config.excludePatterns || '';
  renderClusterEditor();
  document.getElementById('snapshotCount').textContent =
    `${state.snapshots.length} snapshot${state.snapshots.length === 1 ? '' : 's'} stored (max ${MAX_SNAPSHOTS})`;

  // Contextual save button label: onboarding flow gets the clearer "Save and run audit"
  const saveBtn = document.getElementById('saveSettingsBtn');
  if (saveBtn) {
    saveBtn.textContent = state.audit ? 'Save' : 'Save and run audit';
  }
}

function updateSourceVisibility(source) {
  // Universal site URL field appears for autodetect, wordpress, webflow
  const isUrlMode = source === 'autodetect' || source === 'wordpress' || source === 'webflow';
  document.getElementById('siteUrlFields').classList.toggle('hidden', !isUrlMode);
  document.getElementById('ghostFields').classList.toggle('hidden', source !== 'ghost');
  document.getElementById('sitemapFields').classList.toggle('hidden', source !== 'sitemap');

  // Update the URL field label based on source
  const label = document.getElementById('siteUrlLabel');
  if (label) {
    if (source === 'wordpress') label.textContent = 'Your WordPress site URL';
    else if (source === 'webflow') label.textContent = 'Your Webflow site URL';
    else label.textContent = 'Your site URL';
  }
}
function renderClusterEditor() {
  const el = document.getElementById('clusterEditor');
  el.innerHTML = '';
  state.clusters.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'cluster-chip-card';
    row.innerHTML = `
      <div class="cluster-chip-head">
        <input type="text" class="cluster-chip-name" placeholder="Cluster name" data-field="name" value="${escapeHtml(c.name)}">
        <button class="cluster-chip-remove" type="button" aria-label="Remove">&times;</button>
      </div>
      <div class="cluster-chip-kw-row">
        <span class="cluster-chip-kw-label">matches:</span>
        <input type="text" class="cluster-chip-kw" placeholder="keyword auto-fills from name" data-field="keywords" value="${escapeHtml(c.keywords.join(', '))}">
      </div>
    `;
    const nameInput = row.querySelector('[data-field="name"]');
    const kwInput = row.querySelector('[data-field="keywords"]');

    nameInput.addEventListener('input', e => {
      const val = e.target.value;
      state.clusters[idx].name = val;
      // Auto-fill the keyword from the name unless the user has customised keywords.
      // "Customised" means they've typed something that isn't just the auto-derived value.
      if (!state.clusters[idx]._keywordsTouched) {
        const derived = val.trim().toLowerCase();
        state.clusters[idx].keywords = derived ? [derived] : [];
        kwInput.value = derived;
      }
    });

    kwInput.addEventListener('input', e => {
      // Once the user edits keywords directly, stop auto-filling from the name.
      state.clusters[idx]._keywordsTouched = true;
      state.clusters[idx].keywords = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
    });

    row.querySelector('.cluster-chip-remove').addEventListener('click', () => {
      state.clusters.splice(idx, 1);
      renderClusterEditor();
    });
    el.appendChild(row);
  });
}

// ---------- Audit run ----------

// ---------- Sitemap discovery ----------

// Platform-specific defaults: known sitemap paths, useful exclude patterns
const PLATFORM_DEFAULTS = {
  wordpress: {
    sitemapPaths: ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml'],
    excludePatterns: '/wp-content/, /wp-includes/, /wp-admin/, /?p=, /?attachment_id=',
  },
  webflow: {
    sitemapPaths: ['/sitemap.xml'],
    excludePatterns: '/detail_, /detail/',
  },
};

async function discoverSitemap(siteUrl) {
  const url = PROXY_URL.replace(/\/+$/, '') + '/discover?url=' + encodeURIComponent(siteUrl);
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok || !data.found) {
    // Carry the worker's diagnostic info (which URLs were tried) on the error,
    // so the failure modal can surface them. The thrown message is still useful
    // for cases where the modal isn't appropriate (e.g. Ghost mode falls back to a toast).
    const err = new Error(data.error || 'Could not discover a sitemap.');
    err.attempted = data.attempted || [];
    err.siteUrl = siteUrl;
    throw err;
  }
  return data; // { found, sitemap_url, source, post_count, is_index, nested_count }
}

// User-facing entry point: handles discovery confirmation, then delegates to actualRunAudit
async function runAudit() {
  const cfg = state.config;

  // Ghost mode skips discovery entirely
  if (cfg.source === 'ghost') {
    return actualRunAudit();
  }

  // Manual sitemap mode: no discovery needed, use the URL they gave us
  if (cfg.source === 'sitemap') {
    return actualRunAudit();
  }

  // Already discovered and confirmed in this session? Just run.
  if (cfg.resolvedSitemapUrl) {
    return actualRunAudit();
  }

  // URL modes need discovery + confirmation
  if (!cfg.siteUrl) {
    toast('Add your site URL in Settings first.', 'error');
    openDrawer();
    return;
  }

  const btn = document.getElementById('runAuditBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  showProgress('Finding your sitemap...');

  try {
    // Run platform-aware discovery
    let discovery;
    if (cfg.source === 'wordpress' || cfg.source === 'webflow') {
      // Try conventional platform paths first via discoverSitemap (the worker tries
      // multiple strategies including platform conventions)
      discovery = await discoverSitemap(cfg.siteUrl);
    } else {
      // autodetect
      discovery = await discoverSitemap(cfg.siteUrl);
    }
    showDiscoveryConfirm(discovery);
  } catch (e) {
    console.error(e);
    showDiscoveryFailure(e);
  } finally {
    hideProgress();
    hideProgress();
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Run audit';
  }
}

function showDiscoveryConfirm(discovery) {
  const modal = document.getElementById('confirmModal');
  const urlEl = document.getElementById('confirmUrl');
  const sourceEl = document.getElementById('confirmSource');
  const countEl = document.getElementById('confirmCount');
  urlEl.textContent = discovery.sitemap_url;
  sourceEl.textContent = `Discovered via ${discovery.source}`;
  if (discovery.is_index) {
    countEl.textContent = `${discovery.post_count.toLocaleString()} posts across ${discovery.nested_count} nested sitemap${discovery.nested_count === 1 ? '' : 's'}`;
  } else {
    countEl.textContent = `${discovery.post_count.toLocaleString()} posts found`;
  }

  // Stash the discovery for the confirm handler
  modal.dataset.sitemapUrl = discovery.sitemap_url;
  modal.classList.remove('hidden');
  document.getElementById('confirmBackdrop').classList.remove('hidden');
}

function closeConfirmModal(wasDismissed = true) {
  const modal = document.getElementById('confirmModal');
  // Only fire dismissed event if the modal was actually open. closeConfirmModal()
  // can be called by buttons regardless of state, so we guard against false fires.
  const isOpen = !modal.classList.contains('hidden');
  modal.classList.add('hidden');
  document.getElementById('confirmBackdrop').classList.add('hidden');
  if (isOpen && wasDismissed) {
    track('confirmation_dismissed');
  }
}

function showDiscoveryFailure(err) {
  const modal = document.getElementById('failModal');
  const domainEl = document.getElementById('failDomain');
  const attemptedList = document.getElementById('failAttemptedList');
  const attemptedWrap = document.getElementById('failAttemptedWrap');

  // Derive a readable domain from whatever the user typed
  let domain = err.siteUrl || state.config.siteUrl || '';
  try { domain = new URL(domain.startsWith('http') ? domain : 'https://' + domain).host; } catch {}
  domainEl.textContent = domain || 'your site';

  // Populate the list of URLs we tried, if any
  const attempted = err.attempted || [];
  if (attempted.length) {
    attemptedList.innerHTML = attempted.map(u => `<li><code>${escapeHtml(u)}</code></li>`).join('');
    attemptedWrap.classList.remove('hidden');
  } else {
    attemptedWrap.classList.add('hidden');
  }

  modal.classList.remove('hidden');
  document.getElementById('failBackdrop').classList.remove('hidden');
  track('discovery_failed');
}

function closeFailModal() {
  document.getElementById('failModal').classList.add('hidden');
  document.getElementById('failBackdrop').classList.add('hidden');
}

// ---------- Cluster suggestion (first-run, from slugs) ----------
// On a first-time audit, we don't want to score the user's site against the
// built-in default clusters (Cursor, Lindy, etc) — those are ours, not theirs.
// Instead, after fetching their pages we analyse the slugs, propose clusters
// from the most common tokens, and let them pick before the report builds.

const CLUSTER_STOPWORDS = new Set([
  'the','a','an','and','or','but','for','to','of','in','on','at','by','with',
  'how','what','why','when','where','who','which','is','are','was','were','be',
  'blog','post','posts','article','articles','guide','guides','page','pages',
  'best','top','review','reviews','vs','your','you','our','my','this','that',
  'new','using','use','used','get','getting','make','making','it','from',
  'part','intro','introduction','tips','tutorial','about','into','out',
  // Generic editorial filler — frequent on blog slugs but not real topics
  'built','build','building','journey','business','story','stories','way','ways',
  'thing','things','look','guide','complete','ultimate','essential','simple',
  'easy','quick','need','know','should','can','will','why','really','actually',
  'great','good','better','more','most','every','everything','anything',
]);

// Accepts either fetched posts ({ slug }) or bare URL strings — a slug is
// recoverable from a URL alone, so this can run on the sitemap list before any
// HTML is fetched.
function suggestClustersFromPosts(posts, opts = {}) {
  const minPosts = opts.minPosts || 3;
  const cap = opts.cap || 8;

  // Normalise input to a list of slugs.
  const slugs = [];
  for (const p of posts) {
    const slug = typeof p === 'string' ? extractSlug(p) : (p.slug || '');
    if (slug) slugs.push(slug.toLowerCase());
  }
  const totalDocs = slugs.length;
  if (!totalDocs) return [];

  // Document frequency (how many slugs contain the token) plus a co-occurrence
  // COUNT map: for each token, how many times it shares a slug with each other
  // token. The shape of this distribution is the topical signal — see scoreToken.
  const df = new Map();               // token -> doc count
  const coCounts = new Map();         // token -> Map(otherToken -> co-occur count)
  for (const slug of slugs) {
    const tokens = slug.split(/[^a-z0-9]+/).filter(Boolean);
    const kept = [];
    const seen = new Set();
    for (const t of tokens) {
      if (t.length < 3) continue;
      if (CLUSTER_STOPWORDS.has(t)) continue;
      if (/^\d+$/.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      kept.push(t);
      df.set(t, (df.get(t) || 0) + 1);
    }
    for (const t of kept) {
      let m = coCounts.get(t);
      if (!m) { m = new Map(); coCounts.set(t, m); }
      for (const other of kept) if (other !== t) m.set(other, (m.get(other) || 0) + 1);
    }
  }

  // Collapse singular/plural: merge the plural into the singular, summing counts
  // and unioning co-occurrence sets. Handles simple "+s"/"+es" plurals.
  for (const token of [...df.keys()]) {
    let singular = null;
    if (token.endsWith('es') && df.has(token.slice(0, -2))) singular = token.slice(0, -2);
    else if (token.endsWith('s') && !token.endsWith('ss') && df.has(token.slice(0, -1))) singular = token.slice(0, -1);
    if (singular && singular !== token) {
      df.set(singular, df.get(singular) + df.get(token));
      const a = coCounts.get(singular) || new Map();
      for (const [x, n] of (coCounts.get(token) || [])) a.set(x, (a.get(x) || 0) + n);
      coCounts.set(singular, a);
      df.delete(token);
      coCounts.delete(token);
    }
  }

  // Document-frequency CEILING: a token appearing in more than this share of all
  // slugs is structural boilerplate, not a topic. This is the "inverse document
  // frequency" intuition — the words in the MOST pages are the least
  // distinctive. On a news/finance site this is exactly what kills "daily",
  // "data", "explained", "statistics".
  const ceilingShare = opts.ceilingShare || 0.4;
  const ceilingCount = Math.max(minPosts + 1, Math.ceil(totalDocs * ceilingShare));

  const prettify = (token) => {
    const special = { saas: 'SaaS', seo: 'SEO', api: 'API', ai: 'AI', ui: 'UI', ux: 'UX' };
    if (special[token]) return special[token];
    return token.charAt(0).toUpperCase() + token.slice(1);
  };

  // Distinctiveness score. The key signal is CONCENTRATION of co-occurrence, not
  // breadth. A real topic word repeatedly pairs with the same few partners
  // ("mortgage" keeps appearing with "housing"/"rates"), so a large fraction of
  // its co-occurrences land on its top partners. Boilerplate ("explained",
  // "daily") pairs with a different word almost every time, so its co-occurrence
  // mass is spread thin — no partner accounts for much. We measure the share of a
  // token's total co-occurrences captured by its top few partners: high share =
  // topical, low share = filler.
  const scoreToken = (token, count) => {
    const partners = coCounts.get(token);
    const freqComponent = Math.log2(count + 1);
    if (!partners || partners.size === 0) {
      // No co-occurrences at all (single-token slugs). Fall back to mild
      // frequency weighting; can't assess concentration.
      return freqComponent * 0.5;
    }
    const counts = [...partners.values()].sort((a, b) => b - a);
    const total = counts.reduce((s, n) => s + n, 0);
    const topK = counts.slice(0, 3).reduce((s, n) => s + n, 0);
    const concentration = topK / total; // 0..1, higher = more topical
    // Concentration dominates; frequency is a gentle tiebreaker so that between
    // two equally-topical words the better-populated cluster ranks higher.
    return concentration * (1 + 0.25 * freqComponent);
  };

  const ranked = (threshold) => [...df.entries()]
    .filter(([, n]) => n >= threshold && n <= ceilingCount)
    .map(([token, count]) => [token, count, scoreToken(token, count)])
    .sort((a, b) => b[2] - a[2])
    .slice(0, cap)
    .map(([token, count]) => ({ name: prettify(token), keywords: [token], post_count: count }));

  // Adaptive threshold: editorial sites rarely repeat a token 3+ times, so relax
  // to 2 if the strict pass is thin. The manual field remains the real safety net.
  let out = ranked(minPosts);
  if (out.length < 3) out = ranked(2);
  return out;
}

// Shows the suggestion checklist and resolves with the chosen clusters
// (array of { name, keywords }). Resolves with [] if the user skips.
// Returns a Promise so the audit run can await the user's choice.
function promptClusterSuggestions(suggestions) {
  return new Promise(resolve => {
    const modal = document.getElementById('clusterSuggestModal');
    const backdrop = document.getElementById('clusterSuggestBackdrop');
    const chipWrap = document.getElementById('clusterSuggestChips');
    const input = document.getElementById('clusterSuggestInput');
    const addBtn = document.getElementById('clusterSuggestAdd');
    const confirmBtn = document.getElementById('clusterSuggestConfirm');
    const skipBtn = document.getElementById('clusterSuggestSkip');

    // Live working set of clusters, seeded from suggestions. Each is {name, keywords}.
    // We key by lowercased name to dedupe.
    const chosen = new Map();
    for (const s of suggestions) {
      chosen.set(s.name.toLowerCase(), { name: s.name, keywords: s.keywords });
    }

    function renderChips() {
      if (chosen.size === 0) {
        chipWrap.innerHTML = '<span class="cs-chip-empty">No clusters yet. Add your own below, or skip and define them later.</span>';
      } else {
        chipWrap.innerHTML = [...chosen.values()].map(c => `
          <span class="cs-chip" data-key="${escapeHtml(c.name.toLowerCase())}">
            ${escapeHtml(c.name)}
            <button type="button" class="cs-chip-x" aria-label="Remove ${escapeHtml(c.name)}">&times;</button>
          </span>
        `).join('');
        chipWrap.querySelectorAll('.cs-chip-x').forEach(x => {
          x.addEventListener('click', () => {
            const key = x.closest('.cs-chip').dataset.key;
            chosen.delete(key);
            renderChips();
          });
        });
      }
      // Reflect count on the confirm button
      confirmBtn.textContent = chosen.size
        ? `Use ${chosen.size} cluster${chosen.size === 1 ? '' : 's'}`
        : 'Skip for now';
    }

    // Add comma-separated names from the input as new chips.
    // Each entry becomes a cluster whose keyword is the lowercased name.
    function addFromInput() {
      const raw = input.value.trim();
      if (!raw) return;
      for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
        const key = part.toLowerCase();
        if (!chosen.has(key)) {
          chosen.set(key, { name: part, keywords: [key] });
        }
      }
      input.value = '';
      renderChips();
      input.focus();
    }

    renderChips();
    modal.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    setTimeout(() => input?.focus(), 100);

    const onAdd = () => addFromInput();
    const onKey = (e) => {
      // Enter or comma commits the current input
      if (e.key === 'Enter') { e.preventDefault(); addFromInput(); }
    };
    const cleanup = () => {
      modal.classList.add('hidden');
      backdrop.classList.add('hidden');
      addBtn.removeEventListener('click', onAdd);
      input.removeEventListener('keydown', onKey);
      confirmBtn.removeEventListener('click', onConfirm);
      skipBtn.removeEventListener('click', onSkip);
    };
    const onConfirm = () => {
      // Fold any uncommitted text in the input before resolving
      addFromInput();
      const result = [...chosen.values()].map(c => ({ name: c.name, keywords: c.keywords }));
      cleanup();
      resolve(result);
    };
    const onSkip = () => { cleanup(); resolve([]); };

    addBtn.addEventListener('click', onAdd);
    input.addEventListener('keydown', onKey);
    confirmBtn.addEventListener('click', onConfirm);
    skipBtn.addEventListener('click', onSkip);
  });
}

// Progress overlay: a single visible place for run progress, independent of
// which button started the audit (the masthead button is hidden during the
// landing-page hero flow, so its label updates were invisible — this fixes that).
function showProgress(msg) {
  const ov = document.getElementById('progressOverlay');
  if (ov) ov.classList.remove('hidden');
  setProgress(msg || 'Starting...');
}
function setProgress(msg) {
  const txt = document.getElementById('progressText');
  if (txt) txt.textContent = msg;
  // Keep updating the button label too, for the post-audit (masthead-visible) flow
  const btn = document.getElementById('runAuditBtn');
  const label = btn && btn.querySelector('.btn-label');
  if (label) label.textContent = msg;
  // If the message carries an "X of Y" count, drive the bar
  const m = /(\d+)\s+of\s+(\d+)/.exec(msg || '');
  const bar = document.getElementById('progressBar');
  if (bar) {
    if (m) {
      const pct = Math.max(0, Math.min(100, (parseInt(m[1], 10) / parseInt(m[2], 10)) * 100));
      bar.style.width = pct.toFixed(1) + '%';
      bar.classList.remove('indeterminate');
    } else {
      // No count yet (discovery, sitemap parse, building) — show indeterminate motion
      bar.classList.add('indeterminate');
      bar.style.width = '40%';
    }
  }
}
function hideProgress() {
  const ov = document.getElementById('progressOverlay');
  if (ov) ov.classList.add('hidden');
  const bar = document.getElementById('progressBar');
  if (bar) { bar.style.width = '0%'; bar.classList.remove('indeterminate'); }
}

// The actual audit runner — same as before but pulled out so the confirm flow can call it
async function actualRunAudit() {
  const cfg = state.config;

  // Validate config based on source (Ghost still needs validation here)
  if (cfg.source === 'ghost') {
    if (!cfg.ghostUrl || !cfg.apiKey) {
      toast('Add your Ghost URL and API key in Settings first.', 'error');
      openDrawer();
      return;
    }
  } else if (cfg.source === 'sitemap') {
    if (!cfg.sitemapUrl) {
      toast('Add your sitemap URL in Settings first.', 'error');
      openDrawer();
      return;
    }
  }

  const btn = document.getElementById('runAuditBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  track('audit_run');
  showProgress('Fetching your site...');

  try {
    let posts, derivedSiteUrl, sitemapUrlForConfig;

    // First-run flag: suggest clusters from the user's own slugs only if this
    // browser has never completed an audit AND they're still on default clusters.
    let firstRun = false;
    try { firstRun = localStorage.getItem(STORAGE_KEYS.hasAudited) !== '1'; } catch (e) {}
    const onDefaultClusters =
      JSON.stringify(state.clusters.map(c => c.name)) ===
      JSON.stringify(DEFAULT_CLUSTERS.map(c => c.name));
    const wantSuggestions = firstRun && onDefaultClusters;

    if (cfg.source === 'ghost') {
      posts = await fetchAllPosts(
        cfg.ghostUrl,
        cfg.apiKey,
        msg => setProgress(msg)
      );
      derivedSiteUrl = cfg.ghostUrl;

      // Ghost has no pre-fetch URL list, so suggestions still run post-fetch here.
      if (wantSuggestions) {
        const suggestions = suggestClustersFromPosts(posts);
        if (suggestions.length) {
          hideProgress();
          const chosen = await promptClusterSuggestions(suggestions);
          state.clusters = chosen;
          saveClusters();
          showProgress('Building report...');
        }
      }
    } else {
      // Sitemap-based sources: resolve the URL list FIRST (cheap), so we can both
      // (a) suggest clusters from slugs before the long page fetch, and
      // (b) know the total up front to drive the streaming handoff.
      sitemapUrlForConfig = cfg.resolvedSitemapUrl || cfg.sitemapUrl;
      const sitemapConfig = {
        ...cfg,
        sitemapUrl: sitemapUrlForConfig,
        excludePatterns: cfg.excludePatterns || (PLATFORM_DEFAULTS[cfg.source]?.excludePatterns ?? ''),
      };

      setProgress('Reading your sitemap...');
      const urls = await resolveSitemapUrls(sitemapConfig, msg => setProgress(msg));
      if (!urls.length) throw new Error('No URLs found in the sitemap. Check your settings.');

      // Corrected, pre-fetch cluster suggestion (runs on slugs from the URL list).
      if (wantSuggestions) {
        const suggestions = suggestClustersFromPosts(urls);
        if (suggestions.length) {
          hideProgress();
          const chosen = await promptClusterSuggestions(suggestions);
          state.clusters = chosen;
          saveClusters();
        }
      }

      // Fetch pages. On large sites, hand off to the streaming dashboard at 25%
      // (floored at 500 pages); small sites keep the modal to completion.
      const total = urls.length;
      const streaming = shouldStream(total);
      const thresholdCount = streaming ? streamThresholdFor(total) : 0;

      if (streaming) showProgress('Fetching pages...');
      else showProgress('Fetching your site...');

      posts = await fetchPagesForUrls(urls, {
        onProgress: msg => setProgress(msg),
        thresholdCount,
        onThreshold: streaming ? (t => beginStreamingDashboard(t)) : null,
        onPage: streaming ? (p => streamRow(p)) : null,
      });

      derivedSiteUrl = (() => {
        if (posts.length) {
          try { const u = new URL(posts[0].url); return `${u.protocol}//${u.host}`; } catch {}
        }
        try { const u = new URL(sitemapUrlForConfig); return `${u.protocol}//${u.host}`; } catch {}
        return sitemapUrlForConfig;
      })();
    }

    if (!posts.length) {
      throw new Error('No posts/pages were fetched. Check your settings.');
    }

    // Build the full report once — graph-level aggregates are correct only now.
    if (STREAM.active) updateStreamPill(posts.length, STREAM.total);
    setProgress('Building report...');
    const previous = state.snapshots[0] || null;
    const previousSnapshot = previous ? { posts: previous.posts_summary || [] } : null;
    const audit = runAuditBuild(derivedSiteUrl, posts, previousSnapshot);
    state.audit = audit;
    saveAudit();

    const newSnapshot = {
      generated: audit.generated,
      stats: audit.stats,
      posts_summary: audit.items.map(i => ({ path: i.path, inbound: i.inbound, outbound: i.outbound })),
    };
    state.snapshots.unshift(newSnapshot);
    state.snapshots = state.snapshots.slice(0, MAX_SNAPSHOTS);
    saveSnapshots();

    endStreaming();       // tear down streaming state before the final render
    render();             // swaps skeletons for real aggregates + real rows
    toast(`Audit complete. ${audit.stats.total_links} internal links across ${audit.stats.post_count} posts.`, 'success');
    track('audit_completed');
    // Repeat-audit signal: if the browser had completed an audit before this one,
    // also fire repeat_audit. Check the flag BEFORE setting it so the first audit
    // isn't counted as a repeat. No identifier transmitted — categorical only.
    try {
      const hadAuditedBefore = localStorage.getItem(STORAGE_KEYS.hasAudited) === '1';
      if (hadAuditedBefore) {
        track('repeat_audit');
      } else {
        localStorage.setItem(STORAGE_KEYS.hasAudited, '1');
      }
    } catch (e) { /* localStorage blocked, no-op */ }
    document.getElementById('landingPage')?.classList.add('hidden');
  } catch (e) {
    console.error(e);
    endStreaming();
    // If we'd already revealed the streaming dashboard, drop back to a clean
    // state rather than leaving skeletons stranded on screen.
    if (!state.audit) {
      document.getElementById('dashboard')?.classList.add('hidden');
      document.getElementById('postsSection')?.classList.add('hidden');
    }
    toast('Audit failed: ' + e.message, 'error');
  } finally {
    hideProgress();
    endStreaming();
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Run audit';
  }
}

// ---------- Data export/import ----------

function exportData() {
  const payload = {
    exported_at: new Date().toISOString(),
    config: state.config,
    clusters: state.clusters,
    snapshots: state.snapshots,
    audit: state.audit,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `link-audit-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Exported.', 'success');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.config) state.config = data.config;
      if (data.clusters) state.clusters = data.clusters;
      if (data.snapshots) state.snapshots = data.snapshots;
      if (data.audit) state.audit = data.audit;
      saveConfig(); saveClusters(); saveSnapshots(); saveAudit();
      populateDrawer();
      render();
      toast('Import successful.', 'success');
    } catch (err) {
      toast('Import failed: invalid file.', 'error');
    }
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (!confirm('Clear all stored data? This removes your settings, clusters, audit history, and snapshots.')) return;
  localStorage.removeItem(STORAGE_KEYS.config);
  localStorage.removeItem(STORAGE_KEYS.clusters);
  localStorage.removeItem(STORAGE_KEYS.snapshots);
  localStorage.removeItem(STORAGE_KEYS.currentAudit);
  localStorage.removeItem(STORAGE_KEYS.hasAudited);
  state.config = {
    source: 'autodetect',
    siteUrl: '',
    apiKey: '',
    ghostUrl: '',
    sitemapUrl: '',
    includePatterns: '',
    excludePatterns: '',
    resolvedSitemapUrl: '',
  };
  state.clusters = [...DEFAULT_CLUSTERS];
  state.snapshots = [];
  state.audit = null;
  // Reset the landing-tracked flag so the user lands cleanly back on the
  // first-visit experience rather than a half-configured state.
  state._landingTracked = false;
  // Close the drawer and send them home — render() will show the landing page
  // now that audit is null and config is empty.
  closeDrawer();
  populateDrawer();
  render();
  toast('All data cleared.', 'success');
}

// ---------- Init ----------

// Clusterscore is a single-page app: the only real route is "/". The host's
// catch-all serves index.html for every path, so without this an unknown URL
// like /random-fake-url would silently render the landing page (looking like a
// real 200 page and creating duplicate content). Here we detect non-root paths
// and show an explicit "not found" state instead. NOTE: this fixes the visible
// CONTENT only — the HTTP status is still 200 unless the host is configured to
// return 404 for unknown paths (see the Cloudflare Pages notes).
function isKnownRoute() {
  const p = window.location.pathname;
  // Root, or root with index.html, are the legitimate app entry points.
  if (p === '/' || p === '' || p === '/index.html') return true;
  return false;
}

function init() {
  loadFromStorage();

  // Unknown route → render 404 state and stop wiring the app.
  if (!isKnownRoute()) {
    renderNotFound();
    return;
  }

  // Wire up events
  document.getElementById('runAuditBtn').addEventListener('click', runAudit);
  document.getElementById('trendRerunBtn')?.addEventListener('click', runAudit);
  document.getElementById('settingsBtn').addEventListener('click', openDrawer);
  document.getElementById('emptyStateConfigBtn').addEventListener('click', openDrawer);
  document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
  document.getElementById('editClustersBtn').addEventListener('click', openDrawer);
  // Hero URL form: the primary entry point from the landing page.
  // Submitting fires audit_started + sets autodetect source, then runs runAudit()
  // which kicks off discovery and shows the confirmation modal.
  document.getElementById('heroAuditForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = document.getElementById('heroUrlInput').value.trim();
    if (!url) {
      document.getElementById('heroUrlInput').focus();
      return;
    }
    track('audit_started');
    state.config.source = 'autodetect';
    state.config.siteUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    // New URL invalidates any previously-resolved sitemap
    state.config.resolvedSitemapUrl = '';
    saveConfig();
    runAudit();
  });

  // "Use a different source" — opens the drawer for power users
  document.getElementById('heroAdvancedLink')?.addEventListener('click', () => {
    track('audit_started');
    openDrawer();
  });

  // Footer "Audit my site" link scrolls back up and focuses the hero input
  document.getElementById('landingStartBtnFooter')?.addEventListener('click', (e) => {
    e.preventDefault();
    const input = document.getElementById('heroUrlInput');
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => input?.focus(), 400);
  });

  // WAF newsletter signup form
  document.getElementById('wafNewsletterForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('wafNewsletterEmail').value.trim();
    if (!email) return;
    submitNewsletterSignup(email);
  });

  document.getElementById('saveSettingsBtn').addEventListener('click', () => {
    const sourceRadio = document.querySelector('input[name="source"]:checked');
    state.config.source = sourceRadio ? sourceRadio.value : 'autodetect';
    state.config.siteUrl = document.getElementById('siteUrlInput').value.trim();
    state.config.ghostUrl = document.getElementById('ghostUrlInput').value.trim();
    state.config.apiKey = document.getElementById('apiKeyInput').value.trim();
    state.config.sitemapUrl = document.getElementById('sitemapUrlInput').value.trim();
    state.config.includePatterns = document.getElementById('includePatternsInput').value.trim();
    state.config.excludePatterns = document.getElementById('excludePatternsInput').value.trim();

    // Clear cached resolved sitemap whenever config changes - force rediscovery
    state.config.resolvedSitemapUrl = '';

    for (const k of ['siteUrl', 'ghostUrl', 'sitemapUrl']) {
      if (state.config[k] && !/^https?:\/\//i.test(state.config[k])) {
        state.config[k] = 'https://' + state.config[k];
      }
    }
    saveConfig();
    saveClusters();

    // Was the user mid-onboarding (no audit yet) when they saved?
    // If so, treat the save as "go, run the audit now" — they came from the landing CTA.
    const onboarding = !state.audit;

    document.getElementById('runAuditBtn').disabled = !isConfigReady();
    closeDrawer();
    render();
    toast('Settings saved.', 'success');
    if (isConfigReady()) {
      track('settings_saved');
      // Auto-run audit if this looks like first-time setup
      if (onboarding) {
        // Small delay so the toast appears and the drawer-close animation completes
        setTimeout(() => runAudit(), 250);
      }
    }
  });

  document.querySelectorAll('input[name="source"]').forEach(r => {
    r.addEventListener('change', e => updateSourceVisibility(e.target.value));
  });

  document.getElementById('addClusterBtn').addEventListener('click', () => {
    state.clusters.push({ name: '', keywords: [] });
    renderClusterEditor();
    // Focus the name field of the new row so the user can type immediately
    const rows = document.querySelectorAll('#clusterEditor .cluster-row');
    const lastRow = rows[rows.length - 1];
    lastRow?.querySelector('[data-field="name"]')?.focus();
  });

  document.getElementById('deleteAllClustersBtn').addEventListener('click', () => {
    if (state.clusters.length === 0) {
      toast('No clusters to delete.', '');
      return;
    }
    const count = state.clusters.length;
    const ok = confirm(`Delete all ${count} cluster${count === 1 ? '' : 's'}? This can't be undone.`);
    if (ok) {
      state.clusters = [];
      renderClusterEditor();
      toast('All clusters deleted.', 'success');
    }
  });

  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) importData(file);
    e.target.value = '';
  });
  document.getElementById('clearBtn').addEventListener('click', clearAllData);

  // Confirmation modal
  // Wrap closeConfirmModal in arrow functions so the event object isn't passed
  // as wasDismissed (which would still be truthy, but cleaner this way).
  document.getElementById('confirmCloseBtn')?.addEventListener('click', () => closeConfirmModal(true));
  document.getElementById('confirmBackdrop')?.addEventListener('click', () => closeConfirmModal(true));
  document.getElementById('confirmEditBtn')?.addEventListener('click', () => {
    closeConfirmModal(true);
    openDrawer();
  });
  document.getElementById('confirmRunBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('confirmModal');
    const sitemapUrl = modal.dataset.sitemapUrl;
    if (sitemapUrl) {
      state.config.resolvedSitemapUrl = sitemapUrl;
      saveConfig();
    }
    // Not a dismissal — user accepted the suggestion and proceeded
    closeConfirmModal(false);
    actualRunAudit();
  });

  // Failure modal
  document.getElementById('failCloseBtn')?.addEventListener('click', closeFailModal);
  document.getElementById('failBackdrop')?.addEventListener('click', closeFailModal);
  document.getElementById('failCancelBtn')?.addEventListener('click', closeFailModal);
  document.getElementById('failManualBtn')?.addEventListener('click', () => {
    // Switch to manual sitemap mode and open settings so the user can paste their URL
    state.config.source = 'sitemap';
    saveConfig();
    closeFailModal();
    openDrawer();
    // Scroll to the sitemap field once the drawer is open
    setTimeout(() => {
      document.getElementById('sitemapUrlInput')?.focus();
    }, 150);
  });

  // History / progress modal close handlers
  document.getElementById('historyCloseBtn')?.addEventListener('click', closeHistoryModal);
  document.getElementById('historyBackdrop')?.addEventListener('click', closeHistoryModal);

  document.getElementById('search').addEventListener('input', e => {
    state.search = e.target.value;
    renderPostsTable();
  });

  document.querySelectorAll('.filter-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.filter = b.dataset.filter;
      renderPostsTable();
    });
  });

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.dir = (key === 'title' || key === 'path') ? 'asc' : 'desc';
      }
      renderPostsTable();
    });
  });

  // Enable run button if config exists
  document.getElementById('runAuditBtn').disabled = !isConfigReady();

  setupInfoIcons();
  render();
}

// Delegated tooltip handling for info icons. CSS handles hover on desktop;
// this code handles taps so mobile users can see definitions too.
function setupInfoIcons() {
  document.addEventListener('click', (e) => {
    const icon = e.target.closest('.info-icon');
    if (icon) {
      // Don't let icon clicks bubble — they shouldn't trigger parent links
      // (e.g. the wrapping <a> on clickable action queue items).
      e.preventDefault();
      e.stopPropagation();
      // Close any other open tooltips
      document.querySelectorAll('.info-icon.is-open').forEach(el => {
        if (el !== icon) el.classList.remove('is-open');
      });
      icon.classList.toggle('is-open');
      return;
    }
    // Tap outside any open tooltip closes them all
    document.querySelectorAll('.info-icon.is-open').forEach(el => el.classList.remove('is-open'));
  });
}

// Renders an explicit 404 state for unknown routes. Hides every app section and
// shows a simple not-found panel with a link back to the real app root.
function renderNotFound() {
  const hide = id => document.getElementById(id)?.classList.add('hidden');
  ['landingPage','emptyState','dashboard','postsSection','wafPromo','masthead','appFooter'].forEach(hide);

  let nf = document.getElementById('notFound');
  if (!nf) {
    nf = document.createElement('section');
    nf.id = 'notFound';
    nf.className = 'not-found';
    nf.innerHTML = `
      <div class="not-found-inner">
        <div class="not-found-code">404</div>
        <h1 class="not-found-title">Page not found</h1>
        <p class="not-found-lede">That page doesn't exist on Clusterscore. Head back to run an internal link audit.</p>
        <a class="btn btn-primary btn-large" href="/">Go to Clusterscore →</a>
      </div>`;
    document.body.appendChild(nf);
  }
  nf.classList.remove('hidden');
  // Reflect the not-found state in the document title for clarity/analytics.
  try { document.title = 'Page not found · Clusterscore'; } catch (e) {}
}

function isConfigReady() {
  const c = state.config;
  if (c.source === 'ghost') return !!(c.ghostUrl && c.apiKey);
  if (c.source === 'sitemap') return !!c.sitemapUrl;
  if (c.source === 'autodetect' || c.source === 'wordpress' || c.source === 'webflow') {
    return !!c.siteUrl;
  }
  return false;
}

document.addEventListener('DOMContentLoaded', init);
