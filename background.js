import JSZip from './utils/jszipLoader.js';
import {
  sanitizeFilename,
  ensureMarkdownExtension,
  ensureUniqueName,
  ensureUniqueFileTitle
} from './utils/fileNameUtils.js';
import {
  sendMessageToTab as sendAsyncMessageToTab,
  ensureTabAtUrl,
  safelyReturnToUrl
} from './utils/tabNavigation.js';
import { isSupportedWikiUrl } from './utils/urlUtils.js';

// A queue to hold messages for tabs that are not yet ready
const messageQueue = {};
const batchJobs = new Map();

// Function to safely send a message to a tab, queuing if necessary
function queueMessageToTab(tabId, message) {
  // Check if the content script is ready. We'll use a simple check for now.
  // A more robust way is for the content script to notify when it's ready.
  if (messageQueue[tabId] && messageQueue[tabId].isReady) {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        console.log(`Error sending message to tab ${tabId}:`, chrome.runtime.lastError.message);
      }
    });
  } else {
    // If the tab is not ready, queue the message
    if (!messageQueue[tabId]) {
      messageQueue[tabId] = { isReady: false, queue: [] };
    }
    messageQueue[tabId].queue.push(message);
    console.log(`Message queued for tab ${tabId}:`, message.action);
  }
}

function createBatchJob(tabId) {
  return {
    tabId,
    cancelRequested: false,
    cancelled: false,
    completed: false,
    processedCount: 0,
    errorCount: 0,
    total: 0,
    folderName: '',
    allPages: [],
    convertedPages: [],
    lastMessage: '',
    lastStatusType: 'info',
    currentPageUrl: ''
  };
}

function serializeJob(job) {
  if (!job) {
    return null;
  }

  return {
    tabId: job.tabId,
    running: !job.completed,
    completed: job.completed,
    cancelRequested: job.cancelRequested,
    cancelled: job.cancelled,
    processedCount: job.processedCount,
    total: job.total,
    errorCount: job.errorCount,
    statusType: job.lastStatusType,
    message: job.lastMessage
  };
}

function sendBatchUpdate(job, update = {}) {
  const payload = {
    action: 'batchUpdate',
    tabId: job.tabId,
    processedCount: job.processedCount,
    total: job.total,
    errorCount: job.errorCount,
    cancelRequested: job.cancelRequested,
    cancelled: job.cancelled,
    completed: update.completed ?? job.completed,
    running: update.running ?? !job.completed,
    statusType: update.statusType ?? job.lastStatusType,
    message: update.message ?? job.lastMessage
  };

  try {
    const result = chrome.runtime.sendMessage(payload);
    if (result && typeof result.then === 'function') {
      result.catch(() => {});
    }
  } catch (error) {
    if (!error?.message?.includes('Receiving end does not exist')) {
      console.warn('Failed to deliver batch update:', error);
    }
  }
}

function updateJobStatus(job, message, statusType = 'info', update = {}) {
  job.lastMessage = message;
  job.lastStatusType = statusType;
  sendBatchUpdate(job, { message, statusType, ...update });
}

async function runBatchConversion(job) {
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (!isSupportedWikiUrl(tab?.url)) {
      throw new Error('Please use this extension on a DeepWiki page');
    }

    job.currentPageUrl = tab.url || tab.pendingUrl || '';

    updateJobStatus(job, 'Extracting all page links...', 'info', { running: true });

    const response = await sendAsyncMessageToTab(job.tabId, { action: 'extractAllPages' });

    if (!response?.success) {
      throw new Error(response?.error || 'Failed to extract page links');
    }

    job.allPages = Array.isArray(response.pages) ? response.pages : [];
    job.total = job.allPages.length;
    const headTitle = sanitizeFilename(response.headTitle, { allowEmpty: true });
    const fallbackFolderName = sanitizeFilename(response.currentTitle || '', { allowEmpty: true });
    job.folderName = headTitle || fallbackFolderName || 'deepwiki-export';

    updateJobStatus(job, `Found ${job.total} pages, starting batch conversion`, 'info', { running: true });

    await processJobPages(job);

    if (job.cancelRequested) {
      job.cancelled = true;
      job.completed = true;
      updateJobStatus(
        job,
        `Operation cancelled. Processed: ${job.processedCount}, Failed: ${job.errorCount}`,
        'info',
        { completed: true, running: false }
      );
      return;
    }

    if (job.convertedPages.length === 0) {
      job.completed = true;
      updateJobStatus(job, 'No pages were converted.', 'error', { completed: true, running: false });
      return;
    }

    await downloadJobZip(job);

    job.completed = true;
    updateJobStatus(
      job,
      `ZIP file successfully generated! Contains ${job.convertedPages.length} Markdown files`,
      'success',
      { completed: true, running: false }
    );
  } catch (error) {
    job.completed = true;
    updateJobStatus(job, `Batch conversion failed: ${error.message}`, 'error', { completed: true, running: false });
    console.error('Batch conversion error:', error);
  } finally {
    batchJobs.delete(job.tabId);
  }
}

