# Root Cause: `[id]` URL → ENOENT / FUNCTION_INVOCATION_FAILED の真因

本ドキュメントは [`vercel-bracket-500-findings.md`](./vercel-bracket-500-findings.md) で記述した症状の **真因コードと PR** を bisect により特定した記録です。

---

## TL;DR

- **混入 PR**: [vercel/next.js#58949](https://github.com/vercel/next.js/pull/58949) — `fix: properly call normalizeDynamicRouteParams in NextWebServer.handleCatchAllRenderRequest`
  - 混入バージョン: **Next.js 14.0.4** (merge: 2023-12-05, release: 2023-12-07)
- **真因コード（1 行）**: `packages/next/src/server/server-utils.ts` の `normalizeDynamicRouteParams` 内、`value?.includes(defaultValue as string)` という **substring チェック**
- **partial fix PR**: [vercel/next.js#81209](https://github.com/vercel/next.js/pull/81209) — `Update matching query and route param handling`
  - 修正バージョン: **Next.js 15.4.0** (merge: 2025-07-03, release: 2025-07-14)
  - `hasValidParams = false` 時に query param をそのまま使うよう変更 → クラッシュは消えたが、**params に placeholder `[id]` が入る別の不具合は残存**
- **後続のクリーンアップ**: [PR #81389](https://github.com/vercel/next.js/pull/81389) — `Remove web-server from edge-ssr-app` (15.5.0 release) で `NextWebServer` クラスごと削除。ユーザー観測の挙動は変わらない
- **`.includes()` の substring チェックそのものを修正した PR は存在しない**。15.5.18 のソースにも残っている

### 観測される挙動の対応表

| Next.js | 500 する？ | params 正確？ |
|---|---|---|
| 14.0.0 | ❌ | ✅ |
| 14.0.4 〜 15.3.x | 🔥 | (測れない) |
| **15.4.0** 以降 | ✅ | ❌ placeholder `[id]` が入る |

---

## バージョン bisect の経緯

ブランチで実際に Vercel デプロイして本番挙動を観測しました。`/foo/[id]` および fresh URL（cache MISS させて関数本体まで通すため）で測定。

| Next.js | 500 する？ | params 正確？ | 検証ブランチ |
|---|---|---|---|
| 13.5.11 | ❌ | ✅ | [`experiment/next-13.5.11`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-13.5.11) |
| 14.0.0 | ❌ | ✅ | [`experiment/next-14.0.0`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.0.0) |
| 14.0.4 | 🔥 FUNCTION_INVOCATION_FAILED | (測れない) | [`experiment/next-14.0.4`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.0.4) |
| 14.1.0 | 🔥 | (測れない) | [`experiment/next-14.1.0`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.1.0) |
| 14.1.4 | 🔥 | (測れない) | [`experiment/next-14.1.4`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.1.4) |
| 14.2.0 | 🔥 | (測れない) | [`experiment/next-14.2.0`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-14.2.0) |
| 14.2.35 | 🔥 | (測れない) | [`main`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/main) |
| 15.0.8 | 🔥 | (測れない) | [`experiment/next-15.0.8`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.0.8) |
| 15.1.12 | 🔥 | (測れない) | [`experiment/next-15.1.12`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.1.12) |
| 15.3.9 | 🔥 | (測れない) | [`experiment/next-15.3.9`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.3.9) |
| **15.4.8** | ✅ | ❌ placeholder `[id]` | [`experiment/next-15.4.8`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.4.8) |
| 15.4.11 | ✅ | ❌ placeholder `[id]` | [`experiment/next-15.4.11`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15.4.11) |
| 15.5.18 | ✅ | ❌ placeholder `[id]` | [`experiment/next-15`](https://github.com/liberogic-otsuka/vercel-bracket-500/tree/experiment/next-15) |

→ **混入の境界は 14.0.0 ↔ 14.0.4 の間**。14.0.4 changelog の [#58949](https://github.com/vercel/next.js/pull/58949) が観測症状と完全一致するため確定。

→ **partial fix の境界は 15.3.9 ↔ 15.4.8 の間**。15.4.0〜15.4.7 は CVE-2025-66478 で Vercel に deploy できないので実機未確認だが、[PR #81209](https://github.com/vercel/next.js/pull/81209) が 15.4.0 の前 (2025-07-03 merge) に入っているため、**15.4.0 で landed と判定**。

### 副次的に確認したこと

- **`experiment/no-i18n`**: i18n を外すと再現せず → 必要条件
- **`experiment/no-sibling-index`**: `pages/foo/index.tsx` を削除すると **500 が消えて clean 404 になる** → sibling-static-index は「500 にエスカレーションするための条件」であって、param 正規化バグそのものの条件ではない

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

## 修正版（Next 15.4.0 で 500 が消えた理由）

ソース調査と実機 bisect の結果、修正の実体は **「buggy 行を直した」のではなく「buggy 行が走ったときの結果を softer な fallback に変えた」** ことが判明しました。

### `.includes()` 行はずっと残っている

`packages/next/src/server/server-utils.ts` の `normalizeDynamicRouteParams` 内、犯人の 1 行をバージョン横断で grep で追うと:

| バージョン | 該当行 | `web-server.ts` 存在 |
|---|---|---|
| 14.0.4 | `value?.includes(defaultValue as string)` | あり（buggy 呼び出し済み）|
| 14.2.35 | **同じ** | あり |
| 15.0.0 〜 15.4.x | **同じ** | あり |
| **15.5.0** | **同じ（変更なし）** | 削除 |
| 15.5.18 | 同じ | 削除 |

`value?.includes(defaultValue)` という substring チェックは現在のソース (15.5.18) にも残っている。`hasValidParams = false` になる経路は健在。

### partial fix の正体: PR #81209

- [PR #81209](https://github.com/vercel/next.js/pull/81209) — `Update matching query and route param handling`
- merge: 2025-07-03、+37/-29 行
- 15.4.0（2025-07-14 release）に含まれた

PR body にこう書かれている:

> Validated this is un-necessary and handling an edge case we don't need to be worried about and **it's better to leave the query param for this case instead**

つまり「`hasValidParams = false` 時に params を捨てて親 index へ fallback するんじゃなく、生の query param をそのまま使え」 という変更。これにより:

- 14.0.4〜15.3.x: `hasValidParams = false` → `normalizedParams = query` → `interpolateDynamicPath` で誤った経路 → 親 index `/ja/foo` を render → **`pages/ja/foo.html` ENOENT → クラッシュ → FUNCTION_INVOCATION_FAILED**
- 15.4.0 以降: `hasValidParams = false` の処理経路が変わり、関数自身は **placeholder 値 `[id]` を `params` に入れたまま 200 で render**

### 精確には: `params.<paramName>` は URL の実値に関係なく一律 `[<paramName>]` 固定になる

「params が壊れる」 を実測ベースで精確に書くと:

> URL の <パス> セグメントに `[<paramName>]` という substring が含まれている時、`params.<paramName>` の値が **URL の実値に関係なく一律 `[<paramName>]` 固定** になる

これは、ユーザーが本当に `[<paramName>]` を id 値として送りたかった場合 (`/foo/[id]` ぴったり) に限り **偶然正解** になるが、それ以外は URL 上の情報が失われる。実測:

| URL | 開発者の意図する `params.id` | 15.4+ の実際の `params.id` | 一致？ |
|---|---|---|---|
| `/foo/[id]` | `'[id]'` | `'[id]'` | ✅ まぐれで正解 |
| `/foo/[id]hoge` | `'[id]hoge'` | `'[id]'` | ❌ |
| `/foo/x[id]y` | `'x[id]y'` | `'[id]'` | ❌ |
| `/foo/abc[id]xyz` | `'abc[id]xyz'` | `'[id]'` | ❌ |
| `/foo/[example]` | `'[example]'` | `'[example]'` | ✅ buggy 経路に入らない |
| `/foo/normal-id` | `'normal-id'` | `'normal-id'` | ✅ 同上 |

実害として最大のものは「**substring が含まれる複数の URL がすべて同じ content (`id: [id]` ページ) を返す**」 こと:

- `/foo/aaa[id]bbb`、`/foo/cb1234[id]`、`/foo/[id]freshtest` が **全部同じ HTML 内容** を serve する
- Google から見ると **canonical 重複 + 偽 content** → サイト全体の品質スコア低下
- ISR cache キーは URL ごとなので **無駄なキャッシュエントリが無限に増える**

### 補足: PR #81389 は副次的なクリーンアップ

- [PR #81389](https://github.com/vercel/next.js/pull/81389) — `Remove web-server from edge-ssr-app`（15.5.0 で merge）
- `web-server.ts` ファイルを削除した大きなリファクタ
- ただし **ユーザー観測の挙動は 15.4.0 → 15.5.0 で変化していない**（partial fix の状態は同じ）
- 「Next 15 で fix」と表現されるが、ユーザー観測上の改善は **すでに 15.4.0 で起きていた**

### partial fix の限界

partial fix で **可用性** は復旧したが、**正確性** は壊れたまま:

| 観点 | 14.2.35 | 15.4.0 〜 15.5.18 |
|---|---|---|
| FUNCTION_INVOCATION_FAILED | 🔥 する | ✅ しない |
| Lambda 課金 | 累積する | 累積する（200 でも 1 req 1 invocation）|
| 表示内容 | 500 ページ | `id: [id]` と書かれた `/foo/<元の URL 値>` ページ |
| Google が index する | 500 → 排除される | **200 → 間違った content で index される** |
| SEO 上の害 | 一時的な品質悪化 | **canonical 重複 + 偽 content** で潜在的にもっと厄介 |

「500 が出なくなった」 だけ見ると改善だが、SEO 観点では **15.4 以降で逆に悪化する可能性も**。Google が壊れた URL を 200 として正常認識し始めるので、本 repo の middleware workaround は **15.5+ にアップグレードしても外せない**。

### まとめ

- **本質的な fix は未だに存在しない**。`.includes()` の substring チェックも `defaultRouteMatches` の計算も 15.5.18 でそのまま
- 14.0.4 〜 15.3.x のいずれを使っていても **500 は発生する**
- 15.4.0 以降は **500 は出ないが params 不一致による別の問題が顕在化**
- 14.x を使い続けるなら **本リポジトリの middleware workaround を本番投入**
- 15.4+ にアップグレードしても上記 workaround は外せない（SEO 観点）

---

## 上流への報告（推奨）

公開 issue で完全一致するものは未報告（[vercel-bracket-500-findings.md](./vercel-bracket-500-findings.md) 参照）。

報告時に含めるべき情報:

1. **再現リポジトリ**: [liberogic-otsuka/vercel-bracket-500](https://github.com/liberogic-otsuka/vercel-bracket-500)
2. **混入と partial fix の境界**:
   - 混入: 14.0.4（[PR #58949](https://github.com/vercel/next.js/pull/58949)）
   - partial fix: 15.4.0（[PR #81209](https://github.com/vercel/next.js/pull/81209)）— 500 は消えたが placeholder `[id]` が params に入る不具合に変質
3. **真因コード**: `packages/next/src/server/server-utils.ts` の `value?.includes(defaultValue as string)` substring チェック。**15.5.18 でも未修正**
4. **影響範囲**:
   - 14.0.4 〜 15.3.x: `FUNCTION_INVOCATION_FAILED` を引き起こす（Pages Router + i18n + sibling-static-index + URL に `[<paramName>]` substring の組み合わせ）
   - 15.4.0 以降: 上記症状は消えるが、URL に `[<paramName>]` substring を含むリクエストで **`params.<paramName>` に placeholder `[<paramName>]` が入る**（URL 実値が失われる）
5. **症状**: 14.x の場合は 2 段 ENOENT → `FUNCTION_INVOCATION_FAILED`（[vercel-bracket-500-findings.md](./vercel-bracket-500-findings.md) のログ抜粋参照）

タイトル案:

> Pages Router + i18n: `normalizeDynamicRouteParams` substring check in `server-utils.ts` causes wrong params (and 500 on 14.0.4-15.3.x due to ENOENT crash; partial fix in PR #81209/15.4.0 stopped the crash but param remains incorrect placeholder)

ポイントは 「**500 は止まったが本質は未修正**」 を明示すること。15.4+ でも middleware による URL 弾きが必要、という現実を伝えやすくなる。
