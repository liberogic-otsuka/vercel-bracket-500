import { NextResponse, type NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Matcher narrows to bracket-shaped URLs as cheaply as possible (so normal
  // `/foo/abc` requests don't even spawn this Edge function). The body adds
  // the precision the matcher can't provide:
  //
  // Vercel compiles path-to-regexp matchers with case-insensitive matching,
  // so the matcher's `[id]` literal also matches `[Id]`, `[ID]`, etc.
  // But the bug only fires when the URL contains the exact case-sensitive
  // substring `[id]` (matching the route's dynamic param name). We have to
  // check both decoded and encoded forms:
  //
  //   /foo/[id]          → pathname includes `[id]`        → 404
  //   /foo/%5Bid%5D      → url matches %5[Bb]id%5[Dd]      → 404
  //   /foo/%5bid%5d      → url matches %5[Bb]id%5[Dd]      → 404
  //   /foo/x[id]y        → pathname includes `[id]`        → 404
  //   /foo/[Id], [ID]    → neither matches                 → fall through, 200
  //   /foo/%5BID%5D      → neither matches                 → fall through, 200
  //
  // pathname is checked because `NextRequest.nextUrl.pathname` may or may not
  // percent-decode brackets depending on runtime; the raw-url regex catches
  // the encoded form regardless.
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
