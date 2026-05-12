import type { NextPage } from 'next'
import Link from 'next/link'

const Page: NextPage = () => {
  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>vercel-bracket-500 repro</h1>
      <p>
        Reproduction for <code>FUNCTION_INVOCATION_FAILED</code> when a literal{' '}
        <code>[id]</code> appears in the URL.
      </p>
      <ul>
        <li>
          <Link href="/foo">/foo (sibling index page)</Link>
        </li>
        <li>
          <Link href="/foo/abc">/foo/abc (normal dynamic page)</Link>
        </li>
        <li>
          {/* Intentionally a raw string — not encoded — so the URL contains literal brackets. */}
          <a href="/foo/[id]">/foo/[id] (literal bracket — should trigger 500 on Vercel)</a>
        </li>
        <li>
          <a href="/ja/foo/[id]">/ja/foo/[id] (i18n locale variant)</a>
        </li>
      </ul>
    </main>
  )
}

export default Page
