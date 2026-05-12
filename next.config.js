/** @type {import('next').NextConfig} */
module.exports = {
  pageExtensions: ['page.tsx', 'api.ts', 'ts'],
  // i18n disabled for experiment/no-i18n branch — checking whether i18n is a
  // necessary trigger for the literal-bracket FUNCTION_INVOCATION_FAILED.
  reactStrictMode: true,
}
