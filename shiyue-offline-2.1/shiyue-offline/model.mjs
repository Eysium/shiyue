export const idOf = (id) => /^[1-9]\d{0,24}$/.test(String(id ?? '')) ? String(id) : '';
export const workUrl = (id) => `https://www.pixiv.net/novel/show.php?id=${idOf(id)}`;
export function novelIdFrom(value) {
  const text = String(value ?? '').trim();
  if (idOf(text)) return idOf(text);
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return '';
    if (url.hostname === 'www.pixiv.net' && url.pathname === '/novel/show.php') return idOf(url.searchParams.get('id'));
    if (url.hostname === 'pixiv.net' && url.pathname === '/novel/show.php') return idOf(url.searchParams.get('id'));
  } catch { /* The field accepts only an ID or a Pixiv novel URL. */ }
  return '';
}
export const authorUrl = (id) => `https://www.pixiv.net/users/${idOf(id)}`;
export const norm = (text) => String(text ?? '').normalize('NFKC').toLowerCase().trim();
export const textOf = (text, max = 1000) => typeof text === 'string' ? text.trim().slice(0, max) : '';
export const levels = ['S', 'A', 'B', 'C', 'D'];
export const statuses = { unread: '待读', reading: '阅读中', finished: '已读' };
export const tagSources = { tags: 'Pixiv 原标签', bookmarkTags: 'Pixiv 收藏标签', labels: '拾页私有标签' };
export const seriesKey = (row) => row.seriesId || (row.series ? `${row.authorId || norm(row.author)}:${norm(row.series)}` : '');
export const seriesUrl = (id) => `https://www.pixiv.net/novel/series/${idOf(id)}`;
export const bilingualTitle = (row) => row.zh && row.zh !== row.title ? `${row.title} ｜ ${row.zh}` : row.title;
export const isHiddenTag = (hidden, source, name) => hidden?.[source]?.includes(norm(name)) ?? false;

export function catalogTags(rows) {
  const index = Object.fromEntries(Object.keys(tagSources).map((source) => [source, new Map()]));
  for (const row of rows) for (const [source, counts] of Object.entries(index)) {
    const seen = new Set();
    for (const name of row[source]) {
      const key = norm(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const item = counts.get(key);
      if (item) item.count++;
      else counts.set(key, { name, count: 1 });
    }
  }
  return Object.fromEntries(Object.entries(index).map(([source, counts]) => [source, [...counts.values()]]));
}

export function catalogAuthors(rows) {
  const authors = new Map();
  for (const row of rows) {
    if (!row.authorId) continue;
    let entry = authors.get(row.authorId);
    if (!entry) authors.set(row.authorId, entry = { id: row.authorId, count: 0, repos: 0, finished: 0, name: '', touched: -1 });
    entry.count++;
    entry.repos += Boolean(row.repo);
    entry.finished += row.status === 'finished';
    if (row.author && (row.touched ?? 0) >= entry.touched) {
      entry.name = row.author;
      entry.touched = row.touched ?? 0;
    }
  }
  return authors;
}

export function readTags(value, depth = 0) {
  if (Array.isArray(value)) {
    const tags = [...new Set(value.slice(0, 100).map((item) => textOf(item, 120) || textOf(item?.tag, 120) || textOf(item?.name, 120)).filter(Boolean))];
    return tags.length || !value.length ? tags : undefined;
  }
  if (value && typeof value === 'object' && depth < 3) return readTags(value.tags, depth + 1) ?? readTags(value.tagList, depth + 1);
}

export function availableTitles(rows, ids) {
  const scope = new Set(ids);
  return rows.filter((row) => scope.has(row.id) && !row.zh).map(({ id, title }) => ({ id, title }));
}

export function cleanNovel(raw) {
  const id = idOf(raw?.id ?? raw?.novelId ?? raw?.workId);
  const title = textOf(raw?.title ?? raw?.originalTitle);
  if (!id || !title) return null;
  return { id, title, author: textOf(raw.author ?? raw.userName, 300), authorId: idOf(raw.authorId ?? raw.userId),
    series: textOf(raw.series ?? raw.seriesTitle, 400), seriesId: idOf(raw.seriesId), seriesOrder: idOf(raw.seriesOrder),
    tags: readTags(raw.tags) ?? readTags(raw.tagList), bookmarkTags: readTags(raw.bookmarkTags),
    visibility: ['public', 'private'].includes(raw.visibility) ? raw.visibility : '' };
}

export function applyImport(state, incoming) {
  const input = Array.isArray(incoming) ? incoming : incoming?.rows ?? incoming?.novels;
  if (!Array.isArray(input) || input.length > 20000) throw new Error('请选择包含作品列表的 JSON（每次最多 20,000 篇）。');
  const fresh = new Map();
  for (const raw of input) {
    const clean = cleanNovel(raw);
    if (clean) fresh.set(clean.id, { clean, raw });
  }
  if (!fresh.size) throw new Error('未找到可导入的作品。每条至少需要作品 ID 和原文标题。');
  const byId = new Map(state.rows.map((row) => [row.id, row]));
  const counts = { added: 0, updated: 0, unchanged: 0, skipped: input.length - fresh.size };
  for (const [id, { clean, raw }] of fresh) {
    const previous = byId.get(id);
    if (!previous) {
      const now = Date.now();
      state.rows.push({ ...clean, tags: clean.tags ?? [], bookmarkTags: clean.bookmarkTags ?? [], zh: textOf(raw.zh), repo: textOf(raw.repo, 24000), score: 0, level: '',
        status: 'unread', folders: [], labels: [], favorite: false, added: now, touched: now, rev: 1 });
      counts.added++;
      continue;
    }
    const metadata = { ...clean };
    for (const key of ['author', 'authorId', 'series', 'seriesId', 'seriesOrder', 'visibility']) if (!metadata[key]) delete metadata[key];
    for (const key of ['tags', 'bookmarkTags']) {
      if (metadata[key] === undefined) delete metadata[key];
      else if (incoming?.tagMode === 'merge') {
        const tags = new Map((previous[key] ?? []).map((name) => [norm(name), name]));
        for (const name of metadata[key]) tags.set(norm(name), name);
        metadata[key] = [...tags.values()].slice(0, 100);
      }
    }
    if (Object.keys(metadata).every((key) => JSON.stringify(metadata[key]) === JSON.stringify(previous[key]))) {
      counts.unchanged++;
      continue;
    }
    Object.assign(previous, metadata, { touched: Date.now(), rev: previous.rev + 1 });
    counts.updated++;
  }
  return counts;
}

export function filterRows(rows, { query = '', tag = '', tagSource = '', hiddenTags, authorId = '', series = '', folder = '', level = '', status = '', favorite = false, repo = false, noRepo = false, untranslated = false } = {}) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if ((folder && !row.folders.includes(folder)) || (level && row.level !== level) || (status && row.status !== status) ||
        (favorite && !row.favorite) || (repo && !row.repo) || (noRepo && row.repo) || (untranslated && row.zh) ||
        (authorId && row.authorId !== authorId) || (series && seriesKey(row) !== series)) return false;
    if (!tag && !terms.length) return true;
    const shownTags = (source) => row[source].filter((name) => !isHiddenTag(hiddenTags, source, name));
    const tags = Object.keys(tagSources).flatMap(shownTags);
    const exactTags = Object.hasOwn(tagSources, tagSource) ? shownTags(tagSource) : tags;
    if (tag && !exactTags.some((name) => norm(name) === norm(tag))) return false;
    if (!terms.length) return true;
    const index = norm([row.title, row.zh, row.author, row.id, row.authorId, row.series, row.repo, ...tags].join('\n'));
    return terms.every((term) => index.includes(term));
  });
}

