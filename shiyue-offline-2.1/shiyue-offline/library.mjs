import { applyImport, cleanNovel, idOf, levels, norm, readTags, statuses, tagSources, textOf } from './model.mjs';

export const emptyShelf = () => ({ rows: [], folders: [], revision: 0, lastImport: 0 });
const error = (status, message) => { throw Object.assign(new Error(message), { status }); };
const folderId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function validateIds(value, limit = 20000) {
  if (!Array.isArray(value) || value.length > limit) error(400, '作品范围无效。');
  return new Set(value.map(idOf).filter(Boolean));
}

function patchRow(state, row, patch) {
  for (const [key, max] of [['zh', 1000], ['repo', 24000]]) if (Object.hasOwn(patch, key)) row[key] = textOf(patch[key], max);
  if (Object.hasOwn(patch, 'score')) row.score = Number.isInteger(patch.score) && patch.score >= 1 && patch.score <= 5 ? patch.score : 0;
  if (Object.hasOwn(patch, 'level')) row.level = levels.includes(patch.level) ? patch.level : '';
  if (Object.hasOwn(patch, 'status') && typeof patch.status === 'string' && Object.hasOwn(statuses, patch.status)) row.status = patch.status;
  if (Object.hasOwn(patch, 'favorite')) row.favorite = patch.favorite === true;
  if (Array.isArray(patch.folders)) row.folders = [...new Set(patch.folders)].filter((id) => state.folders.some((folder) => folder.id === id));
  if (Array.isArray(patch.labels)) row.labels = [...new Set(patch.labels.slice(0, 35).map((label) => textOf(label, 100)).filter(Boolean))];
  for (const source of ['tags', 'bookmarkTags']) {
    if (Array.isArray(patch[source])) row[source] = readTags(patch[source]) ?? [];
  }
  row.touched = Date.now();
  row.rev++;
}

function hiddenTagSettings(raw) {
  return Object.fromEntries(Object.keys(tagSources).map((source) => [source,
    Array.isArray(raw?.[source]) ? [...new Set(raw[source].slice(0, 2000).map((name) => norm(textOf(name, 120))).filter(Boolean))] : []]));
}

export function addTranslations(state, entries) {
  const byId = new Map(state.rows.map((row) => [row.id, row]));
  let count = 0;
  for (const item of entries) {
    const row = byId.get(idOf(item?.id));
    const zh = textOf(item?.zh);
    if (!row || row.zh || !zh || (item.title && row.title !== item.title)) continue;
    patchRow(state, row, { zh });
    count++;
  }
  return count;
}

export const libraryRoutes = new Set(['import', 'restore', 'edit', 'tag', 'folder', 'translation']);
export function changeLibrary(state, route, input) {
  if (!input || typeof input !== 'object') error(400, '资料格式无效。');
  switch (route) {
    case 'import': {
      let result;
      try { result = applyImport(state, input); } catch (exception) { error(400, exception.message); }
      state.lastImport = Date.now();
      return result;
    }
    case 'restore': {
      if (state.rows.length || state.folders.length) error(409, '完整恢复仅适用于空书架；也可用普通导入合并作品资料。');
      if (input.type !== 'pixiv-repo-web' || !Array.isArray(input.rows) || !Array.isArray(input.folders)) error(400, '不是拾页的完整备份。');
      state.hiddenTags = hiddenTagSettings(input.hiddenTags);
      state.folders = input.folders.slice(0, 200).filter((folder) => /^[a-f0-9]{16}$/.test(folder?.id) && textOf(folder?.name, 50))
        .map(({ id, name }) => ({ id, name: textOf(name, 50) }));
      if (input.rows.length) {
        try { applyImport(state, input.rows); } catch (exception) { error(400, exception.message); }
        const byId = new Map(input.rows.filter(Boolean).map((row) => [idOf(row.id), row]));
        for (const row of state.rows) {
          const raw = byId.get(row.id) || {};
          patchRow(state, row, raw);
          if (Number.isSafeInteger(raw.added) && raw.added > 0) row.added = raw.added;
          if (Number.isSafeInteger(raw.touched) && raw.touched > 0) row.touched = raw.touched;
        }
      }
      state.lastImport = Number.isSafeInteger(input.lastImport) && input.lastImport > 0 ? input.lastImport : Date.now();
      return state.rows.length;
    }
    case 'edit': {
      const row = state.rows.find((record) => record.id === idOf(input.id));
      if (!row) error(404, '作品找不到。');
      if (row.rev !== input.rev) error(409, '作品已在另一处更新。请保留当前草稿，关闭后重新打开再编辑。');
      patchRow(state, row, input.patch && typeof input.patch === 'object' ? input.patch : {});
      return row;
    }
    case 'tag': {
      const source = input.source;
      const name = norm(textOf(input.name, 120));
      if (typeof source !== 'string' || !Object.hasOwn(tagSources, source) || !name) error(400, '无效的标签。');
      if (input.action === 'delete' && source === 'labels') {
        let count = 0;
        for (const row of state.rows) {
          const labels = row.labels.filter((item) => norm(item) !== name);
          if (row.labels.length !== labels.length) { patchRow(state, row, { labels }); count++; }
        }
        return count;
      }
      if (!['hide', 'show'].includes(input.action)) error(400, '此标签不支持删除，请使用隐藏。');
      state.hiddenTags = hiddenTagSettings(state.hiddenTags);
      const hidden = new Set(state.hiddenTags[source]);
      if (input.action === 'hide') {
        if (!hidden.has(name) && hidden.size >= 2000) error(400, '已达隐藏标签上限。');
        hidden.add(name);
      } else hidden.delete(name);
      state.hiddenTags[source] = [...hidden];
      return;
    }
    case 'folder': {
      const folder = state.folders.find(({ id }) => id === input.id);
      const name = textOf(input.name, 50);
      if (input.action === 'assign' && folder) {
        const ids = validateIds(input.ids);
        for (const row of state.rows) if (ids.has(row.id) && !row.folders.includes(folder.id)) patchRow(state, row, { folders: [...row.folders, folder.id] });
      } else if (input.action === 'delete' && folder) {
        state.folders = state.folders.filter(({ id }) => id !== folder.id);
        for (const row of state.rows) if (row.folders.includes(folder.id)) patchRow(state, row, { folders: row.folders.filter((id) => id !== folder.id) });
      } else if (input.action === 'create' || (input.action === 'rename' && folder)) {
        if (!name || state.folders.some((record) => record !== folder && norm(record.name) === norm(name))) error(400, '收藏夹名称为空或已存在。');
        if (input.action === 'rename') folder.name = name;
        else if (state.folders.length < 200) state.folders.push({ id: folderId(), name });
        else error(400, '收藏夹已达上限。');
      } else error(400, '找不到收藏夹。');
      return;
    }
    case 'translation':
      if (!Array.isArray(input.translations) || input.translations.length > 20000) error(400, '译文应为包含 id 和 zh 的 JSON 数组。');
      return addTranslations(state, input.translations);
    default: error(404, '找不到此操作。');
  }
}

export function lookupLocal(input, rows) {
  const id = idOf(input.id);
  const authorId = idOf(input.authorId);
  const existing = id && rows.find((row) => row.id === id);
  if (existing) return { novel: cleanNovel(existing), existing: true };
  if (!id && authorId) {
    const known = rows.find((row) => row.authorId === authorId && row.author)?.author;
    if (known) return { authorId, author: known };
  }
  error(404, id ? '本机书架里没有这个编号。请填写原文标题，或联网打开 Pixiv 原作查看。' : '本机书架里没有这个作者，作者名可以手填或留空。');
}
