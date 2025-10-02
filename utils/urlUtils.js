const SUPPORTED_WIKI_HOSTS = new Map([
  ['deepwiki.com', null],
  ['www.deepwiki.com', null],
  ['app.devin.ai', '/wiki']
]);

/**
 * Determines whether the provided URL belongs to a supported wiki instance.
 *
 * @param {string|undefined|null} url - The URL to validate.
 * @returns {boolean} True when the URL is a supported wiki page.
 */
export function isSupportedWikiUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return false;
  }

  const requiredPathPrefix = SUPPORTED_WIKI_HOSTS.get(parsedUrl.hostname);
  if (requiredPathPrefix === undefined) {
    return false;
  }

  if (requiredPathPrefix === null) {
    return true;
  }

  return (
    parsedUrl.pathname === requiredPathPrefix ||
    parsedUrl.pathname.startsWith(`${requiredPathPrefix}/`)
  );
}

export { SUPPORTED_WIKI_HOSTS };
