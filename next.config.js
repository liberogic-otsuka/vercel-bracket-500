/** @type {import('next').NextConfig} */
module.exports = {
  pageExtensions: ['page.tsx', 'api.ts', 'ts'],
  i18n: {
    defaultLocale: 'ja',
    locales: ['en', 'ja'],
  },
  reactStrictMode: true,
}
