import { isSupportedWikiUrl } from './utils/urlUtils.js';

const FALLBACK_FILENAME = 'deepwiki-page';

function sanitizeFilename(input, options = {}) {
  const { allowEmpty = false } = options;

  if (!input || typeof input !== 'string') {
    return allowEmpty ? '' : FALLBACK_FILENAME;
  }

  let sanitized = input
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '-');

  sanitized = sanitized
    .replace(/[\u0000-\u001F<>:"/\\|?*\u007F]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.');

  sanitized = sanitized.replace(/^[.-]+/, '').replace(/[.-]+$/, '');

  if (!sanitized) {
    return allowEmpty ? '' : FALLBACK_FILENAME;
  }

  return sanitized;
}

const PAGE_READY_TIMEOUT_MS = 20000;
const PAGE_READY_POLL_INTERVAL_MS = 300;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUrlForComparison(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  try {
    const url = new URL(rawUrl);
    let normalizedPath = url.pathname;
    if (normalizedPath.length > 1) {
      normalizedPath = normalizedPath.replace(/\/+/g, '/');
      normalizedPath = normalizedPath.replace(/\/+$/, '');
    }

    return `${url.origin}${normalizedPath}${url.search}${url.hash}`;
  } catch (error) {
    return rawUrl;
  }
}

function urlsReferToSameDocument(firstUrl, secondUrl) {
  return normalizeUrlForComparison(firstUrl) === normalizeUrlForComparison(secondUrl);
}

async function waitForPageInteractive(tabId, targetUrl) {
  const normalizedTarget = normalizeUrlForComparison(targetUrl);
  const startTime = Date.now();

  while (Date.now() - startTime < PAGE_READY_TIMEOUT_MS) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      if (error && error.message && error.message.includes('No tab with id')) {
        throw error;
      }
      await delay(PAGE_READY_POLL_INTERVAL_MS);
      continue;
    }

    const currentUrl = tab.url || tab.pendingUrl || '';
    const normalizedCurrent = normalizeUrlForComparison(currentUrl);

    if (normalizedCurrent === normalizedTarget) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        if (response && response.ready) {
          return tab;
        }
      } catch (error) {
        // Ignore errors while waiting for the content script to initialize
      }
    }

    await delay(PAGE_READY_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for page readiness: ${targetUrl}`);
}

async function ensureTabAtUrl(tabId, targetUrl, previousUrl) {
  if (!urlsReferToSameDocument(previousUrl, targetUrl)) {
    await chrome.tabs.update(tabId, { url: targetUrl });
  }

  return waitForPageInteractive(tabId, targetUrl);
}

async function safelyReturnToUrl(tabId, targetUrl) {
  if (!targetUrl) {
    return null;
  }

  try {
    const currentTab = await chrome.tabs.get(tabId);
    const currentUrl = currentTab.url || currentTab.pendingUrl || '';
    return await ensureTabAtUrl(tabId, targetUrl, currentUrl);
  } catch (error) {
    console.error('Failed to return to original page', error);
    return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const convertBtn = document.getElementById('convertBtn');
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const status = document.getElementById('status');
  let currentMarkdown = '';
  let currentTitle = '';
  let currentHeadTitle = '';
  let allPages = [];
  let convertedPages = []; // Store all converted page content
  let isCancelled = false; // Flag to control cancellation

  // Convert button click event - now also downloads
  convertBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!isSupportedWikiUrl(tab?.url)) {
        showStatus('Please use this extension on a DeepWiki page', 'error');
        return;
      }

      showStatus('Converting page...', 'info');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'convertToMarkdown' });
      
      if (response && response.success) {
        currentMarkdown = response.markdown;

        const sanitizedHeadTitle = sanitizeFilename(response.headTitle, { allowEmpty: true });
        const sanitizedContentTitle = sanitizeFilename(
          response.markdownTitle || response.currentTitle || ''
        );

        currentTitle = sanitizedContentTitle;
        currentHeadTitle = sanitizedHeadTitle;

        const fileNameBase = sanitizedHeadTitle
          ? `${sanitizedHeadTitle}-${sanitizedContentTitle}`
          : sanitizedContentTitle;
        const fileName = `${sanitizeFilename(fileNameBase)}.md`;
        
        // Automatically download after successful conversion
        const blob = new Blob([currentMarkdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        
        chrome.downloads.download({
          url: url,
          filename: fileName,
          saveAs: true
        });
        
        showStatus('Conversion successful! Downloading...', 'success');
      } else {
        showStatus('Conversion failed: ' + (response?.error || 'Unknown error'), 'error');
      }
    } catch (error) {
      showStatus('An error occurred: ' + error.message, 'error');
    }
  });

  // Batch download button click event
  batchDownloadBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!isSupportedWikiUrl(tab?.url)) {
        showStatus('Please use this extension on a DeepWiki page', 'error');
        return;
      }

      // Reset cancellation flag and show cancel button
      isCancelled = false;
      showCancelButton(true);
      disableBatchButton(true);

      showStatus('Extracting all page links...', 'info');
      
      // Extract all links first
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractAllPages' });
      
      if (response && response.success) {
        allPages = response.pages;
        
        // Use head title for folder name if available
        const headTitle = sanitizeFilename(response.headTitle, { allowEmpty: true });
        const fallbackFolderName = sanitizeFilename(response.currentTitle || '');
        const folderName = headTitle || fallbackFolderName;
        
        // Clear previous conversion results
        convertedPages = [];
        
        showStatus(`Found ${allPages.length} pages, starting batch conversion`, 'info');
        
        // Process all pages - collect conversion results
        await processAllPages(tab.id, folderName);
        
        // Download all collected content at once if not cancelled
        if (!isCancelled && convertedPages.length > 0) {
          await downloadAllPagesAsZip(folderName);
        }
      } else {
        showStatus('Failed to extract page links: ' + (response?.error || 'Unknown error'), 'error');
      }
    } catch (error) {
      showStatus('An error occurred: ' + error.message, 'error');
    } finally {
      // Hide cancel button and re-enable batch button
      showCancelButton(false);
      disableBatchButton(false);
    }
  });

  // Cancel button click event
  cancelBtn.addEventListener('click', () => {
    isCancelled = true;
    showStatus('Cancelling batch operation...', 'info');
    showCancelButton(false);
    disableBatchButton(false);
  });

  // Process all pages - collect conversion results but don't download immediately
  async function processAllPages(tabId, folderName) {
    let processedCount = 0;
    let errorCount = 0;
    const usedFileTitles = new Set();

    const ensureUniqueFileTitle = (baseTitle, index) => {
      let candidate = sanitizeFilename(baseTitle || `page-${index}`);
      if (!candidate) {
        candidate = `page-${index}`;
      }

      if (!usedFileTitles.has(candidate)) {
        usedFileTitles.add(candidate);
        return candidate;
      }

      let suffix = 2;
      let uniqueCandidate = `${candidate}-${suffix}`;
      while (usedFileTitles.has(uniqueCandidate)) {
        suffix += 1;
        uniqueCandidate = `${candidate}-${suffix}`;
      }

      usedFileTitles.add(uniqueCandidate);
      return uniqueCandidate;
    };

    // Save current page URL
    const currentPageUrl = allPages.find(page => page.selected)?.url || "";
    let lastVisitedUrl = currentPageUrl;

    try {
      const activeTab = await chrome.tabs.get(tabId);
      lastVisitedUrl = activeTab.url || activeTab.pendingUrl || currentPageUrl;
    } catch (error) {
      lastVisitedUrl = currentPageUrl;
    }

    for (const page of allPages) {
      // Check if operation was cancelled
      if (isCancelled) {
        showStatus(`Operation cancelled. Processed: ${processedCount}, Failed: ${errorCount}`, 'info');
        // Return to original page
        await safelyReturnToUrl(tabId, currentPageUrl);
        return;
      }

      try {
        showStatus(`Processing ${processedCount + 1}/${allPages.length}: ${page.title}`, 'info');

        // Ensure the tab has navigated and the content script is ready
        const readyTab = await ensureTabAtUrl(tabId, page.url, lastVisitedUrl);
        lastVisitedUrl = readyTab?.url || readyTab?.pendingUrl || page.url;

        // Check again if cancelled after navigation
        if (isCancelled) {
          showStatus(`Operation cancelled. Processed: ${processedCount}, Failed: ${errorCount}`, 'info');
          await safelyReturnToUrl(tabId, currentPageUrl);
          return;
        }

        // Convert page content
        const convertResponse = await chrome.tabs.sendMessage(tabId, { action: 'convertToMarkdown' });
        
        if (convertResponse && convertResponse.success) {
          const displayTitle = page.title || convertResponse.markdownTitle || `Page ${processedCount + 1}`;
          const preferredFileTitle =
            page.title && page.title.trim()
              ? page.title
              : convertResponse.markdownTitle || convertResponse.currentTitle || displayTitle;

          const fileTitle = ensureUniqueFileTitle(preferredFileTitle, processedCount + 1);

          // Store converted content
          convertedPages.push({
            displayTitle,
            fileTitle,
            content: convertResponse.markdown,
            sourceUrl: page.url
          });

          processedCount++;
        } else {
          errorCount++;
          console.error(`Page processing failed: ${page.title}`, convertResponse?.error);
        }
      } catch (err) {
        errorCount++;
        console.error(`Error processing page: ${page.title}`, err);
        showStatus(`Failed to process ${page.title}. Continuing...`, 'error');

        try {
          const fallbackTab = await chrome.tabs.get(tabId);
          lastVisitedUrl = fallbackTab.url || fallbackTab.pendingUrl || lastVisitedUrl;
        } catch (fallbackError) {
          // Ignore - we'll rely on the last known URL
        }
      }
    }

    // Return to original page after processing
    await safelyReturnToUrl(tabId, currentPageUrl);

    if (!isCancelled) {
      showStatus(`Batch conversion complete! Success: ${processedCount}, Failed: ${errorCount}, Preparing download...`, 'success');
    }
  }
  
  // Package all pages into a ZIP file for download
  async function downloadAllPagesAsZip(folderName) {
    try {
      showStatus('Creating ZIP file...', 'info');
      
      // Create new JSZip instance
      const zip = new JSZip();
      
      // Create index file
      let indexContent = `# ${folderName}\n\n## Content Index\n\n`;
      convertedPages.forEach(page => {
        indexContent += `- [${page.displayTitle}](${page.fileTitle}.md)\n`;
      });
      
      // Add index file to zip
      zip.file('README.md', indexContent);
      
      // Add all Markdown files to zip
      convertedPages.forEach(page => {
        zip.file(`${page.fileTitle}.md`, page.content);
      });
      
      // Generate zip file
      showStatus('Compressing files...', 'info');
      const zipContent = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
      });
      
      // Download zip file
      const zipUrl = URL.createObjectURL(zipContent);
      chrome.downloads.download({
        url: zipUrl,
        filename: `${sanitizeFilename(folderName)}.zip`,
        saveAs: true
      }, () => {
        if (chrome.runtime.lastError) {
          showStatus('Error downloading ZIP file: ' + chrome.runtime.lastError.message, 'error');
        } else {
          showStatus(`ZIP file successfully generated! Contains ${convertedPages.length} Markdown files`, 'success');
        }
      });
      
    } catch (error) {
      showStatus('Error creating ZIP file: ' + error.message, 'error');
    }
  }

  // Show or hide cancel button
  function showCancelButton(show) {
    cancelBtn.style.display = show ? 'block' : 'none';
  }

  // Enable or disable batch button
  function disableBatchButton(disable) {
    batchDownloadBtn.disabled = disable;
  }

  // Display status information
  function showStatus(message, type) {
    status.textContent = message;
    status.className = type;
  }
}); 