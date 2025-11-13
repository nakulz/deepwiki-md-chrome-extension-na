import JSZip from './utils/jszipLoader.js';
import {
  sanitizeFilename,
  ensureMarkdownExtension,
  ensureUniqueName
} from './utils/fileNameUtils.js';
import { sendMessageToTab } from './utils/tabNavigation.js';
import { isSupportedWikiUrl } from './utils/urlUtils.js';

document.addEventListener('DOMContentLoaded', () => {
  const convertBtn = document.getElementById('convertBtn');
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const status = document.getElementById('status');
  let currentMarkdown = '';
  let currentAttachments = [];
  let currentTabId = null;
  let activeBatchTabId = null;

  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'batchUpdate') {
      handleBatchUpdate(message);
    }
  });

  initializeTabState();

  // Convert button click event - now also downloads
  convertBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!isSupportedWikiUrl(tab?.url)) {
        showStatus('Please use this extension on a DeepWiki page', 'error');
        return;
      }

      currentAttachments = [];
      showStatus('Converting page...', 'info');
      const response = await sendMessageToTab(tab.id, { action: 'convertToMarkdown' });

      if (response && response.success) {
        currentMarkdown = response.markdown;

        const sanitizedHeadTitle = sanitizeFilename(response.headTitle, { allowEmpty: true });
        const sanitizedContentTitle = sanitizeFilename(
          response.markdownTitle || response.currentTitle || ''
        );

        currentAttachments = Array.isArray(response.attachments) ? response.attachments : [];

        const fileNameBase = sanitizedHeadTitle
          ? `${sanitizedHeadTitle}-${sanitizedContentTitle}`
          : sanitizedContentTitle;
        const sanitizedFileNameBase = sanitizeFilename(fileNameBase);
        const fileName = ensureMarkdownExtension(sanitizedFileNameBase);

        if (currentAttachments.length > 0) {
          showStatus('Conversion successful! Preparing attachment bundle...', 'info');

          const usedNames = new Set();
          const zip = new JSZip();
          zip.file(fileName, currentMarkdown);
          usedNames.add(fileName.toLowerCase());

          const attachmentsFolder = zip.folder('attachments');

          currentAttachments.forEach((attachment, index) => {
            if (!attachment || typeof attachment.content !== 'string') {
              return;
            }

            const rawName = sanitizeFilename(
              attachment.fileName || attachment.displayName || `attachment-${index + 1}`
            );
            const candidateName = ensureMarkdownExtension(rawName || `attachment-${index + 1}`);
            const uniqueName = ensureUniqueName(candidateName, usedNames);

            attachmentsFolder.file(uniqueName, attachment.content);
          });

          const zipNameBase = fileName.replace(/\.md$/i, '');
          const zipBlob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 }
          });

          const zipUrl = URL.createObjectURL(zipBlob);
          chrome.downloads.download({
            url: zipUrl,
            filename: `${zipNameBase}-bundle.zip`,
            saveAs: true
          });

          showStatus('Conversion successful! Downloading bundle...', 'success');
        } else {
          // Automatically download after successful conversion
          const blob = new Blob([currentMarkdown], { type: 'text/markdown' });
          const url = URL.createObjectURL(blob);

          chrome.downloads.download({
            url: url,
            filename: fileName,
            saveAs: true
          });

          showStatus('Conversion successful! Downloading...', 'success');
        }
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
      await startBatchConversion(tab);
    } catch (error) {
      showStatus('An error occurred: ' + error.message, 'error');
    }
  });

  // Cancel button click event
  cancelBtn.addEventListener('click', async () => {
    if (!activeBatchTabId) {
      showCancelButton(false);
      disableBatchButton(false);
      return;
    }

    showStatus('Cancelling batch operation...', 'info');
    try {
      await chrome.runtime.sendMessage({ action: 'cancelBatchConversion', tabId: activeBatchTabId });
    } catch (error) {
      showStatus('Failed to cancel batch operation: ' + error.message, 'error');
    }
  });

  async function initializeTabState() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTabId = tab?.id ?? null;

      if (!currentTabId) {
        resetBatchUiState();
        return;
      }

      const response = await chrome.runtime.sendMessage({ action: 'getBatchStatus', tabId: currentTabId });
      if (response?.job) {
        handleBatchUpdate({ tabId: currentTabId, ...response.job });
      } else {
        resetBatchUiState();
      }
    } catch (error) {
      console.error('Failed to initialize tab state', error);
      resetBatchUiState();
    }
  }

  async function startBatchConversion(tab) {
    if (!tab?.id) {
      showStatus('Unable to determine active tab', 'error');
      return;
    }

    if (!isSupportedWikiUrl(tab?.url)) {
      showStatus('Please use this extension on a DeepWiki page', 'error');
      return;
    }

    showCancelButton(true);
    disableBatchButton(true);
    showStatus('Preparing batch conversion...', 'info');

    try {
      const response = await chrome.runtime.sendMessage({ action: 'startBatchConversion', tabId: tab.id });
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to start batch conversion');
      }
      activeBatchTabId = tab.id;
    } catch (error) {
      showStatus('Failed to start batch conversion: ' + error.message, 'error');
      showCancelButton(false);
      disableBatchButton(false);
    }
  }

  function handleBatchUpdate(update) {
    if (!currentTabId || update.tabId !== currentTabId) {
      return;
    }

    if (typeof update.message === 'string') {
      showStatus(update.message, update.statusType || 'info');
    }

    const isRunning = Boolean(update.running);
    showCancelButton(isRunning);
    disableBatchButton(isRunning);

    if (update.completed || update.cancelled || !isRunning) {
      activeBatchTabId = null;
    } else {
      activeBatchTabId = update.tabId;
    }
  }

  function resetBatchUiState() {
    showCancelButton(false);
    disableBatchButton(false);
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