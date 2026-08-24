/**
 * history API だけの最小ルーター。
 *
 * ライブラリを入れないのは、必要なのが「いまどのパスか」「そこへ移動する」
 * 「戻るボタンで戻れる」の3つだけだからである。Firebase Hosting は
 * `**` → `/index.html` の rewrite が入っているので、実URLで直接開いても届く。
 */

/** 末尾スラッシュを落とし、空なら '/' にする */
export function normalizePath(raw: string): string {
  const path = raw.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

export const router = $state({ path: normalizePath(location.pathname) });

export function navigate(to: string): void {
  const path = normalizePath(to);
  if (path === router.path) return;
  history.pushState({}, '', path);
  router.path = path;
  // 画面が切り替わるので、前の画面のスクロール位置を持ち越さない
  window.scrollTo(0, 0);
}

/** 戻る/進むボタンに追従する。返り値は購読解除関数 */
export function startRouter(): () => void {
  const onPop = (): void => { router.path = normalizePath(location.pathname); };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}
