import { changeLibrary, emptyShelf, libraryRoutes, lookupLocal } from './library.mjs';

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(`shiyue:${new URL('.', import.meta.url).pathname}`, 1);
  request.onupgradeneeded = () => request.result.createObjectStore('shelf');
  request.onsuccess = () => {
    const database = request.result;
    database.onversionchange = () => database.close();
    resolve(database);
  };
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('请关闭其他拾页页面，再重新打开。'));
});

let opening;
async function transact(write, action) {
  if (!opening) opening = openDatabase().catch((error) => { opening = undefined; throw error; });
  const database = await opening;
  return new Promise((resolve, reject) => {
    const tx = database.transaction('shelf', write ? 'readwrite' : 'readonly');
    const store = tx.objectStore('shelf');
    let result;
    let error;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(error ?? tx.error ?? new Error('未能保存书架。'));
    const request = store.get('state');
    request.onsuccess = () => {
      try {
        const state = request.result ?? emptyShelf();
        result = action(state);
        if (write) { state.revision++; store.put(state, 'state'); }
      } catch (reason) { error = reason; tx.abort(); }
    };
  });
}

export async function localApi(path, input) {
  const route = new URL(path, 'https://local.invalid/');
  if (route.pathname === '/shelf') return transact(false, (state) => Number(route.searchParams.get('since') ?? -1) === state.revision ? { revision: state.revision } : state);
  if (route.pathname === '/lookup') return transact(false, (state) => lookupLocal(input, state.rows));
  const name = route.pathname.slice(1);
  if (!libraryRoutes.has(name)) throw new Error('离线版不提供此服务。');
  try { return await transact(true, (state) => ({ state, result: changeLibrary(state, name, input) })); }
  catch (error) {
    if (error.name === 'QuotaExceededError') throw new Error('手机存储空间不足，本次修改未保存。请先导出备份，再释放空间。');
    throw error;
  }
}

export async function prepareOffline() {
  if (!navigator.serviceWorker) throw new Error('这个地址无法安装离线拾页，请使用 HTTPS 网址。');
  await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
}
