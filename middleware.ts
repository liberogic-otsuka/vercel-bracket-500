import { NextResponse, type NextRequest } from 'next/server'

const containsBracketLiteral = (pathname: string, rawUrl: string) =>
  pathname.includes('[') || pathname.includes(']') || /%5[bd]/i.test(rawUrl)

export function middleware(request: NextRequest) {
  if (containsBracketLiteral(request.nextUrl.pathname, request.url)) {
    return new NextResponse('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  return NextResponse.next()
}

export const config = {
  // Only fire on `/foo/<segment>` requests whose segment contains a literal
  // `[` or percent-encoded `%5B` — i.e. exactly the URL shapes that trigger
  // the Next 14.2 Pages-Router-i18n ENOENT bug. The leading locale segment
  // (`/ja/foo/...`) is automatically prepended to the compiled regex when
  // `i18n` is enabled in next.config.js, so we don't need a separate pattern.
  matcher: ['/foo/:id(\\[.*|.*%5[Bb].*)'],
}