async function processJobPages(job) {
  const usedFileTitles = new Set();
  const currentPageUrl = job.allPages.find(page => page?.selected)?.url || job.currentPageUrl || '';
  job.currentPageUrl = currentPageUrl;

  let lastVisitedUrl = currentPageUrl;
  try {
    const activeTab = await chrome.tabs.get(job.tabId);
    lastVisitedUrl = activeTab.url || activeTab.pendingUrl || currentPageUrl;
  } catch (error) {
    lastVisitedUrl = currentPageUrl;
  }

  for (const page of job.allPages) {
    if (job.cancelRequested) {
      break;
    }

    const pageTitle = page?.title || page?.url || `Page ${job.processedCount + 1}`;
    updateJobStatus(
      job,
      `Processing ${job.processedCount + 1}/${job.total}: ${pageTitle}`,
      'info',
      { running: true }
    );

    if (!page?.url) {
      job.errorCount += 1;
      updateJobStatus(job, `Skipping entry with missing URL: ${pageTitle}`, 'error', { running: true });
      continue;
    }

    try {
      const readyTab = await ensureTabAtUrl(job.tabId, page.url, lastVisitedUrl);
      lastVisitedUrl = readyTab?.url || readyTab?.pendingUrl || page.url;

      if (job.cancelRequested) {
        break;
      }

      const convertResponse = await sendAsyncMessageToTab(job.tabId, { action: 'convertToMarkdown' });

      if (convertResponse && convertResponse.success) {
        const displayTitle = page.title || convertResponse.markdownTitle || `Page ${job.processedCount + 1}`;
        const preferredFileTitle = page.title && page.title.trim()
          ? page.title
          : convertResponse.markdownTitle || convertResponse.currentTitle || displayTitle;

        const fileTitle = ensureUniqueFileTitle(preferredFileTitle, job.processedCount + 1, usedFileTitles);

        job.convertedPages.push({
          displayTitle,
          fileTitle,
          content: convertResponse.markdown,
          sourceUrl: page.url,
          attachments: Array.isArray(convertResponse.attachments) ? convertResponse.attachments : []
        });

        job.processedCount += 1;
      } else {
        job.errorCount += 1;
        updateJobStatus(job, `Failed to process ${pageTitle}. Continuing...`, 'error', { running: true });
      }
    } catch (error) {
      job.errorCount += 1;
      console.error(`Error processing page: ${pageTitle}`, error);
      updateJobStatus(job, `Failed to process ${pageTitle}. Continuing...`, 'error', { running: true });

      try {
        const fallbackTab = await chrome.tabs.get(job.tabId);
        lastVisitedUrl = fallbackTab.url || fallbackTab.pendingUrl || lastVisitedUrl;
      } catch (fallbackError) {
        // Ignore and keep last known URL
      }
    }
  }

  await safelyReturnToUrl(job.tabId, currentPageUrl);

  if (!job.cancelRequested) {
    updateJobStatus(
      job,
      `Batch conversion complete! Success: ${job.processedCount}, Failed: ${job.errorCount}, Preparing download...`,
      'success',
      { running: true }
    );
  }
}

async function downloadJobZip(job) {
  if (job.cancelRequested) {
    return;
  }

  updateJobStatus(job, 'Creating ZIP file...', 'info', { running: true });

  const zip = new JSZip();
  let indexContent = `# ${job.folderName}\n\n## Content Index\n\n`;
  job.convertedPages.forEach(page => {
    indexContent += `- [${page.displayTitle}](${page.fileTitle}.md)\n`;
    if (Array.isArray(page.attachments) && page.attachments.length > 0) {
      indexContent += `  - Attachments (${page.attachments.length}) stored in attachments/${page.fileTitle}/\n`;
    }
  });
  zip.file('README.md', indexContent);

  let attachmentsRoot = null;
  job.convertedPages.forEach(page => {
    zip.file(`${page.fileTitle}.md`, page.content);

    if (!Array.isArray(page.attachments) || page.attachments.length === 0) {
      return;
    }

    const usedNames = new Set();
    if (!attachmentsRoot) {
      attachmentsRoot = zip.folder('attachments');
    }
    const pageAttachmentFolder = attachmentsRoot.folder(page.fileTitle);
    page.attachments.forEach((attachment, index) => {
      if (!attachment || typeof attachment.content !== 'string') {
        return;
      }

      const rawName = sanitizeFilename(
        attachment.fileName || attachment.displayName || `attachment-${index + 1}`
      );
      const candidateName = ensureMarkdownExtension(rawName || `attachment-${index + 1}`);
      const uniqueName = ensureUniqueName(candidateName, usedNames);

      pageAttachmentFolder.file(uniqueName, attachment.content);
    });
  });

  updateJobStatus(job, 'Compressing files...', 'info', { running: true });
  const zipContent = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  if (job.cancelRequested) {
    return;
  }

  const zipUrl = URL.createObjectURL(zipContent);

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: zipUrl,
        filename: `${sanitizeFilename(job.folderName || 'deepwiki-export')}.zip`,
        saveAs: true
      },
      downloadId => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(downloadId);
      }
    );
  }).finally(() => {
    URL.revokeObjectURL(zipUrl);
  });
}

