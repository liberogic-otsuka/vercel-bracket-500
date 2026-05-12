# Next.js Pages Router: リテラル `[bracket]` URL で Vercel が FUNCTION_INVOCATION_FAILED になる問題の最小再現

## 概要

Next.js Pages Router で dynamic route (`pages/foo/[id].page.tsx`) を持つアプリを Vercel にデプロイし、dynamic セグメントの位置に **リテラル文字列 `[id]`** を含む URL (例: `/foo/[id]`) でアクセスすると、サーバーレス関数が `MODULE_NOT_FOUND` でクラッシュし、Vercel が `FUNCTION_INVOCATION_FAILED` (500) を返す。

- ローカル `next dev` では再現しない
- Vercel 本番デプロイでのみ発生
- Google クローラー等が pathpida などの URL ジェネレータが吐いた壊れた URL (`[id]` がリテラルのまま) をインデックスしているケースで踏む

---

## 想定環境

| 項目 | 値 |
|---|---|
| Next.js | `14.2.35` (Pages Router) |
| デプロイ先 | Vercel |
| Node runtime | `nodejs20.x` |
| ルーター | Pages Router (App Router ではない) |
| i18n | 有効 (`defaultLocale: 'ja'`, `locales: ['en', 'ja']`) |

---

## 最小再現コード

### `pages/foo/[id].page.tsx`

```tsx
import type { GetStaticPaths, GetStaticPropsContext, InferGetStaticPropsType, NextPage } from 'next'

export const getStaticProps = async (ctx: GetStaticPropsContext) => {
  return {
    props: { id: ctx.params?.id ?? null },
    revalidate: 60,
  }
}

export const getStaticPaths: GetStaticPaths = async () => {
  return {
    fallback: 'blocking',
    paths: [],
  }
}

const Page: NextPage<InferGetStaticPropsType<typeof getStaticProps>> = (props) => {
  return <div>id: {String(props.id)}</div>
}

export default Page
```

### `pages/foo/index.page.tsx`

```tsx
import type { NextPage } from 'next'

const Page: NextPage = () => <div>foo index</div>

export default Page
```

### `next.config.js`

```js
module.exports = {
  pageExtensions: ['page.tsx', 'api.ts', 'ts'],
  i18n: {
    defaultLocale: 'ja',
    locales: ['en', 'ja'],
  },
}
```

### `package.json` (要点)

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^14.2.35",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
```

---

## 再現手順

1. 上記コードでプロジェクトを作成
2. Vercel にデプロイ (例: `vercel deploy --prod`)
3. 以下の URL にアクセス
   - `https://<deployment-url>/ja/foo/[id]`
   - もしくは `https://<deployment-url>/foo/[id]`
4. ブラウザに 500 / `FUNCTION_INVOCATION_FAILED` が表示される
5. Vercel Dashboard → Runtime Logs で詳細を確認

---

## 期待される動作

`/foo/[id]` の `[id]` は URL に含まれた単なる文字列なので、いずれかの挙動になるべき:

- (A) `getStaticProps` に `ctx.params.id = '[id]'` として渡される
- (B) Next.js ルーター層が 404 を返す
- (C) 少なくとも `FUNCTION_INVOCATION_FAILED` ではなく、`getStaticProps` の `notFound: true` 等で制御できる状態である

---

## 実際の動作 (ログ抜粋)

```
GET /ja/foo/[id] → 500
Error: FUNCTION_INVOCATION_FAILED
Region: hnd1

[error] ⨯ Error: Cannot find module '/var/task/.next/server/pages/foo.js'
  code: 'MODULE_NOT_FOUND',
  page: '/ja/foo'

[error] ⨯ h [Error]: Failed to load static file for page: /ja/500
  ENOENT: no such file or directory,
  open '/var/task/.next/server/pages/ja/500.html'
```

### エラーが起きる2段階

1. **一次エラー**:
   - URL の `[id]` がリテラルなので dynamic segment 解決に失敗
   - Next.js 内部が **parent index** (`pages/foo/index.page.tsx` のビルド出力 `pages/foo.js`) を require しようとする
   - Vercel のサーバーレス関数バンドルは route ごとに output-trace されているので `pages/foo.js` は `[id]` 用の関数バンドルに含まれず → `MODULE_NOT_FOUND`
2. **二次エラー**:
   - Next.js は `/ja/500.html` を返そうとする
   - `pages/500.tsx` (または `500.page.tsx`) を作っていないので静的HTMLが事前生成されていない → ENOENT
   - 関数自体が落ちて `FUNCTION_INVOCATION_FAILED`

---

## 関連 issue

- [vercel/next.js#19296](https://github.com/vercel/next.js/issues/19296) — Navigating to a dynamic route that matches the page's filename causes a 500 response and an empty query (closed, 症状は同一)
- [vercel/next.js#39952](https://github.com/vercel/next.js/issues/39952) — Serverless function error with custom 500 page
- [opennextjs/opennextjs-aws#366](https://github.com/opennextjs/opennextjs-aws/issues/366) — Failed to load static file ENOENT (サーバーレス + Pages Router 全般で起きる)

---

## ワークアラウンド案

### 案A: middleware で `[` `]` を含む URL を 404 にする

```ts
// middleware.ts
import { NextResponse, type NextRequest } from 'next/server'

const containsBracketLiteral = (pathname: string) =>
  pathname.includes('[') || pathname.includes(']') || /%5[bd]/i.test(pathname)

export function middleware(request: NextRequest) {
  if (containsBracketLiteral(request.nextUrl.pathname)) {
    return NextResponse.rewrite(new URL('/404', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/foo/:path+'],
}
```

### 案B: `pages/500.page.tsx` を追加

少なくとも二次エラー (ENOENT による `FUNCTION_INVOCATION_FAILED`) は防げ、正常な 500 静的レスポンスが返るようになる。

---

## 検証したい変数 (新レポでの確認項目)

最小構成での再現可否を判定したいパラメータ:

- [ ] **i18n の有無**: `i18n` 設定を外しても再現するか
- [ ] **pageExtensions**: `pageExtensions` をデフォルトに戻しても再現するか
- [ ] **Node runtime**: 20.x / 22.x / 24.x で挙動が変わるか
- [ ] **Next.js バージョン**: 14.2.x / 14.3.x / 15.x で挙動が変わるか
- [ ] **fallback モード**: `fallback: 'blocking'` / `false` / `true` で挙動が変わるか
- [ ] **sibling index の有無**: `pages/foo/index.page.tsx` を消すと再現しないか
- [ ] **catch-all**: `pages/[...id].page.tsx` 単独だと再現するか
- [ ] **ネスト深さ**: `pages/a/b/[id].page.tsx` のように深いと挙動が変わるか
- [ ] **`pages/500.page.tsx` 追加**: 二次エラーは消えるが一次エラーは残るかの切り分け

---

## メモ

- 本番でのみ発生する理由: ローカル `next dev` は `.next/server/pages/*.html` をオンデマンドで生成し、output-tracing も行わないため、`MODULE_NOT_FOUND` も `ENOENT` も発生しない
- `next start` でビルド済みを起動した場合は再現する可能性あり (検証推奨)
