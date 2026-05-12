#!/usr/bin/env node
/**
 * Local + remote reproduction helper.
 *
 * Hits the URLs described in vercel-bracket-500-repro.md against a given base
 * URL and prints the status / body so you can compare `next dev`, `next start`,
 * and a Vercel deployment side-by-side.
 *
 * Usage:
 *   node scripts/repro.mjs                            # defaults to http://localhost:3000
 *   node scripts/repro.mjs http://localhost:3000
 *   node scripts/repro.mjs https://<deployment>.vercel.app
 */

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')

const targets = [
  { label: 'sanity / root',                 path: '/' },
  { label: 'sibling index',                 path: '/foo' },
  { label: 'normal dynamic',                path: '/foo/abc' },
  { label: 'literal bracket (no locale)',   path: '/foo/[id]' },
  { label: 'literal bracket (ja locale)',   path: '/ja/foo/[id]' },
  { label: 'literal bracket percent-enc',   path: '/foo/%5Bid%5D' },
]

const fetchOne = async ({ label, path }) => {
  const url = `${base}${path}`
  try {
    const res = await fetch(url, { redirect: 'manual' })
    const body = await res.text()
    const snippet = body.slice(0, 160).replace(/\s+/g, ' ').trim()
    return { label, path, status: res.status, snippet }
  } catch (err) {
    return { label, path, status: 'ERR', snippet: String(err) }
  }
}

const results = await Promise.all(targets.map(fetchOne))

console.log(`\nBase: ${base}\n`)
for (const r of results) {
  const flag = typeof r.status === 'number' && r.status >= 500 ? '🔥' : '  '
  console.log(`${flag} [${r.status}] ${r.path.padEnd(28)} ${r.label}`)
  if (r.snippet) console.log(`       ${r.snippet}`)
}
