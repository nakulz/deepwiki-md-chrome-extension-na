import assert from 'node:assert/strict';
import { isSupportedWikiUrl } from '../utils/urlUtils.js';

function runTests() {
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
