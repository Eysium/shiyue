import { cleanNovel, idOf, textOf } from './model.mjs';

const translationEndpoint = 'https://api.mymemory.translated.net/get';
export const mobileLanguages = ['ja', 'en', 'ko', 'zh-Hant'];

export function languageFor(title) {
  if (/[\u3041-\u30ff]/u.test(title)) return 'ja';
  if (/[\u1100-\u11ff\uac00-\ud7a3]/u.test(title)) return 'ko';
  return /[\p{Script=Han}]/u.test(title) ? 'ja' : 'en';
}

export async function translateMobile(title, source, { request = fetch, signal } = {}) {
  if (!mobileLanguages.includes(source)) throw new Error('请选择原题语言。');
  if (!title.trim() || new TextEncoder().encode(title).length > 500) throw new Error('原题过长或为空，请使用批量导入译文。');
  const url = new URL(translationEndpoint);
  url.search = new URLSearchParams({ q: title, langpair: `${source === 'zh-Hant' ? 'zh-TW' : source}|zh-CN` });
  const limit = AbortSignal.timeout(12000);
  let response;
  try { response = await request(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, limit]) : limit }); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接翻译服务，请联网后重试。');
  }
  const body = await response.json().catch(() => null);
  if (response.status === 429 || body?.quotaFinished || Number(body?.responseStatus) === 429) throw new Error('翻译服务额度暂时用完，请稍后重试。');
  const value = response.ok && Number(body?.responseStatus) === 200 && textOf(body.responseData?.translatedText, 1000);
  const zh = value && !/MYMEMORY WARNING|INVALID LANGUAGE PAIR/i.test(value) ? value : '';
  if (!zh) throw new Error('翻译服务没有返回译文，请稍后再试。');
  return zh;
}

export function lookupConfig(endpoint, key) {
  if (!endpoint.trim() && !key.trim()) return null;
  let url;
  try { url = new URL(endpoint.trim()); } catch { /* Report a single setup error below. */ }
  if (url?.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[A-Za-z0-9_-]{24,128}$/.test(key.trim())) {
    throw new Error('请输入 workers.dev HTTPS 根网址及至少 24 位的连接码。');
  }
  return { endpoint: url.origin, key: key.trim() };
}

export async function lookupMobile(config, { id, authorId }, { request = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(20000);
  let response;
  try {
    response = await request(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', body: JSON.stringify(id ? { id, ...(authorId ? { authorId } : {}) } : { authorId }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接 Pixiv 识别服务。请检查网络和识别服务设置，或手动填写。');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(textOf(result?.error, 300) || '识别服务暂不可用。');
  if (id) {
    const novel = idOf(result?.novel?.id) === id && cleanNovel(result.novel);
    if (novel?.title) return { novel };
  } else if (idOf(result?.authorId) === authorId && textOf(result.author, 300)) return { authorId, author: textOf(result.author, 300) };
  throw new Error('没有收到该编号的公开资料。');
}
