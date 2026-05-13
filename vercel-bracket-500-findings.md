# Next.js Pages Router: リテラル `[id]` URL で Vercel が FUNCTION_INVOCATION_FAILED になる問題 — 検証結果

本ドキュメントは [`vercel-bracket-500-repro.md`](./vercel-bracket-500-repro.md) で記述された問題を最小再現プロジェクトで段階的に検証した結果のサマリです。

---

## TL;DR

- **Next.js 14.0.4 〜 15.3.x の Pages Router + i18n** で `FUNCTION_INVOCATION_FAILED` が発生（混入は 14.0.4）
- **Next.js 15.4.0 以降は 500 にはならない**（[PR #81209](https://github.com/vercel/next.js/pull/81209) の partial fix）が、URL の実値が `params` に渡らず **placeholder `[<paramName>]` が入る** 別の不具合に変質。詳細は [vercel-bracket-500-root-cause.md](./vercel-bracket-500-root-cause.md)
- 元 repro.md の推測（`MODULE_NOT_FOUND`）は外れ。実際は **2 段 ENOENT の連鎖**
- 発火条件は当初想定より遥かに狭く、URL に **case-sensitive な substring `[<paramName>]`** が含まれることが必須
- 公開 issue・SO・Zenn 等で完全一致する事例は **未報告**
- 露出経路としてありがちなのは、SEO 用 `<Head>` コンポーネントで `useRouter().pathname`（route テンプレート）を `<link rel="alternate">` 等に渡してしまい、全ページが `<head>` から `/foo/[id]` を Google bot に告白しているパターン
- 短期回避策: **middleware で `[<paramName>]` 含む URL を Edge 層で 404**（Lambda にすら到達させない）。**15.4 以降にアップグレードしても外せない**（SEO 観点で）

---

## 真の原因（Vercel Runtime Log から判明）

```
GET /ja/foo/[id]
  → Vercel: matchedPath=/ja/foo/[id]、ISR 関数 /foo/[id] にルーティング
  → 関数内 Next.js が page=/ja/foo, url=/ja/foo/ として
    pages/ja/foo.html を require       ← (1) 親 index への内部 fallback
  → ENOENT
  → エラーページ fallback → pages/ja/500.html を require  ← (2)
  → ENOENT
  → 関数クラッシュ → FUNCTION_INVOCATION_FAILED
```

### 一次 ENOENT が起きる理由

Next.js 14.2 系の内部処理が、URL pathname の中に **「dynamic param 名と完全一致するブラケット文字列」** （ここでは `[id]`）を見つけると、それを「placeholder が填め込まれていない」と判定して **親 index ページへ内部 fallback** する経路がある。

その結果 `pages/ja/foo.html` を引きにいくが、`pages/foo/index.page.tsx` は pure-static（`getStaticProps` 無し）なので Next.js はビルド時に `pages/foo.html` を **1 ファイルしか生成しない** — i18n 層は static HTML をロケール別に複製しないため、`pages/ja/foo.html` は存在しない → ENOENT。

### 二次 ENOENT が起きる理由

カスタム `pages/500.page.tsx` を作っていない → デフォルト 500 ページが使われる → 同じく pure-static → `pages/500.html` 1 ファイルだけ。ロケールプレフィックス `pages/ja/500.html` は存在せず ENOENT。

これで関数自体が回復不能なまま終了し、Vercel が `FUNCTION_INVOCATION_FAILED` に昇格する。

### ログ抜粋（Vercel）

```
Invariant: failed to load static page {
  "page": "/ja/foo",
  "url": "/ja/foo/",
  "matchedPath": "/ja/foo/[id]",
  "initUrl": "https://.../ja/foo/[id]",
  "didRewrite": false
}
⨯ h [Error]: Failed to load static file for page: /ja/foo
  ENOENT: ... '/var/task/.next/server/pages/ja/foo.html'

⨯ h [Error]: Failed to load static file for page: /ja/500
  ENOENT: ... '/var/task/.next/server/pages/ja/500.html'
```

---

## 検証で確定した発火条件

### 必要条件（環境）

- **Next.js 14.0.4 〜 15.3.x**（`FUNCTION_INVOCATION_FAILED` のエスカレーション条件として）
  - 15.4.0 以降は 500 こそ消えるが、bug 自体（params 不一致）は残る
- **`i18n` 有効** in `next.config.js`
- **pure-static な sibling index**（`pages/foo/index.page.tsx` に `getStaticProps` 無し）
  - これは「500 にエスカレーションするための条件」。sibling index が無くても bug 自体（param 正規化の誤判定）は発火するが、fallback 先が無いので clean 404 で帰る

### 必要条件（URL）

URL pathname に **case-sensitive な substring `[id]`** が含まれるか、または percent-encoded 形 `%5Bid%5D`（hex 部分のみ case-insensitive、中身の `id` は case-sensitive）が含まれること。

**ポイント**: 「セグメント全体が `[id]`」である必要はなく、**含んでいれば** 発火する。

### 本番（Next 14.2 + i18n）での発火マトリクス

| URL | 発火 | 説明 |
|---|---|---|
| `/foo/[id]` | 🔥 | 標準形 |
| `/ja/foo/[id]` | 🔥 | i18n locale prefix 付き |
| `/foo/x[id]` | 🔥 | **prefix 付きでも発火**（substring match） |
| `/foo/[id]x` | 🔥 | suffix 付きでも発火 |
| `/foo/abc[id]xyz` | 🔥 | 中央に埋まっていても発火 |
| `/foo/%5Bid%5D` | 🔥 | percent-encoded |
| `/foo/%5bid%5d` | 🔥 | hex 部分は case-insensitive |
| `/foo/[Id]` | ✅ | **case 違いは発火せず**（`I` 大文字） |
| `/foo/[ID]` | ✅ | 同上 |
| `/foo/%5BID%5D` | ✅ | encoded で中身が `ID` |
| `/foo/[example]` | ✅ | param 名違い |
| `/foo/[id` | ✅ | `]` 欠落 |
| `/foo/id]` | ✅ | `[` 欠落 |

つまり Next.js 内部は文字列レベルで `[<param-name>]` を探しているだけで、URL parser を通したセグメント解析ではないと推測される。

### Next 15.4+ での挙動（partial fix 状態）

500 にはならないが、URL の実値が `params` に渡らず **一律 `[<paramName>]` 固定** になる:

| URL | 開発者の意図する `params.id` | 15.4+ の実際の `params.id` |
|---|---|---|
| `/foo/[id]` | `'[id]'` | `'[id]'`（**まぐれで一致**） |
| `/foo/[id]hoge` | `'[id]hoge'` | `'[id]'` ❌ |
| `/foo/x[id]y` | `'x[id]y'` | `'[id]'` ❌ |
| `/foo/abc[id]xyz` | `'abc[id]xyz'` | `'[id]'` ❌ |
| `/foo/[example]` | `'[example]'` | `'[example]'`（buggy 経路に入らない） |

実害として最大のものは「**substring が含まれる複数の URL がすべて同じ content (`id: [id]` ページ) を返す**」 こと。Google から見ると canonical 重複 + 偽 content で SEO 上の品質が落ちる。15.4+ にアップグレードしても middleware による URL 弾きが必要、というのはこの理由による。

---

## 検証ブランチ別の結果

すべて Vercel 本番（preview）で実測。bisect の詳細は [vercel-bracket-500-root-cause.md](./vercel-bracket-500-root-cause.md) 参照。

### バージョン bisect

| Branch | Next.js | `/foo/[id]` の挙動 |
|---|---|---|
| [`experiment/next-13.5.11`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-13.5.11) | 13.5.11 | ✅ 200（params 正確） |
| [`experiment/next-14.0.0`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.0.0) | 14.0.0 | ✅ 200（params 正確） |
| [`experiment/next-14.0.4`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.0.4) | 14.0.4 | 🔥 500（混入直後）|
| `experiment/next-14.1.0` / `14.1.4` / `14.2.0` | 14.1.x / 14.2.0 | 🔥 500 |
| [`main`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/main) | 14.2.35 | 🔥 500 |
| [`experiment/next-15.0.8`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.0.8) | 15.0.8 | 🔥 500 |
| [`experiment/next-15.1.12`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.1.12) | 15.1.12 | 🔥 500 |
| [`experiment/next-15.3.9`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.3.9) | 15.3.9 | 🔥 500 |
| [`experiment/next-15.4.8`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.4.8) | 15.4.8 | ✅ 200（**ただし `params.id = '[id]'` placeholder**）|
| [`experiment/next-15.4.11`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.4.11) | 15.4.11 | ✅ 200（同上）|
| [`experiment/next-15`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15) | 15.5.18 | ✅ 200（同上）|

### 必要条件の絞り込み

| Branch | 変更内容 | `/foo/[id]` の挙動 |
|---|---|---|
| [`experiment/no-i18n`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/no-i18n) | `next.config.js` から `i18n` を削除 | ✅ 200（`params.id = '[id]'` で正常レンダリング） |
| [`experiment/no-sibling-index`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/no-sibling-index) | `pages/foo/index.tsx` 削除 | ✅ 404 clean（500 は消えるが bug 自体は発火）|
| [`experiment/middleware-404`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/middleware-404) | middleware で発火パターンのみ Edge 層 404 | ✅ 404 clean（Lambda 起動なし） |

---

## 検証で明らかになった副次的な事実

### 1. percent-encoded form (`%5Bid%5D`) も同様に発火

ブラウザ・クローラが encode して送ってきても、内部の文字列マッチで同じく親 index fallback が起きる。middleware の保護は **生 `[id]` と encoded `%5Bid%5D` の両方** をカバーする必要がある。

### 2. `next start` ローカルでは再現しない

Vercel の **output-tracing（route ごとに function bundle を分離）** で `pages/ja/foo.html` が `/foo/[id]` 関数のバンドルに含まれないことが ENOENT の前提。ローカル `next start` は単一プロセスで全 HTML にアクセスできるため失敗しない。デバッグの再現確認には **必ず Vercel デプロイ** が必要。

### 3. Next.js middleware matcher の i18n 自動 prepend

`i18n` 有効時、Next.js は middleware matcher の先頭に **ロケールセグメントを自動 prepend** する（`.next/server/middleware-manifest.json` のコンパイル後 regex で確認）。なので `'/foo/:path+'` 1 個だけで `/foo/...` と `/{en,ja}/foo/...` の両方を拾える。matcher を locale 別に複数書く必要は無い。

### 4. matcher への regex 制約埋め込み

`:param(regex)` 構文で path-to-regexp の制約として regex を埋め込める。

```ts
matcher: ['/foo/:id(.*\\[id\\].*|.*%5[Bb]id%5[Dd].*)']
```

この形にすると、bracket / percent-encoded を含むセグメントだけ middleware を起動できる。`/foo/abc` のような通常リクエストには Edge 関数すら起動しない。

### 5. **Vercel の matcher が case-insensitive にコンパイルされる**（重要な罠）

ローカル `next start` では path-to-regexp の regex が case-sensitive で動くが、**Vercel の edge runtime は case-insensitive フラグ付きで compile** する模様。同じ matcher source `/foo/:id(.*\\[id\\].*|...)` に対して:

| 環境 | `/foo/[Id]` の挙動 |
|---|---|
| ローカル `next start` | matcher 通らず → 200 |
| **Vercel preview** | **matcher 通って middleware 発火 → 404** |

この差で、`[Id]` `[ID]` `%5BID%5D` 等の **本来 200 で動くべき URL を middleware が誤って 404 にする regression が発生** した。preview で実テストすることで発見。

→ **対策**: matcher は今のまま pre-filter として使い、function 本体で **case-sensitive な精密判定** を追加する（後述の middleware 最終形）。

### 6. `NextRequest.nextUrl.pathname` の percent-decode 挙動は runtime 依存

WHATWG URL 仕様だと `pathname` は percent-encoded のまま保持されるが、Next.js の runtime によっては decode されている場合がある。安全のため **decoded pathname と raw URL の両方をチェック** することで、どちらの挙動でも漏れなく拾える。

---

## 公開された関連 issue・PR

### 直接一致

なし。

### 近接（症状の一部が一致）

- [vercel/next.js#39952](https://github.com/vercel/next.js/issues/39952) — `Failed to load static file ... pages/<locale>/500.html ENOENT`（二次 ENOENT と同一）→ [PR #40110](https://github.com/vercel/next.js/pull/40110) で修正
- [vercel/next.js#19296](https://github.com/vercel/next.js/issues/19296) — 動的ルートのファイル名と一致する URL で 500（i18n 無し、v10 時代、トリガー同型）
- [vercel/next.js#71131](https://github.com/vercel/next.js/issues/71131) — i18n + 不正 URL で 500（open、URL parse 段階のクラッシュ）
- [vercel/next.js#45148](https://github.com/vercel/next.js/issues/45148) — `MissingStaticPage` 系の一般的なケース
- [vercel/next.js#39255](https://github.com/vercel/next.js/issues/39255) — i18n + catch-all ルートのインタラクション
- [Discussion #37833](https://github.com/vercel/next.js/discussions/37833) — **Google クローラが `[id]` リテラル URL をインデックスする実害**（本問題の現実世界のトリガー）

### 本件の混入・修正 PR（bisect で特定）

- **[PR #58949](https://github.com/vercel/next.js/pull/58949)** （14.0.4 で merge）— `normalizeDynamicRouteParams` の呼び出しを `NextWebServer.handleCatchAllRenderRequest` に追加。これがバグを顕在化させた
- **[PR #81209](https://github.com/vercel/next.js/pull/81209)** （15.4.0 で merge）— partial fix。`hasValidParams = false` 時に「query param をそのまま使う」よう変更し、`FUNCTION_INVOCATION_FAILED` 発火を停止
- [PR #81389](https://github.com/vercel/next.js/pull/81389) （15.5.0 で merge）— `web-server.ts` ごと削除する後続クリーンアップ。ユーザー観測の挙動は #81209 から変わっていない

### 過去の周辺修正 PR

- [PR #33503](https://github.com/vercel/next.js/pull/33503) — i18n の static file check 修正
- [PR #29250](https://github.com/vercel/next.js/pull/29250) — i18n のデフォルト `/500` 修正
- [PR #40110](https://github.com/vercel/next.js/pull/40110) — カスタム `_error` / `pages/500` のハンドリング

**注**: `value?.includes(defaultValue)` という本質的な substring チェックは **15.5.18 のソースにも残ったまま**。15.4 以降の partial fix は「buggy 経路が走った後の処理を緩めた」だけで、param 正規化の誤判定自体は健在。

---

## 推奨される本対応

### 1. 流出元を直す: SEO 用 `<Head>` の `pathname` を `asPath` ベースに

ありがちなのが SEO 用 `<Head>` コンポーネントで `useRouter().pathname` を `<link rel="alternate">` 等に渡しているケース。`pathname` は route テンプレートそのまま (`/foo/[id]` 文字列リテラル) なので、全ページが `<head>` から `/foo/[id]` を Google bot に告白している状態になる。

```tsx
const { asPath } = useRouter()
const stripLocale = (p: string) => p.replace(/^\/(?:ja|en)(?=\/|$)/, '') || '/'
const canonical = stripLocale(asPath)

<link href={`${SITE_URL}${canonical}`}    hrefLang='x-default' rel='alternate' />
<link href={`${SITE_URL}/ja${canonical}`} hrefLang='ja'        rel='alternate' />
<link href={`${SITE_URL}/en${canonical}`} hrefLang='en'        rel='alternate' />
```

これで `<head>` に `[id]` リテラルが出なくなり、新たな URL がインデックスされなくなる。

### 2. middleware で `[<paramName>]` 含む URL を Edge 層 404

既にインデックス済の URL からの 500（14.0.4-15.3.x）／間違った 200（15.4+）両方を防ぐための保護策。**Next 15.4+ にアップグレード後も外せない**（params 不一致による偽 content の indexing を止めるため）:

```ts
// middleware.ts
import { NextResponse, type NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Matcher narrows to bracket-shaped URLs as cheaply as possible (so normal
  // `/foo/abc` requests don't even spawn this Edge function). The body adds
  // the precision the matcher can't provide:
  //
  // Vercel compiles path-to-regexp matchers with case-insensitive matching,
  // so the matcher's `[id]` literal also matches `[Id]`, `[ID]`, etc.
  // But the bug only fires when the URL contains the exact case-sensitive
  // substring `[id]` (matching the route's dynamic param name).
  if (
    request.nextUrl.pathname.includes('[id]') ||
    /%5[Bb]id%5[Dd]/.test(request.url)
  ) {
    return new NextResponse('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/foo/:id(.*\\[id\\].*|.*%5[Bb]id%5[Dd].*)'],
}
```

#### 設計判断のポイント

1. **`rewrite('/404')` ではなく直接 `NextResponse` で 404 を返却**
   - `/404` 自体も pure-static なので、i18n 経由で `pages/ja/404.html` を引きにいって同じバグで再爆発する可能性がある
   - Edge runtime で短絡することで Lambda にすら到達させない

2. **matcher で path-to-regexp の `:param(regex)` 構文を使う**
   - `/foo/<bracket-shape>` のときだけ Edge 関数が起動
   - 通常 dynamic route リクエスト（`/foo/abc` 等）には影響ゼロ
   - i18n の locale prefix は Next.js が自動 prepend するので 1 matcher で全形カバー

3. **function 本体で case-sensitive な精密判定を追加**
   - Vercel matcher が case-insensitive にコンパイルされる罠の回避策
   - 本来 200 で動くべき `[Id]` `[ID]` `%5BID%5D` 等を誤って 404 しないため
   - decoded pathname と raw URL の両方を checking して runtime 依存を吸収

4. **対象 route ごとに matcher を追加**
   - この repo は `pages/foo/[id]` だけが影響対象なので 1 個で済む
   - 他にも i18n + sibling-static-index + dynamic route の組み合わせがある場合は matcher を増やす（または function 本体の substring 検査を `[id]` `[slug]` `[anyParamName]` などに広げる）

### 3. Next.js 15.4 以上にアップグレード

- 500 は消える（[PR #81209](https://github.com/vercel/next.js/pull/81209) の partial fix）
- ただし **params に placeholder が入る不具合は残る**ため、上記 #2 の middleware workaround は引き続き必要
- 「Next 15 にしたから安全」ではない。**完全 fix は upstream に未着** (15.5.18 でも buggy 行残存)

### やらない方が良い対応

- **`pages/500.page.tsx` を追加するだけ**: 二次 ENOENT は消えるが **一次 ENOENT (`pages/ja/foo.html`) は残るので 500 は返り続ける**（`FUNCTION_INVOCATION_FAILED` にはならなくなる程度）。根本対応にはならない。
- **`pages/foo/index.page.tsx` を削除する**: 500 自体は消えて clean 404 になる（実証済、[`experiment/no-sibling-index`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/no-sibling-index)）。ただし「親 URL の index 表示」を犠牲にする副作用がある
- **`pages/foo/index.page.tsx` に `getStaticProps` を足す**: 理論上ロケール別 `pages/ja/foo.html` が生成され一次 ENOENT も解消するはず（未検証）。ただし sibling index ごとに対応が必要で、Next.js のバグの抜本対応とは別物
- **middleware を function 本体だけ（matcher を broad に）にする**: 通常リクエスト（`/foo/abc`）でも Edge 関数が起動してしまい無駄なコールドスタートとコスト
- **middleware を matcher だけ（function 本体に check 無し）にする**: Vercel の case-insensitive コンパイルで `[Id]` 等が誤検知される

---

## Next.js への issue 起票（推奨）

完全一致する公開報告は無いため、新規起票価値あり。詳細は [vercel-bracket-500-root-cause.md](./vercel-bracket-500-root-cause.md) の「上流への報告」セクション参照。

**タイトル案**:
> Pages Router + i18n: `normalizeDynamicRouteParams` substring check in `server-utils.ts` causes wrong params (and 500 on 14.0.4-15.3.x due to ENOENT crash; partial fix in PR #81209/15.4.0 stopped the crash but param remains incorrect placeholder)

並行して [Discussion #37833](https://github.com/vercel/next.js/discussions/37833) にも追記すると、Google クローラ起因で同じ罠を踏みかけている他ユーザに届く。

---

## 検証用ブランチ

GitHub: [liberogic-otsuka/vercel-bracket-500](https://github.com/liberogic-otsuka/vercel-bracket-500)

| ブランチ | 用途 |
|---|---|
| [`main`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/main) | 再現 baseline（Next 14.2.35 + i18n）|
| `experiment/next-13.5.11`, `next-14.0.0`, `next-14.0.4`, `next-14.1.0`, `next-14.1.4`, `next-14.2.0` | 14 系 bisect |
| `experiment/next-15.0.8`, `next-15.1.12`, `next-15.3.9`, `next-15.4.8`, `next-15.4.11`, `next-15` (=15.5.18) | 15 系 bisect |
| [`experiment/no-i18n`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/no-i18n) | i18n を外すと再現しないことを確認 |
| [`experiment/no-sibling-index`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/no-sibling-index) | sibling-static-index を削除すると 500 が clean 404 に変わることを確認 |
| [`experiment/middleware-404`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/middleware-404) | middleware workaround の動作確認（最終形）|