// Listen for extension installation event
chrome.runtime.onInstalled.addListener(() => {
  console.log('DeepWiki to Markdown extension installed');
});

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'log') {
    console.log('Message from page:', request.message);
  } else if (request.action === 'contentScriptReady') {
    // Content script is ready, process any queued messages for this tab
    const tabId = sender.tab.id;
    if (messageQueue[tabId]) {
      messageQueue[tabId].isReady = true;
      while (messageQueue[tabId].queue.length > 0) {
        const message = messageQueue[tabId].queue.shift();
        chrome.tabs.sendMessage(tabId, message, response => {
          if (chrome.runtime.lastError) {
            console.log(`Error sending queued message to tab ${tabId}:`, chrome.runtime.lastError.message);
          }
        });
      }
    } else {
      // If no queue exists, create one and mark as ready
      messageQueue[tabId] = { isReady: true, queue: [] };
    }
    console.log(`Content script ready on tab ${tabId}. Queue processed.`);
    sendResponse({ status: 'ready' });
  } else if (request.action === 'startBatchConversion') {
    const { tabId } = request;
    if (!tabId) {
      sendResponse({ success: false, error: 'Missing tab id' });
      return true;
    }

    if (batchJobs.has(tabId)) {
      sendResponse({ success: false, error: 'Batch conversion already running' });
      return true;
    }

    const job = createBatchJob(tabId);
    batchJobs.set(tabId, job);
    runBatchConversion(job).catch(error => {
      console.error('Batch conversion failed', error);
    });
    sendResponse({ success: true });
  } else if (request.action === 'cancelBatchConversion') {
    const { tabId } = request;
    const job = tabId ? batchJobs.get(tabId) : null;

    if (!job) {
      sendResponse({ success: false, error: 'No batch conversion in progress' });
      return true;
    }

    job.cancelRequested = true;
    updateJobStatus(job, 'Cancelling batch operation...', 'info', { running: true });
    sendResponse({ success: true });
  } else if (request.action === 'getBatchStatus') {
    const { tabId } = request;
    const job = tabId ? batchJobs.get(tabId) : null;
    sendResponse({ success: true, job: job ? serializeJob(job) : null });
  }
  return true;
});

// Listen for tab update complete event, for batch processing
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isSupportedWikiUrl(tab?.url)) {
    // Initialize the message queue for this tab as not ready
    if (!messageQueue[tabId] || !messageQueue[tabId].isReady) {
        messageQueue[tabId] = { isReady: false, queue: [] };
    }
    // Notify content script that page has loaded, it should respond when ready
    chrome.tabs.sendMessage(tabId, { action: 'pageLoaded' }, response => {
      if (chrome.runtime.lastError) {
        console.log('Error pinging tab, will wait for ready signal:', chrome.runtime.lastError.message);
      }
    });
  }
});

// Also listen for tab activation to reinitialize connection if needed
chrome.tabs.onActivated.addListener(activeInfo => {
  // When a tab becomes active, check if it's a supported wiki tab
  chrome.tabs.get(activeInfo.tabId, tab => {
    if (tab && isSupportedWikiUrl(tab.url)) {
      // Ensure queue is initialized
      if (!messageQueue[tab.id]) {
        messageQueue[tab.id] = { isReady: false, queue: [] };
      }
      // Send a reconnect message that the content script can use to initialize
      chrome.tabs.sendMessage(activeInfo.tabId, { action: 'tabActivated' }, response => {
        if (chrome.runtime.lastError) {
          console.log('Tab activated but no listener:', chrome.runtime.lastError.message);
        }
      });
    }
  });
});

// Clean up the queue when a tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  if (messageQueue[tabId]) {
    delete messageQueue[tabId];
    console.log(`Cleaned up message queue for closed tab ${tabId}.`);
  }

  if (batchJobs.has(tabId)) {
    const job = batchJobs.get(tabId);
    job.cancelled = true;
    job.completed = true;
    updateJobStatus(job, 'Tab closed. Batch conversion stopped.', 'error', { completed: true, running: false });
    batchJobs.delete(tabId);
  }
});