export function shareRow(row, hiddenTags) {
  return { id: row.id, title: row.title, zh: row.zh, author: row.author, authorId: row.authorId,
    repo: row.repo, tags: row.tags.filter((name) => !isHiddenTag(hiddenTags, 'tags', name)), score: row.score, level: row.level, url: workUrl(row.id) };
}

export function formatExport(rows, format, hiddenTags) {
  const records = rows.map((row) => shareRow(row, hiddenTags));
  if (format === 'json') return JSON.stringify({ version: 1, rows: records }, null, 2);
  if (format === 'html') {
    const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const entries = records.map((row) => `<article><h2>${esc(bilingualTitle(row))}</h2><p>${esc(row.author || '作者未知')}${row.authorId ? ` · 作者 #${esc(row.authorId)}` : ''} · 作品 #${esc(row.id)}${row.score ? ` · ${row.score}/5` : ''}${row.level ? ` · ${esc(row.level)} 级` : ''}</p><a href="${esc(row.url)}" rel="noreferrer">打开 Pixiv 原作</a>${row.tags.length ? `<p>${esc(row.tags.join(' / '))}</p>` : ''}${row.repo ? `<div class="repo">${esc(row.repo)}</div>` : ''}</article>`).join('');
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>拾页 · 小说安利</title><style>html{color-scheme:light dark}body{margin:0;font:16px/1.65 system-ui}main{max-width:760px;margin:auto;padding:24px}h1{font-size:1.65rem}h2{font-size:1.1rem;margin:0}p{margin:.4em 0}article{padding:18px 0;border-top:1px solid GrayText;overflow-wrap:anywhere}.repo{white-space:pre-wrap;margin-top:.75em}a{text-underline-offset:3px}</style><main><h1>拾页 · 小说安利</h1>${entries}</main></html>`;
  }
  const md = format === 'md';
  const safe = (value = '') => md ? value.replace(/[\\[\]<>*_`~#]/g, '\\$&').replace(/[\r\n]+/g, ' ') : value;
  return records.map((row) => {
    const heading = row.zh || row.title;
    const lines = [md ? `## [${safe(heading)}](${row.url})` : heading,
      `原文标题：${safe(row.title)}`, `中文标题：${row.zh ? safe(row.zh) : '未翻译'}`,
      `作品 ID：${row.id}`, `作者：${safe(row.author) || '未知'}${row.authorId ? `（ID：${row.authorId}）` : ''}`];
    if (!md) lines.push(`作品链接：${row.url}`);
    if (row.score || row.level) lines.push(`评分：${[row.score && `${row.score}/5`, row.level && `${row.level} 级`].filter(Boolean).join(' · ')}`);
    if (row.tags.length) lines.push(`作品标签：${row.tags.map(safe).join(' / ')}`);
    if (row.repo) lines.push('', md ? '### Repo' : 'Repo：', row.repo);
    return lines.join('\n');
  }).join(md ? '\n\n---\n\n' : '\n\n────────────────\n\n') + '\n';
}
