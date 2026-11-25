// ==UserScript==
// @name         拾页 · Pixiv 手机工具
// @namespace    https://eysium.github.io/shiyue/
// @version      1.0.0
// @description  在 Via 读取并导出 Pixiv 小说资料，预览后追加收藏标签。
// @match        https://www.pixiv.net/*
// @include      https://www.pixiv.net/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
'use strict';
if (location.origin !== 'https://www.pixiv.net' || window !== window.top || document.documentElement.hasAttribute('data-shiyue-via')) return;
document.documentElement.setAttribute('data-shiyue-via', '');
let pixivNovelTags, collectPixivNovels;
(() => {
  'use strict';

  // Loaded in an isolated extension world on the user's own Pixiv bookmarks page.
  const origin = 'https://www.pixiv.net';
  const listSize = 24;
  const batchSize = 20;
  const maxSourceTags = 5;
  const toolTagLimit = 10;
  const numericId = (value) => /^\d+$/.test(String(value ?? ''));
  const isTagArray = (value) => Array.isArray(value) && value.every((tag) => typeof tag === 'string');
  const tagKey = (tag) => tag.trim().normalize('NFC').toLowerCase();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function pageAccountId(pageLocation = location) {
    if (pageLocation.origin !== origin) return null;
    return pageLocation.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?users\/(\d+)\/bookmarks\/novels\/?$/i)?.[1] ?? null;
  }

  function readConfig(page) {
    const states = [];
    for (const selector of ['meta#meta-global-data', 'meta#init-config', 'meta[name="global-data"]', 'meta[name="init-config"]']) {
      const content = page.querySelector(selector)?.content;
      if (!content) continue;
      try { states.push(JSON.parse(content)); } catch { /* Try the next page configuration. */ }
    }
    const next = page.querySelector('#__NEXT_DATA__')?.textContent;
    if (next) {
      try {
        const props = JSON.parse(next).props?.pageProps;
        const serialized = props?.serverSerializedPreloadedState;
        states.push(props, typeof serialized === 'string' ? JSON.parse(serialized) : serialized);
      } catch { /* Legacy configuration may still be available. */ }
    }
    let token;
    let id;
    for (const state of states) {
      const self = state?.userData?.self;
      const apiSelf = state?.api?.userData?.self;
      id ??= [state?.['pixiv.user.id'], self?.id, self?.userId, apiSelf?.id, apiSelf?.userId, state?.userData?.id, state?.userData?.userId].find(numericId);
      token ??= [state?.['pixiv.context.postKey'], state?.api?.token, state?.token].find((value) => typeof value === 'string' && /^[a-z0-9_-]{24,256}$/i.test(value));
    }
    return { id, token };
  }

  function checkAccount(expectedId, config) {
    if (pageAccountId() !== expectedId || numericId(config.id) && String(config.id) !== expectedId) {
      throw new Error('请打开当前登录账号自己的小说收藏页。');
    }
  }

  async function readWriteToken(accountId) {
    let config = readConfig(document);
    checkAccount(accountId, config);
    if (!config.token || !config.id) {
      const response = await fetch(new URL('/', origin), {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`无法检查 Pixiv 登录状态（HTTP ${response.status}）。`);
      const template = document.createElement('template');
      const markup = await response.text();
      // Read just the inert initialization elements, without inserting page content into the live DOM.
      const configs = markup.match(/<meta\b[^>]*(?:meta-global-data|init-config|global-data)[^>]*>|<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>[\s\S]*?<\/script>/gi);
      if (configs?.length) {
        template.innerHTML = configs.join('');
        config = readConfig(template.content);
      }
    }
    checkAccount(accountId, config);
    if (!config.token || String(config.id) !== accountId) throw new Error('无法从 Pixiv 页面确认当前登录的账号。请在 Pixiv 登录后刷新自己的收藏页。');
    return config.token;
  }

  async function request(path, options = {}) {
    const response = await fetch(new URL(path, origin), {
      ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (response.status === 429) throw new Error('Pixiv 暂时限制了请求频率。请稍后重新扫描，再继续。');
    if ([401, 403].includes(response.status)) throw new Error('Pixiv 拒绝了请求。请检查是否仍已登录，再刷新收藏页。');
    if (!response.ok) throw new Error(`Pixiv 返回 HTTP ${response.status}。`);
    const reply = await response.json();
    if (reply?.error !== false) {
      const detail = typeof reply?.message === 'string' ? ` ${reply.message.slice(0, 180)}` : '';
      throw new Error(`Pixiv 没有确认请求。${detail}`);
    }
    return reply.body;
  }

  async function scan(accountId, onProgress, stopped = () => false, recent = Infinity, scope = 'hide') {
    checkAccount(accountId, readConfig(document));
    if (!['show', 'hide'].includes(scope)) throw new Error('请选择有效的收藏范围。');
    if (recent !== Infinity && (!Number.isSafeInteger(recent) || recent < 1)) throw new Error('请输入大于 0 的整数篇数。');
    const list = new Map();
    const bookmarkOwners = new Map();
    const ambiguous = new Set();
    let total = null;
    let scanned = 0;
    let skipped = 0;
    let duplicates = 0;
    while (total === null || scanned < Math.min(total, recent)) {
      if (stopped()) return null;
      const query = new URLSearchParams({ tag: '', offset: String(scanned), limit: String(Math.min(listSize, recent - scanned)), rest: scope, lang: 'zh' });
      const page = await request(`/ajax/user/${accountId}/novels/bookmarks?${query}`);
      if (stopped()) return null;
      if (!Number.isSafeInteger(page?.total) || page.total < 0 || !Array.isArray(page.works)) {
        throw new Error('Pixiv 返回的小说收藏列表格式有变化。');
      }
      total ??= page.total;
      if (total !== page.total || scanned + page.works.length > total || scanned < total && !page.works.length) {
        throw new Error('扫描过程中收藏列表发生变化。请重新扫描。');
      }
      if (page.works.length && (!page.bookmarkTags || typeof page.bookmarkTags !== 'object')) {
        throw new Error('Pixiv 没有返回已有收藏标签，无法生成可靠的预览。');
      }
      const works = page.works.slice(0, recent - scanned);
      const novelKeys = new Set(page.works.map((work) => String(work?.id)));
      const bookmarkKeys = new Set(page.works.map((work) => String(work?.bookmarkData?.id)));
      const keys = Object.keys(page.bookmarkTags ?? {});
      const byNovel = keys.some((key) => novelKeys.has(key) && !bookmarkKeys.has(key)) &&
        !keys.some((key) => bookmarkKeys.has(key) && !novelKeys.has(key));
      for (const work of works) {
        const id = String(work?.bookmarkData?.id);
        const novelId = String(work?.id);
        const original = page.bookmarkTags[byNovel ? novelId : id] ?? [];
        if (!numericId(id) || id === '0' || !numericId(novelId) || novelId === '0' || work.bookmarkData.private !== (scope === 'hide') || work.isMasked || !work.title || /^[-—]{3,}$/.test(work.title) || !isTagArray(original)) {
          skipped++;
          continue;
        }
        const previous = list.get(novelId);
        const owner = bookmarkOwners.get(id);
        if (owner && owner !== novelId) {
          ambiguous.add(owner);
          ambiguous.add(novelId);
        }
        bookmarkOwners.set(id, novelId);
        if (previous) {
          duplicates++;
          if (previous.id !== id) ambiguous.add(novelId);
          else previous.original = [...new Set([...previous.original, ...original])];
          continue;
        }
        list.set(novelId, { id, novelId, title: work.title || `小说 ${novelId}`, original, source: (Array.isArray(work.tags) ? work.tags : []).map((tag) => typeof tag === 'string' ? tag : tag?.tag ?? tag?.name).filter((tag) => typeof tag === 'string') });
      }
      scanned += works.length;
      onProgress(scanned, Math.min(total, recent));
      if (scanned < Math.min(total, recent)) await delay(180);
    }
    return { list: [...list.values()].filter(({ novelId }) => !ambiguous.has(novelId)), total, scanned, skipped: skipped + ambiguous.size, duplicates };
  }

  function makePlan(list) {
    return list.map((item) => {
      const existing = new Set(item.original.map(tagKey));
      const source = new Map();
      for (const raw of item.source) {
        const tag = raw.trim();
        if (tag && tag !== '未分類' && !source.has(tagKey(tag))) source.set(tagKey(tag), tag);
      }
      const firstTags = [...source.values()].slice(0, maxSourceTags);
      const room = Math.max(0, toolTagLimit - item.original.length);
      const added = firstTags.filter((tag) => !existing.has(tagKey(tag))).slice(0, room);
      return { ...item, added };
    }).filter((item) => item.added.length);
  }

  function makeBatches(plan) {
    const groups = new Map();
    for (const item of plan) {
      const key = JSON.stringify([...item.added].sort());
      if (!groups.has(key)) groups.set(key, { tags: item.added, ids: [] });
      groups.get(key).ids.push(item.id);
    }
    const batches = [];
    for (const { tags, ids } of groups.values()) {
      for (let start = 0; start < ids.length; start += batchSize) {
        batches.push({ tags, bookmarkIds: ids.slice(start, start + batchSize) });
      }
    }
    return batches;
  }

  async function apply(accountId, plan, onProgress, stopped) {
    const token = await readWriteToken(accountId);
    const batches = makeBatches(plan);
    let count = 0;
    for (const batch of batches) {
      if (stopped()) break;
      checkAccount(accountId, readConfig(document));
      await request('/ajax/novels/bookmarks/add_tags', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-csrf-token': token, 'x-user-id': accountId },
        body: JSON.stringify(batch)
      });
      count += batch.bookmarkIds.length;
      onProgress(count, plan.length);
      await delay(550);
    }
    return count;
  }

  function verify(plan, after) {
    const byId = new Map(after.list.map((item) => [item.id, item]));
    return plan.filter((item) => {
      const current = byId.get(item.id);
      if (!current || current.novelId !== item.novelId) return true;
      const available = new Set(current.original.map(tagKey));
      return [...item.original, ...item.added].some((tag) => !available.has(tagKey(tag)));
    });
  }

  pixivNovelTags = Object.freeze({ pageAccountId, scan, makePlan, apply, verify });
})();


(collectPixivNovels = async function collectPixivNovels(accountId, { scope = 'both', count = 0, onProgress, stopped } = {}) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startPath = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?users\/(\d+)\/bookmarks\/novels\/?$/i;
  const accountOnPage = () => startPath.exec(location.pathname)?.[1];
  const numericId = (value) => /^[1-9]\d{0,24}$/.test(String(value ?? ''));
  const string = (value) => typeof value === 'string' ? value.trim() : '';
  function tagsOf(value, depth = 0) {
    if (Array.isArray(value)) {
      const tags = [...new Set(value.map((item) => string(item) || string(item?.tag) || string(item?.name)).filter(Boolean))];
      return tags.length || !value.length ? tags : undefined;
    }
    if (value && typeof value === 'object' && depth < 3) return tagsOf(value.tags, depth + 1) ?? tagsOf(value.tagList, depth + 1);
  }
  const fillMissingTags = (row, other) => {
    for (const key of ['tags', 'bookmarkTags']) if (row[key] === undefined && other?.[key] !== undefined) row[key] = other[key];
  };

  try {
    if (!['both', 'show', 'hide'].includes(scope) || !Number.isSafeInteger(count) || count < 0 || count > 20000) throw new Error('导出数量或范围不正确。');
    if (location.origin !== 'https://www.pixiv.net' || !numericId(accountId) || accountOnPage() !== accountId) {
      throw new Error('请在自己的 Pixiv 小说收藏页点击扩展图标，然后重新导入。');
    }
    const meta = document.querySelector('#meta-global-data')?.content;
    let loggedIn;
    if (meta) {
      try { loggedIn = JSON.parse(meta)['pixiv.user.id']; } catch { /* The list requests still require access. */ }
    }
    if (numericId(loggedIn) && String(loggedIn) !== accountId) {
      throw new Error('请打开当前登录账号自己的小说收藏页。');
    }
    async function scan(visibility, limit) {
      const rows = new Map();
      const bookmarks = new Map();
      let total = null;
      let unavailable = 0;
      let duplicate = 0;
      let incomplete = false;
      let bookmarkTagsMissing = false;
      let stalledPages = 0;
      for (let offset = 0; (total === null || offset < total) && (!count || rows.size < count); ) {
        if (stopped?.()) throw new Error('已停止读取收藏。');
        if (accountOnPage() !== accountId) throw new Error('读取期间 Pixiv 收藏页已离开，请回到自己的小说收藏页重试。');
        const query = new URLSearchParams({ tag: '', offset, limit: count ? Math.min(limit, count - rows.size) : limit, rest: visibility, lang: 'zh' });
        const response = await fetch(`/ajax/user/${accountId}/novels/bookmarks?${query}`, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000)
        });
        if (response.status === 429) throw new Error('Pixiv 暂时限制了读取频率，请过一会儿再点「读取收藏」。');
        if ([401, 403].includes(response.status)) throw new Error('Pixiv 拒绝了读取，请确认已登录并打开自己的收藏页。');
        if (!response.ok) throw new Error(`Pixiv 读取失败（HTTP ${response.status}）。`);
        const reply = await response.json();
        const body = reply?.body;
        if (reply?.error !== false || !Array.isArray(body?.works) || !Number.isSafeInteger(body.total) || body.total < 0) {
          throw new Error(visibility === 'hide' ? '无法读取非公开收藏，请检查 Pixiv 登录状态。' : 'Pixiv 返回的收藏列表格式无法识别。');
        }
        total ??= body.total;
        if (total !== body.total || offset + body.works.length > total || (offset < total && !body.works.length)) {
          incomplete = true;
          total = body.total;
          if (!body.works.length) break;
        }
        const labelMap = body.bookmarkTags && typeof body.bookmarkTags === 'object' ? body.bookmarkTags : null;
        if (body.works.length && !labelMap) bookmarkTagsMissing = true;
        const workKeys = new Set(body.works.map((work) => String(work?.id)));
        const bookmarkCounts = new Map();
        for (const work of body.works) {
          const key = String(work?.bookmarkData?.id);
          bookmarkCounts.set(key, (bookmarkCounts.get(key) ?? 0) + 1);
        }
        const labelKeys = Object.keys(labelMap ?? {});
        const labelsByNovel = labelKeys.some((key) => workKeys.has(key) && !bookmarkCounts.has(key)) &&
          !labelKeys.some((key) => bookmarkCounts.has(key) && !workKeys.has(key));
        let pageAvailable = 0;
        let pageNew = 0;
        for (const work of body.works) {
          const title = string(work?.title);
          if (!numericId(work?.id) || !title || /^[-—]{3,}$/.test(title) || work?.isMasked === true) {
            unavailable++;
            continue;
          }
          pageAvailable++;
          const workId = String(work.id);
          const key = String(work.bookmarkData?.id);
          const ambiguous = !labelsByNovel && (bookmarkCounts.get(key) ?? 0) > 1 && Object.hasOwn(labelMap ?? {}, key);
          if (ambiguous) bookmarkTagsMissing = true;
          const labelKey = labelsByNovel ? workId : key;
          const bookmarkTags = tagsOf(ambiguous ? undefined : labelMap?.[labelKey]) ?? tagsOf(work.bookmarkData?.tags) ??
            (labelMap && !ambiguous && !Object.hasOwn(labelMap, labelKey) ? [] : undefined);
          const tags = tagsOf(work.tags) ?? tagsOf(work.tagList);
          if (bookmarkTags === undefined) bookmarkTagsMissing = true;
          const row = {
            id: workId,
            title,
            author: string(work.userName),
            authorId: numericId(work.userId) ? String(work.userId) : '',
            series: string(work.seriesTitle ?? work.series?.title),
            ...(numericId(work.seriesId ?? work.series?.id) ? { seriesId: String(work.seriesId ?? work.series.id) } : {}),
            ...(numericId(work.seriesOrder ?? work.series?.order) ? { seriesOrder: String(work.seriesOrder ?? work.series.order) } : {}),
            ...(tags === undefined ? {} : { tags }),
            ...(bookmarkTags === undefined ? {} : { bookmarkTags }),
            visibility: visibility === 'hide' ? 'private' : 'public'
          };
          const previous = rows.get(workId);
          if (previous) {
            duplicate++;
            fillMissingTags(previous, row);
          } else {
            pageNew++;
            rows.set(workId, row);
            if (numericId(work.bookmarkData?.id)) bookmarks.set(workId, key);
          }
        }
        offset += body.works.length;
        onProgress?.(visibility, offset, count ? Math.min(total, count) : total);
        stalledPages = pageAvailable > 0 && pageNew === 0 ? stalledPages + 1 : 0;
        if (stalledPages) incomplete = true;
        if (stalledPages >= 3) break;
        if (offset < total && (!count || rows.size < count)) await pause(220);
      }
      return { rows, bookmarks, total, unavailable, duplicate, incomplete, bookmarkTagsMissing };
    }

    const result = { rows: [], totals: { show: 0, hide: 0 }, unavailable: 0, duplicate: 0, incomplete: [], bookmarkTagsMissing: false };
    const merged = new Map();
    const bookmarks = new Map();
    const scopes = scope === 'both' ? ['show', 'hide'] : [scope];
    for (const visibility of scopes) {
      let pass = await scan(visibility, 24);
      if (pass.duplicate || pass.incomplete) {
        await pause(550);
        const retry = await scan(visibility, 20);
        const clean = !retry.duplicate && !retry.incomplete;
        const first = pass;
        if (clean || retry.rows.size >= pass.rows.size) pass = retry;
        const other = pass === retry ? first : retry;
        for (const [id, row] of pass.rows) fillMissingTags(row, other.rows.get(id));
      }
      result.totals[visibility] = pass.total;
      result.unavailable += pass.unavailable;
      result.duplicate += pass.duplicate;
      result.bookmarkTagsMissing ||= pass.bookmarkTagsMissing;
      if (pass.incomplete || pass.duplicate) result.incomplete.push(visibility);
      for (const [id, row] of pass.rows) {
        if (merged.has(id)) {
          result.duplicate++;
          fillMissingTags(row, merged.get(id));
        }
        merged.set(id, row);
        if (pass.bookmarks.has(id)) bookmarks.set(id, pass.bookmarks.get(id));
      }
      if (scope === 'both' && visibility === 'show') await pause(220);
    }
    result.rows = [...merged.values()];
    if (count && scope === 'both') {
      result.orderUncertain = result.rows.some(({ id }) => !bookmarks.has(id)) || new Set(bookmarks.values()).size !== bookmarks.size;
      result.rows.sort((a, b) => {
        const left = bookmarks.get(a.id) ?? '';
        const right = bookmarks.get(b.id) ?? '';
        return right.length - left.length || (right > left ? 1 : right < left ? -1 : 0);
      });
    }
    if (count) result.rows = result.rows.slice(0, count);
    result.workTagsMissing = result.rows.filter((row) => row.tags === undefined).length;
    if (stopped?.()) throw new Error('已停止读取收藏。');
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
});


