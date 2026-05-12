import { NextResponse } from 'next/server'

// The Next 14.2 Pages-Router-i18n bug only triggers when a URL segment contains
// the literal substring `[id]` (case-sensitive, matching the route's actual
// dynamic param name) or its percent-encoded form `%5Bid%5D` (hex case-
// insensitive). Other bracket shapes like `[example]`, `[Id]`, or partial
// brackets are routed normally and do not crash. The matcher below filters to
// exactly that set, so by the time we reach this handler the request is
// guaranteed buggy — just return 404.
export function middleware() {
  return new NextResponse('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export const config = {
  matcher: ['/foo/:id(.*\\[id\\].*|.*%5[Bb]id%5[Dd].*)'],
}
