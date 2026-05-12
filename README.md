# vercel-bracket-500-repro

最小再現環境。詳細は [`vercel-bracket-500-repro.md`](./vercel-bracket-500-repro.md) を参照。

## ファイル構成

```
.
├── next.config.js              # pageExtensions + i18n
├── pages/
│   ├── index.page.tsx          # トップ。各検証 URL へのリンクあり
│   └── foo/
│       ├── index.page.tsx      # sibling index (再現に必要)
│       └── [id].page.tsx       # dynamic route (再現対象)
├── scripts/repro.mjs           # ローカル/本番に対する一括 HTTP チェッカ
└── tsconfig.json
```

## セットアップ

```bash
npm install
npm run build         # output-tracing を含めて本番ビルドを生成
npm start             # next start で本番モード起動 (ローカル再現の検証用)
```

別ターミナルで:

```bash
node scripts/repro.mjs http://localhost:3000
```

## 検証 URL

| パス | 期待挙動 (Vercel 本番) | 実挙動 (issue) |
|---|---|---|
| `/` | 200 | 200 |
| `/foo` | 200 | 200 |
| `/foo/abc` | 200 (blocking SSR) | 200 |
| `/foo/[id]` | 404 もしくは `id="[id]"` で 200 | **500 FUNCTION_INVOCATION_FAILED** |
| `/ja/foo/[id]` | 同上 | **500 FUNCTION_INVOCATION_FAILED** |
| `/foo/%5Bid%5D` | percent-encoded 経由の挙動比較用 | (要確認) |

## Vercel デプロイ

```bash
npx vercel link
npx vercel deploy --prod
node scripts/repro.mjs https://<deployment>.vercel.app
```

## 検証フラグ（repro.md チェックリスト対応）

順次切り替えて再現条件を狭めるための提案手順:

1. **そのまま**: 上記構成で `/foo/[id]` → 500 を確認 (ベースライン)
2. **i18n を外す**: `next.config.js` の `i18n` をコメントアウト
3. **pageExtensions をデフォルトに戻す**: `pageExtensions` を消し、ファイル名を `[id].tsx` / `index.tsx` にリネーム
4. **sibling index を消す**: `pages/foo/index.page.tsx` を削除
5. **fallback 切り替え**: `[id].page.tsx` の `fallback` を `false` / `true` に変更
6. **catch-all 化**: `[id].page.tsx` を `[...id].page.tsx` にリネーム
7. **ネスト深さ**: `pages/foo/bar/[id].page.tsx` に移して再ビルド
8. **`500.page.tsx` 追加**: 二次エラー (ENOENT) の切り分け
9. **Next バージョン**: `package.json` の `next` を `14.2.x` → `14.3.x` / `15.x` で再検証

毎回 `npm run build && npx vercel deploy --prod` で確認するのが正攻法。