(function start() {
  if (location.origin !== 'https://www.pixiv.net' || window.top !== window) return;
  let currentPage;
  function mount() {
    const nextPage = location.pathname + location.search + (location.hash === '#shiyue-capture' ? location.hash : '');
    if (currentPage === nextPage) return;
    currentPage = nextPage;
    const previous = document.getElementById('shiyue-via-tools');
    previous?.remove();
    mountPanel();
  }
  mount();
  // Pixiv can change pages without a reload; Via only needs to inject once.
  window.setInterval(mount, 900);
})();

function mountPanel() {
  const shelf = 'https://eysium.github.io/shiyue/shiyue-offline/';
  const idOf = (value) => /^[1-9]\d{0,24}$/.test(String(value ?? '')) ? String(value) : '';
  const novelId = location.pathname === '/novel/show.php' ? idOf(new URLSearchParams(location.search).get('id')) : '';
  const account = pixivNovelTags.pageAccountId();
  if ((!novelId && !account) || document.getElementById('shiyue-via-tools')) return;

  const host = document.createElement('div');
  host.id = 'shiyue-via-tools';
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;--paper:#f8faf7;--ink:#142c25;--muted:#466055;--line:#b5c7bd;--green:#176149;--white:#fff;--tint:#e0f0e8}
    @media(prefers-color-scheme:dark){:host{--paper:#152620;--ink:#eefbf3;--muted:#b2cabe;--line:#557468;--green:#94ddb9;--white:#10291e;--tint:#29463a}}
    *{box-sizing:border-box} [hidden]{display:none!important} button,a,input,select,textarea{font:inherit;color:inherit}
    button,a.action{min-height:44px;padding:8px 13px;border:1px solid var(--line);border-radius:8px;background:var(--paper);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
    button:disabled{opacity:.55;cursor:default}.primary,#open{background:var(--green);border-color:var(--green);color:var(--white);font-weight:700}
    button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--green);outline-offset:2px}
    #open{position:fixed;z-index:2147483646;right:max(12px,env(safe-area-inset-right));bottom:calc(82px + env(safe-area-inset-bottom));box-shadow:0 2px 12px #0003}
    dialog{width:min(calc(100% - 20px),470px);max-height:calc(100% - 26px);max-height:calc(100dvh - 26px);padding:0 16px 16px;overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper);color:var(--ink);box-shadow:0 16px 70px #0005}
    dialog::backdrop{background:#04171092}header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid var(--line)}h2{font-size:1.16rem;margin:0}p{margin:10px 0;color:var(--muted);overflow-wrap:anywhere}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
    label{display:block;min-width:0} input:not([type=checkbox]),select,textarea{display:block;width:100%;min-height:44px;padding:7px;border:1px solid var(--line);border-radius:8px;background:var(--paper)} #status,#tag-status{min-height:1.5em} .preview{background:var(--tint);border-radius:8px;padding:10px;white-space:pre-wrap}details{margin-top:14px}summary{cursor:pointer;color:var(--green);min-height:44px;padding:10px 0}.selection{max-height:36vh;overflow:auto;border-top:1px solid var(--line)}.entry{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:8px;padding:9px 2px;border-bottom:1px solid var(--line);overflow-wrap:anywhere;min-height:44px}.entry input{width:20px;height:20px}.entry small{display:block;color:var(--muted)}
  </style><button type="button" id="open">拾页工具</button><dialog aria-labelledby="title"><header><h2 id="title">拾页 · Pixiv 小说</h2><button type="button" id="close">关闭</button></header>
  <section id="one" hidden><p>从当前小说读取标题、作者和标签。</p><button id="read-one" class="primary">读取本篇</button><p id="one-preview" class="preview" hidden></p><a id="send" class="action primary" rel="noreferrer" hidden>发送到拾页</a></section>
  <section id="many" hidden><form id="export-form"><div class="fields"><label>导出范围<select id="scope"><option value="both">公开＋非公开</option><option value="hide">仅非公开</option><option value="show">仅公开</option></select></label><label>最近篇数<input id="count" type="number" min="0" max="20000" value="30" required inputmode="numeric"></label></div><p>填 0 读取全部。导出标题、作者、作品编号和标签。</p><div class="actions"><button class="primary" type="submit">读取收藏</button><button id="stop" type="button" hidden>停止读取</button></div></form></section>
  <p id="status" role="status"></p><div class="actions" id="export-actions" hidden><button id="download">下载 JSON</button><button id="copy">复制 JSON</button></div><textarea id="copy-fallback" rows="5" readonly aria-label="长按复制 JSON" hidden></textarea>
  <details id="tags" hidden><summary>批量追加 Pixiv 收藏标签</summary><form id="scan-form"><div class="fields"><label>标签范围<select id="tag-scope"><option value="hide">非公开收藏</option><option value="show">公开收藏</option></select></label><label>最近篇数<input id="tag-count" type="number" min="1" max="100" value="20" required inputmode="numeric"></label></div><button type="submit">读取待选作品</button></form>
  <div id="tag-ready" hidden><label>要追加的同一组标签（每行一个）<textarea id="new-tags" rows="2" maxlength="1200"></textarea></label><p>可勾选任意作品。已存在的标签会跳过。</p><div class="actions"><button id="all">全选</button><button id="none">清空勾选</button><button id="plan" class="primary">预览追加</button></div><div id="selection" class="selection"></div><div id="review" hidden><p id="plan-summary" class="preview"></p><details id="plan-details"><summary>逐篇核对</summary><div id="plan-rows" class="selection"></div></details><button class="primary" id="apply">确认写入 Pixiv</button></div></div><p id="tag-status" role="status"></p></details></dialog>`;
  const $ = (id) => shadow.getElementById(id);
  const dialog = shadow.querySelector('dialog');
  const text = (id, message) => { $(id).textContent = message; };
  const show = () => { if (!dialog.open) dialog.showModal(); };
  $('open').onclick = show;
  $('close').onclick = () => dialog.close();
  $('one').hidden = !novelId;
  $('many').hidden = $('tags').hidden = !account;
  let backup;
  let exporting = false;
  let applying = false;
  function setExport(payload) {
    backup = payload;
    $('export-actions').hidden = !payload?.rows.length;
    $('copy-fallback').hidden = true;
    $('copy-fallback').value = '';
  }
  $('download').onclick = () => {
    if (!backup) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = novelId ? `pixiv-novel-${novelId}.json` : `pixiv-novels-${backup.incomplete ? 'partial-' : ''}${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    text('status', '已请求下载。若 Via 没有保存文件，可以点「复制 JSON」。');
  };
  $('copy').onclick = async () => {
    if (!backup) return;
    const json = JSON.stringify(backup);
    try { await navigator.clipboard.writeText(json); text('status', '已复制，可在拾页导入窗口粘贴。'); }
    catch { const field = $('copy-fallback'); field.value = json; field.hidden = false; field.focus(); field.select(); text('status', '请长按下方文本并复制。'); }
  };

  function tagsOf(value) {
    const tags = value?.tags ?? value;
    if (!Array.isArray(tags)) return undefined;
    const valid = tags.map((tag) => typeof tag === 'string' ? tag.trim() : typeof tag?.tag === 'string' ? tag.tag.trim() : '').filter(Boolean);
    return valid.length || !tags.length ? [...new Set(valid)].slice(0, 100) : undefined;
  }
  function textOf(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
  function novelRow(data) {
    const title = textOf(data?.title, 1000);
    if (idOf(data?.id) !== novelId || !title || /^[-—]{3,}$/.test(title)) return null;
    const bookmark = data.bookmarkData;
    return { id: novelId, title, author: textOf(data.userName, 300), authorId: idOf(data.userId),
      tags: tagsOf(data.tags), bookmarkTags: tagsOf(bookmark?.tags ?? data.bookmarkTags),
      series: textOf(data.seriesNavData?.title ?? data.seriesTitle, 400), seriesId: idOf(data.seriesNavData?.seriesId ?? data.seriesId),
      seriesOrder: idOf(data.seriesNavData?.order ?? data.seriesOrder), visibility: typeof bookmark?.private === 'boolean' ? (bookmark.private ? 'private' : 'public') : '' };
  }
  async function readOne() {
    const control = $('read-one');
    if (control.disabled) return;
    control.disabled = true; $('send').hidden = $('one-preview').hidden = true; setExport(null);
    text('status', '正在读取当前作品…');
    try {
      let row;
      try {
        const preload = JSON.parse(document.querySelector('#meta-preload-data')?.content);
        row = novelRow(preload?.novel?.[novelId]);
        if (row && !row.author) row.author = textOf(preload?.user?.[row.authorId]?.name, 300);
      } catch { /* Some Pixiv pages do not preload the metadata. */ }
      if (!row || row.tags === undefined || !row.author || !row.authorId) {
        try {
          const reply = await fetch(`/ajax/novel/${novelId}?lang=ja`, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
          if (reply.ok) {
            const data = await reply.json();
            const fetched = data?.error === false && novelRow(data.body);
            if (fetched) row = { ...fetched, author: fetched.author || row?.author || '', tags: fetched.tags ?? row?.tags, bookmarkTags: fetched.bookmarkTags ?? row?.bookmarkTags };
          }
          else if (!row && reply.status === 429) throw new Error('Pixiv 暂时限制读取频率。');
        } catch (error) { if (!row) throw error; }
      }
      if (!row) throw new Error('此页未返回作品资料。请检查 Via 是否已登录 Pixiv、作品是否可见。');
      setExport({ type: 'pixiv-repo-export', version: 1, rows: [row], ...(row.tags === undefined ? { workTagsMissing: 1 } : {}), ...(row.bookmarkTags === undefined ? { bookmarkTagsMissing: true } : {}) });
      text('one-preview', `${row.title}\n${row.author || '作者未知'}${row.authorId ? ` · 作者 #${row.authorId}` : ''} · 作品 #${row.id}\n原标签 ${row.tags?.length ?? '未返回'}，收藏标签 ${row.bookmarkTags?.length ?? '未返回'}`);
      $('one-preview').hidden = false;
      const fragment = encodeURIComponent(JSON.stringify(row));
      if (fragment.length <= 32000) {
        $('send').href = `${shelf}#via-novel=${fragment}`;
        $('send').hidden = false;
      }
      text('status', row.bookmarkTags === undefined ? '这页没有返回收藏标签。可从自己的小说收藏页导出以同步。' : '资料已读取完成。');
    } catch (error) { text('status', error.message); }
    finally { control.disabled = false; }
  }
  $('read-one').onclick = readOne;
  if (novelId && location.hash === '#shiyue-capture') { show(); readOne(); }

  let exportStopped = false;
  $('stop').onclick = () => { exportStopped = true; text('status', '正在停止，当前页读取后结束。'); };
  $('export-form').onsubmit = async (event) => {
    event.preventDefault();
    const control = event.submitter ?? event.currentTarget.querySelector('[type=submit]');
    if (exporting || applying) return;
    exporting = true; control.disabled = $('count').disabled = $('scope').disabled = true;
    $('stop').hidden = false; exportStopped = false; setExport(null);
    text('status', '正在读取收藏…');
    try {
      const count = $('count').valueAsNumber;
      const result = await collectPixivNovels(account, { count, scope: $('scope').value, stopped: () => exportStopped,
        onProgress: (scope, read, total) => text('status', `${scope === 'hide' ? '非公开' : '公开'}收藏：已读取 ${read} / ${total} 项`) });
      if (!result.ok) throw new Error(result.message);
      const { rows, incomplete, workTagsMissing, bookmarkTagsMissing } = result;
      setExport({ type: 'pixiv-repo-export', version: 1, rows, ...(incomplete.length ? { incomplete } : {}), ...(workTagsMissing ? { workTagsMissing } : {}), ...(bookmarkTagsMissing ? { bookmarkTagsMissing } : {}) });
      const warnings = [incomplete.length && '部分分页发生变化，可重试', result.unavailable && `跳过 ${result.unavailable} 个不可读条目`, (workTagsMissing || bookmarkTagsMissing) && '部分标签未返回', result.orderUncertain && '公开和非公开的最近排序可能有出入'].filter(Boolean);
      text('status', `已读取 ${rows.length} 篇。${warnings.length ? warnings.join('；') + '。' : ''}`);
    } catch (error) { text('status', error.message); }
    finally { exporting = false; control.disabled = $('count').disabled = $('scope').disabled = false; $('stop').hidden = true; }
  };

  let items = [];
  let plan = [];
  let scanOptions;
  const tagKey = (value) => value.trim().normalize('NFC').toLowerCase();
  function resetPlan() { plan = []; $('review').hidden = true; $('plan-details').open = false; }
  function discardScan() { items = []; scanOptions = undefined; $('tag-ready').hidden = true; $('selection').replaceChildren(); resetPlan(); }
  function renderSelection() {
    $('selection').replaceChildren(...items.map((item) => {
      const label = document.createElement('label'); label.className = 'entry';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.novelId;
      const copy = document.createElement('span'); copy.textContent = item.title;
      const tags = document.createElement('small'); tags.textContent = item.original.length ? item.original.join('、') : '无收藏标签';
      copy.append(tags); label.append(input, copy); return label;
    }));
  }
  $('tag-scope').onchange = $('tag-count').oninput = () => { discardScan(); text('tag-status', '范围已更改，请重新读取。'); };
  $('scan-form').onsubmit = async (event) => {
    event.preventDefault();
    const control = event.submitter ?? event.currentTarget.querySelector('[type=submit]');
    if (applying || control.disabled) return;
    control.disabled = $('tag-scope').disabled = $('tag-count').disabled = true;
    discardScan();
    const count = $('tag-count').valueAsNumber;
    const scope = $('tag-scope').value;
    try {
      const result = await pixivNovelTags.scan(account, (read, total) => text('tag-status', `正在读取 ${read} / ${total} 项…`), () => false, count, scope);
      items = result.list; scanOptions = { count, scope };
      renderSelection(); $('tag-ready').hidden = !items.length;
      text('tag-status', `可选 ${items.length} 篇。${result.skipped ? `跳过 ${result.skipped} 项标签或编号无法确认的作品。` : ''}`);
    } catch (error) { text('tag-status', error.message); }
    finally { control.disabled = $('tag-scope').disabled = $('tag-count').disabled = false; }
  };
  const checks = () => [...$('selection').querySelectorAll('input')];
  $('selection').onchange = $('new-tags').oninput = resetPlan;
  for (const [id, selected] of [['all', true], ['none', false]]) $(id).onclick = () => {
    if (applying) return;
    checks().forEach((input) => { input.checked = selected; }); resetPlan();
  };
  $('plan').onclick = () => {
    if (applying) return;
    resetPlan();
    const inputTags = $('new-tags').value.split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean);
    const keys = new Set();
    const additions = inputTags.filter((tag) => {
      const key = tagKey(tag);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    const picked = new Set(checks().filter((input) => input.checked).map((input) => input.value));
    if (!additions.length || !picked.size) return text('tag-status', '请先填写标签，再勾选作品。');
    if (additions.length > 10 || additions.some((tag) => tag.length > 120 || tag === '未分類')) return text('tag-status', '每次最多输入 10 个标签，每个不超过 120 字。');
    plan = items.filter((item) => picked.has(item.novelId)).map((item) => {
      const existing = new Set(item.original.map(tagKey));
      return { ...item, added: additions.filter((tag) => !existing.has(tagKey(tag))).slice(0, Math.max(0, 10 - item.original.length)) };
    }).filter((item) => item.added.length);
    if (!plan.length) return text('tag-status', '没有需要追加的标签。所选作品可能已有同名标签，或标签数已满。');
    $('plan-rows').replaceChildren(...plan.map((item) => {
      const line = document.createElement('p'); line.textContent = `${item.title}：${item.added.join('、')}`; return line;
    }));
    text('plan-summary', `将向 ${plan.length} 篇作品追加标签，保留各篇已有收藏标签。${picked.size - plan.length ? ` ${picked.size - plan.length} 篇会跳过。` : ''}`);
    text('tag-status', '请核对后再确认写入。'); $('review').hidden = false;
  };
  $('apply').onclick = async () => {
    if (exporting) return text('tag-status', '请等导出读取结束后再写入标签。');
    if (applying || !plan.length || !scanOptions) return;
    applying = true;
    const planned = plan;
    const { count, scope } = scanOptions;
    const controls = [...$('tags').querySelectorAll('button,input,textarea,select')];
    controls.forEach((control) => { control.disabled = true; });
    $('export-form').querySelector('[type=submit]').disabled = true;
    setExport(null);
    text('tag-status', '正在核对收藏、准备追加标签…');
    let sent = 0;
    let started = false;
    try {
      const fresh = await pixivNovelTags.scan(account, () => {}, () => false, count, scope);
      const current = new Map(fresh.list.map((item) => [item.novelId, item]));
      if (planned.some((item) => {
        const match = current.get(item.novelId);
        return match?.id !== item.id || JSON.stringify(match.original) !== JSON.stringify(item.original);
      })) throw new Error('收藏或标签已变动，请重新读取并预览。');
      started = true;
      await pixivNovelTags.apply(account, planned, (done, total) => { sent = done; text('tag-status', `Pixiv 已确认 ${done} / ${total} 篇…`); }, () => false);
      text('tag-status', `Pixiv 已确认追加 ${sent} 篇。现在可用上方「读取收藏」导出最新标签。`);
      setExport(null);
    } catch (error) {
      text('tag-status', started ? `Pixiv 已确认 ${sent} 篇，其余状态请重新读取确认。${error.message}` : error.message);
    } finally {
      discardScan(); controls.forEach((control) => { control.disabled = false; });
      $('export-form').querySelector('[type=submit]').disabled = false; applying = false;
    }
  };
}

})();
