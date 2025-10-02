import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSupportedWikiUrl } from '../utils/urlUtils.js';

function loadManifest() {
  const manifestPath = new URL('../manifest.json', import.meta.url);
  const manifestContents = readFileSync(manifestPath, 'utf-8');
  return JSON.parse(manifestContents);
}

function runTests() {
  const manifest = loadManifest();
  const hostPermissions = manifest.host_permissions ?? [];
  const contentMatches = manifest.content_scripts?.[0]?.matches ?? [];

  assert.equal(
    hostPermissions.some((permission) => permission === 'https://app.devin.ai/wiki' || permission === 'https://app.devin.ai/wiki*'),
    true,
    'Manifest host permissions must include Devin wiki root'
  );

  assert.equal(
    contentMatches.some((match) => match === 'https://app.devin.ai/wiki' || match === 'https://app.devin.ai/wiki*'),
    true,
    'Manifest content script matches must include Devin wiki root'
  );

  assert.equal(isSupportedWikiUrl('https://deepwiki.com/Some/Page'), true, 'DeepWiki path should be supported');
  assert.equal(isSupportedWikiUrl('https://www.deepwiki.com/Another/Page'), true, 'www.DeepWiki path should be supported');
  assert.equal(isSupportedWikiUrl('https://deepwiki.com'), true, 'DeepWiki root should be supported');
  assert.equal(isSupportedWikiUrl('https://app.devin.ai/wiki/my-report'), true, 'Devin wiki nested path should be supported');
  assert.equal(isSupportedWikiUrl('https://app.devin.ai/wiki'), true, 'Devin wiki root path should be supported');

  assert.equal(isSupportedWikiUrl('https://app.devin.ai/other'), false, 'Devin host outside /wiki should be rejected');
  assert.equal(isSupportedWikiUrl('https://example.com/'), false, 'Unknown host should be rejected');
  assert.equal(isSupportedWikiUrl('not a url'), false, 'Invalid URLs should be rejected');
  assert.equal(isSupportedWikiUrl(null), false, 'Null should be rejected');

  console.log('All tests passed');
}

runTests();
