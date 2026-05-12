# Next.js Pages Router: リテラル `[id]` URL で Vercel が FUNCTION_INVOCATION_FAILED になる問題 — 検証結果

本ドキュメントは [`vercel-bracket-500-repro.md`](./vercel-bracket-500-repro.md) で記述された問題を最小再現プロジェクトで段階的に検証した結果のサマリです。

---

## TL;DR

- **Next.js 14.2.x Pages Router + i18n** の組み合わせ固有のバグ
- **Next.js 15.x で修正済み**（15.5.18 で挙動消失を確認）
- 元 repro.md の推測（`MODULE_NOT_FOUND`）は外れ。実際は **2 段 ENOENT の連鎖**
- 発火条件は当初想定より遥かに狭く、URL pathname に **`[id]` という文字列が含まれる（case-sensitive、route の dynamic param 名と完全一致）** ことが必須
- 公開 issue・SO・Zenn 等で完全一致する事例は **未報告**
- 短期回避策: **middleware で `[id]` 含む URL を Edge 層で 404**（Lambda にすら到達させない）

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

- **Next.js 14.2.x** 系（14.2.35 で確認、15.x で修正済み）
- **`i18n` 有効** in `next.config.js`
- **pure-static な sibling index**（`pages/foo/index.page.tsx` に `getStaticProps` 無し）

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

---

## 検証ブランチ別の結果

| Branch | 変更内容 | `/foo/[id]` の挙動 |
|---|---|---|
| [`main`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/main) | 仕様通り（Next 14.2.35 + i18n + sibling-static-index） | 🔥 **500 / FUNCTION_INVOCATION_FAILED** |
| [`experiment/no-i18n`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/no-i18n) | `next.config.js` から `i18n` を削除 | ✅ **200**（`params.id = '[id]'` として正常レンダリング） |
| [`experiment/next-15`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15) | Next を `15.5.18` に bump（i18n 維持） | ✅ **200**（`locale=ja` でも正常） |
| [`experiment/middleware-404`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/middleware-404) | middleware で発火パターンのみ Edge 層 404 | ✅ **404 clean**（Lambda 起動なし） |

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

### 過去の修正 PR（同じコード経路）

- [PR #33503](https://github.com/vercel/next.js/pull/33503) — i18n の static file check 修正
- [PR #29250](https://github.com/vercel/next.js/pull/29250) — i18n のデフォルト `/500` 修正
- [PR #40110](https://github.com/vercel/next.js/pull/40110) — カスタム `_error` / `pages/500` のハンドリング
- [PR #77905](https://github.com/vercel/next.js/pull/77905) — App Router not-found と Pages i18n config の併用

Next 15.5.18 で fix されているが、原因 PR は単一ではなく 15.x 系のルーティング再構成全体に分散していると思われる。

---

## 推奨される本対応

### 恒久対応：Next.js 15 へアップグレード（最優先）

- i18n を維持したまま問題が消える
- 検証済み：`experiment/next-15` ブランチ（Next 15.5.18 + React 18.3.1）

### 短期対応：middleware で `[id]` 含む URL を Edge 層 404

Next 15 にすぐ上げられない場合の保護策。**実プロジェクトで踏むべき最終形**:

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

### やらない方が良い対応

- **`pages/500.page.tsx` を追加するだけ**: 二次 ENOENT は消えるが **一次 ENOENT (`pages/ja/foo.html`) は残るので 500 は返り続ける**（`FUNCTION_INVOCATION_FAILED` にはならなくなる程度）。根本対応にはならない。
- **`pages/foo/index.page.tsx` に `getStaticProps` を足す**: 理論上ロケール別 `pages/ja/foo.html` が生成され一次 ENOENT も解消するはず（未検証）。ただし sibling index ごとに対応が必要で、Next.js のバグの抜本対応とは別物。
- **middleware を function 本体だけ（matcher を broad に）にする**: 通常リクエスト（`/foo/abc`）でも Edge 関数が起動してしまい無駄なコールドスタートとコスト。
- **middleware を matcher だけ（function 本体に check 無し）にする**: Vercel の case-insensitive コンパイルで `[Id]` 等が誤検知される。

---

## Next.js への issue 起票（推奨）

完全一致する公開報告は無いため、新規起票価値あり。

**タイトル案**:
> Pages Router + i18n: URL containing literal `[<paramName>]` substring causes ENOENT for locale-prefixed sibling index, then FUNCTION_INVOCATION_FAILED (14.2.x, fixed in 15)

**含めるべき内容**:
- 最小再現プロジェクト URL（この repo）
- Vercel runtime log（ENOENT 2 段）
- 発火条件マトリクス（substring 単位の case-sensitive 判定であること、prefix/suffix も発火することを示す）
- 検証マトリクス（i18n 外す/Next 15 で消える）
- 関連 issue cross-link: #19296, #39952, #71131, Discussion #37833
- Next 15.5.18 で fix 済みである事実 → メンテナが原因 PR を bisect & 14.2 への backport を判断しやすくする

並行して [Discussion #37833](https://github.com/vercel/next.js/discussions/37833) にも追記すると、Google クローラ起因で同じ罠を踏みかけている他ユーザに届く。

---

## 検証用ブランチ

GitHub: [liberogic-otsuka/vercel-bracket-500](https://github.com/liberogic-otsuka/vercel-bracket-500)

- [`main`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/main) — 再現 baseline（Next 14.2.35 + i18n）
- [`experiment/no-i18n`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/no-i18n) — i18n を外して挙動確認
- [`experiment/next-15`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15) — Next 15 で修正済みを確認
- [`experiment/middleware-404`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/middleware-404) — middleware による短期回避策（最終形）
