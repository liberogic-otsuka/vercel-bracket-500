# Root Cause: `[id]` URL → ENOENT / FUNCTION_INVOCATION_FAILED の真因

本ドキュメントは [`vercel-bracket-500-findings.md`](./vercel-bracket-500-findings.md) で記述した症状の **真因コードと PR** を bisect により特定した記録です。

---

## TL;DR

- **原因 PR**: [vercel/next.js#58949](https://github.com/vercel/next.js/pull/58949) — `fix: properly call normalizeDynamicRouteParams in NextWebServer.handleCatchAllRenderRequest`
- **混入バージョン**: **Next.js 14.0.4** (merge: 2023-12-05, release: 2023-12-07)
- **真因コード（1 行）**: `packages/next/src/server/server-utils.ts` の `normalizeDynamicRouteParams` 内、
  `value?.includes(defaultValue as string)` という **substring チェック**
- **修正バージョン**: **Next.js 15.5.0**（[PR #81389](https://github.com/vercel/next.js/pull/81389) で `NextWebServer` クラスと `web-server.ts` ごと削除されたため、buggy 呼び出し経路自体が消滅）
  - 注: buggy 行 `value?.includes(defaultValue)` は今でも `server-utils.ts` に残っている。**コードはそのままで、呼ばれなくなった** だけ。

---

## バージョン bisect の経緯

ブランチで実際にデプロイして本番挙動を観測しました。

| Next.js | 結果 (`/foo/[id]`) | 検証ブランチ |
|---|---|---|
| **13.5.11** | ✅ 200（正常レンダリング） | [`experiment/next-13.5.11`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-13.5.11) |
| **14.0.0** | ✅ 200 | [`experiment/next-14.0.0`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.0.0) |
| **14.0.4** | 🔥 500 / FUNCTION_INVOCATION_FAILED | [`experiment/next-14.0.4`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.0.4) |
| **14.1.0** | 🔥 500 | [`experiment/next-14.1.0`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.1.0) |
| **14.1.4** | 🔥 500 | [`experiment/next-14.1.4`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.1.4) |
| **14.2.0** | 🔥 500 | [`experiment/next-14.2.0`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.2.0) |
| **14.2.35** | 🔥 500 | [`main`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/main) |
| 15.0.0 〜 15.4.x | ❓ 未検証（ソース上は buggy 呼び出し残存 → **壊れている見込み**） | — |
| **15.5.18** | ✅ 200 | [`experiment/next-15`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15) |

→ **混入の境界は 14.0.0 ↔ 14.0.4 の間**。14.0.1, 14.0.2, 14.0.3 はデプロイ実測していないが、14.0.4 changelog の [#58949](https://github.com/vercel/next.js/pull/58949) の中身が観測症状と完全一致するため、これが原因と確定。

→ **修正の境界は 15.4.x ↔ 15.5.0 の間** と推定。15.0.0 〜 15.4.x も `web-server.ts` に buggy 呼び出しが残ったままだったので、これらの版でも症状は出る可能性が高い（実機未検証）。

---

## 原因 PR の解説

### Before（14.0.0 = 正常動作）

`NextWebServer.handleCatchAllRenderRequest`（`packages/next/src/server/web-server.ts`）の dynamic route handling は素直:

```ts
if (isDynamicRoute(pathname)) {
  const routeRegex = getNamedRouteRegex(pathname, false)
  pathname = interpolateDynamicPath(pathname, query, routeRegex)
  normalizeVercelUrl(...)
}
```

`normalizeDynamicRouteParams` は呼ばれない。URL の `[id]` リテラルはそのまま `query.id = '[id]'` として渡る。

### After（14.0.4 以降 = バグる）

[#58949](https://github.com/vercel/next.js/pull/58949) が **`normalizeDynamicRouteParams` の呼び出しを新規追加**:

```ts
if (isDynamicRoute(pathname)) {
  const routeRegex = getNamedRouteRegex(pathname, false)
  const dynamicRouteMatcher = getRouteMatcher(routeRegex)
  const defaultRouteMatches = dynamicRouteMatcher(pathname)
  //  ↑ pathname はルートテンプレート `/foo/[id]` なので
  //     defaultRouteMatches = { id: '[id]' } になる

  const paramsResult = normalizeDynamicRouteParams(
    query,
    false,
    routeRegex,
    defaultRouteMatches
  )
  const normalizedParams = paramsResult.hasValidParams
    ? paramsResult.params
    : query  // ← hasValidParams=false なら params が「無効」扱いになる
  pathname = interpolateDynamicPath(
    pathname,
    normalizedParams,
    routeRegex
  )
}
```

### 真因のコード行

`packages/next/src/server/server-utils.ts` 内の `normalizeDynamicRouteParams`:

```ts
const isDefaultValue = Array.isArray(defaultValue)
  ? defaultValue.some((defaultVal) => {
      return Array.isArray(value)
        ? value.some((val) => val.includes(defaultVal))
        : value?.includes(defaultVal)
    })
  : value?.includes(defaultValue as string)   // ★ ここが substring check
```

ユーザー入力の `value` がルートテンプレートの **placeholder 文字列 `[id]` を `.includes()` で含むか** を判定している。`===` での完全一致ではなく **substring 一致** が使われているのが致命的な誤り。

`isDefaultValue` が true になると:

```ts
if (
  isDefaultValue ||
  (typeof value === 'undefined' && !(isOptional && ignoreOptional))
) {
  hasValidParams = false
}
```

`hasValidParams = false` になる。すると呼び出し元で `normalizedParams = query` に巻き戻され、その後の `interpolateDynamicPath` で誤った経路に進み、最終的に **親 index への内部 fallback** → 一次 ENOENT (`pages/ja/foo.html` を探しにいって失敗) → 二次 ENOENT (`pages/ja/500.html` も無い) → 関数クラッシュ → `FUNCTION_INVOCATION_FAILED`。

---

## 観測した境界条件を真因コードに照らし合わせる

`value.includes('[id]')` という 1 行の挙動で、本番で観測した全境界が説明できる:

| 入力 URL | `value`（param 値）| `defaultValue` | `value.includes(defaultValue)` | 観測結果 |
|---|---|---|---|---|
| `/foo/[id]` | `'[id]'` | `'[id]'` | **true** | 🔥 500 |
| `/foo/x[id]y` | `'x[id]y'` | `'[id]'` | **true** | 🔥 500 |
| `/foo/abc[id]xyz` | `'abc[id]xyz'` | `'[id]'` | **true** | 🔥 500 |
| `/foo/[id]x` | `'[id]x'` | `'[id]'` | **true** | 🔥 500 |
| `/foo/%5Bid%5D` | decode 後 `'[id]'` | `'[id]'` | **true** | 🔥 500 |
| `/foo/%5bid%5d` | decode 後 `'[id]'` | `'[id]'` | **true** | 🔥 500 |
| `/foo/[Id]` | `'[Id]'` | `'[id]'` | false（case-sensitive）| ✅ 200 |
| `/foo/[ID]` | `'[ID]'` | `'[id]'` | false | ✅ 200 |
| `/foo/[example]` | `'[example]'` | `'[id]'` | false | ✅ 200 |
| `/foo/[id` | `'[id'` | `'[id]'` | false（`]` 欠落）| ✅ 200 |
| `/foo/id]` | `'id]'` | `'[id]'` | false（`[` 欠落）| ✅ 200 |
| `/foo/%5BID%5D` | decode 後 `'[ID]'` | `'[id]'` | false | ✅ 200 |

**全境界が「URL 内に case-sensitive な substring `[<paramName>]` が含まれるか」 という 1 行のロジックから機械的に導ける**。

---

## なぜ App Router でなく Pages Router + i18n の組み合わせが顕在化したか

`NextWebServer.handleCatchAllRenderRequest` は Vercel の Edge Runtime + Pages Router 経路で使われる。

- Pages Router + i18n: `params.id = '[id]'` で異常判定 → 親 index `/ja/foo` への fallback → `pages/ja/foo.html` 不在 → ENOENT
- Pages Router + i18n なし: 親 index へ fallback はするが `pages/foo.html` は存在するので 200 で帰る（実証は無いがコードパスから推測）
- App Router: 別の経路（PR の本来のターゲット）であり、修正された挙動が期待通り

つまり PR は App Router を直そうとして、副作用で Pages Router + i18n + sibling static index の組み合わせを壊した、と解釈できる。

---

## なぜ 13.5.11 と 14.0.0 では発火しないか

- 13.x: `NextWebServer.handleCatchAllRenderRequest` のコード構造が異なり、`normalizeDynamicRouteParams` は呼ばれない
- 14.0.0: `handleCatchAllRenderRequest` は存在するが、PR #58949 がまだ merge されていないので `normalizeDynamicRouteParams` は呼ばれない（buggy な `.includes()` チェック自体は別の経路にあったがそこは Vercel Edge を通らない）

PR #58949 の本質的な変更は、**「buggy な substring チェック関数を NextWebServer から呼ぶようにした」** こと。バグそのものは関数の中（`server-utils.ts`）に既に存在していたが、Vercel Edge ランタイムからは到達できなかった。

---

## 修正版（Next 15.5.0 で発火しなくなった理由）

ソース調査の結果、修正の実体は **「buggy 行を直した」のではなく「buggy 行を呼ぶ経路ごと削除した」** ことが判明しました。

### 確認できる事実

`packages/next/src/server/server-utils.ts` の `normalizeDynamicRouteParams` 内、犯人の 1 行をバージョン横断で grep で追うと:

| バージョン | 該当行 | `web-server.ts` 存在 |
|---|---|---|
| 14.0.4 | `value?.includes(defaultValue as string)` | あり（buggy 呼び出し済み）|
| 14.2.35 | **同じ** | あり |
| 15.0.0 | **同じ** | あり |
| 15.1.0 | **同じ** | あり |
| 15.2.0 | **同じ** | あり |
| 15.3.0 | **同じ** | あり |
| 15.4.0 | **同じ** | あり |
| **15.5.0** | **同じ（変更なし）** | **削除** |
| 15.5.18 | 同じ | 削除 |

つまり問題の **`value?.includes(defaultValue)` という substring チェックは現在のソース (15.5.18) にも残っている**。修正されたのは **呼び出し側**。

### 修正の正体: PR #81389（`NextWebServer` クラスごと削除）

- [PR #81389](https://github.com/vercel/next.js/pull/81389) — `Remove web-server from edge-ssr-app`
- merge: 2025-07-21、+389/-701 行
- `packages/next/src/server/web-server.ts` ファイル自体を削除
- 15.5.0（2025-08-20 release）に含まれた

このリファクタにより、Vercel Edge runtime が Pages Router を扱う際の経路が変わり、PR #58949 で追加された `normalizeDynamicRouteParams` の呼び出し（→ buggy `.includes()` への到達経路）が消滅した。

### つまり

- **修正そのものは PR #58949 への直接の修正ではなく、関係する経路全体の architecture 変更の副産物**
- `value.includes(defaultValue)` の置き換えや `defaultRouteMatches` 計算の見直しといった「ピンポイント修正」は行われていない
- 14.2 系への backport は架構上難しい（`NextWebServer` 自体を消すことを意味するため）
- 14.x を使い続けるなら **本リポジトリの middleware workaround を本番投入するか、Next.js 15.5.x へアップグレード** が現実解

### 注意: 15.0 〜 15.4.x も「壊れている見込み」

15.0.0 〜 15.4.x には buggy 呼び出しがそのまま残っているため、これらの版で動かしている場合は同じ症状が出る可能性が高い。実機での確認は未実施。**「Next 15 にしたから安全」ではなく「Next 15.5.0 以降にしたから安全」** が正確。

---

## 上流への報告（推奨）

公開 issue で完全一致するものは未報告（[vercel-bracket-500-findings.md](./vercel-bracket-500-findings.md) 参照）。

報告時に含めるべき情報:

1. **再現リポジトリ**: [liberogic-otsuka/vercel-bracket-500](https://github.com/liberogic-otsuka/vercel-bracket-500)
2. **回帰の境界**: 14.0.0 ✅ / 14.0.4 🔥
3. **真因コミット**: [PR #58949](https://github.com/vercel/next.js/pull/58949) — `value.includes(defaultValue)` の substring チェック
4. **顕在化しなくなった経緯**: [PR #81389](https://github.com/vercel/next.js/pull/81389) で `NextWebServer` 削除 → 15.5.0 に含まれる。buggy 行自体は `server-utils.ts` に残存
5. **影響範囲**: Pages Router + `i18n` 有効 + sibling-static-index + URL に `[<paramName>]` substring の組み合わせ
6. **未解決の懸念**: 15.0.0 〜 15.4.x は架構上同じ buggy 経路を持つので壊れているはずだが実機未検証。`server-utils.ts` 内の substring チェックは 15.5.18 にも残っており、別の呼び出し経路で同様の症状を起こす可能性が将来出てくるかもしれない
7. **症状**: 2 段 ENOENT → `FUNCTION_INVOCATION_FAILED`（[vercel-bracket-500-findings.md](./vercel-bracket-500-findings.md) のログ抜粋参照）

タイトル案（前回より具体化）:

> Pages Router + i18n: PR #58949's substring check in `normalizeDynamicRouteParams` causes ENOENT crash for URLs containing `[<paramName>]` literal (regression in 14.0.4, no longer reachable after web-server.ts removal in 15.5.0; buggy line still in source)

これで Next.js メンテナは bisect 不要で原因 line に直接アクセスでき、14.2 系への backport 判断（実質 `web-server.ts` 削除を要するため難しいことの理解）もしやすい。また「14.0.4 〜 15.4.x すべて要 patch」と捉えるべきという範囲も明示できる。
