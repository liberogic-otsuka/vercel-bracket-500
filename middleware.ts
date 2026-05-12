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
  // With `i18n` enabled, Next.js auto-prepends a locale segment to the matcher,
  // so `/foo/:path+` catches both `/foo/...` and `/{en,ja}/foo/...` shapes.
  matcher: ['/foo/:path+'],
}
