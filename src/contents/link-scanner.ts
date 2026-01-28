/**
 * Content Script: Link Scanner
 *
 * Scans the current page for supported hoster links and magnet links.
 * Triggered on-demand via messages from the popup or automatically via MutationObserver.
 */

import type { PlasmoCSConfig } from "plasmo";
import { success, error, type Message, type DetectedLink, sendMessage } from "~lib/messaging";
import type { UnrestrictedLink } from "~lib/api/unrestrict";

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle",
};

/**
 * Cache for hosts regex patterns
 */
let cachedHostsRegex: RegExp[] | null = null;
let cachedHostsRegexTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * State for debouncing scans
 */
let scanTimeout: NodeJS.Timeout | null = null;
const SCAN_DEBOUNCE_MS = 1000;
let isScanning = false;
let observer: MutationObserver | null = null;
const processedLinks = new Set<string>();
const unrestrictedCache = new Map<string, UnrestrictedLink>();

/**
 * Fetch hosts regex from background script
 */
async function getHostsRegex(): Promise<RegExp[]> {
  const now = Date.now();
  if (cachedHostsRegex && now - cachedHostsRegexTimestamp < CACHE_TTL) {
    return cachedHostsRegex;
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_HOSTS_REGEX", payload: undefined },
      (response) => {
        if (chrome.runtime.lastError || !response?.success || !response?.data) {
          // Return empty array on error
          resolve([]);
          return;
        }

        try {
          // Convert string patterns to RegExp objects
          // API returns patterns wrapped in /pattern/ format, strip the delimiters
          cachedHostsRegex = response.data.map((pattern: string) => {
            // Strip leading and trailing / if present
            const stripped = pattern.startsWith("/") && pattern.endsWith("/")
              ? pattern.slice(1, -1)
              : pattern;
            return new RegExp(stripped, "i");
          });
          cachedHostsRegexTimestamp = now;
          resolve(cachedHostsRegex);
        } catch {
          // If regex compilation fails, return empty array
          resolve([]);
        }
      }
    );
  });
}

/**
 * Extract hostname from URL for display
 */
function extractHost(url: string): string {
  try {
    if (url.startsWith("magnet:")) {
      return "magnet";
    }
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Check if a URL matches any supported hoster pattern
 */
function matchesHosterPattern(url: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(url));
}

/**
 * Extract URLs from text content
 */
function extractUrlsFromText(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
  const matches = text.match(urlRegex);
  return matches || [];
}

/**
 * Scan text nodes for links
 */
function scanTextNodes(patterns: RegExp[]): DetectedLink[] {
  const detectedLinks: DetectedLink[] = [];
  const seenUrls = new Set<string>();
  
  // Create a TreeWalker to find text nodes
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Skip script and style tags
        if (
          node.parentElement?.tagName === "SCRIPT" ||
          node.parentElement?.tagName === "STYLE" ||
          node.parentElement?.tagName === "NOSCRIPT"
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue) continue;
    
    const urls = extractUrlsFromText(node.nodeValue);
    for (const url of urls) {
      if (seenUrls.has(url)) continue;
      
      // Clean up URL (remove trailing punctuation that might have been captured)
      const cleanUrl = url.replace(/[.,;)]+$/, "");
      
      if (matchesHosterPattern(cleanUrl, patterns)) {
        seenUrls.add(cleanUrl);
        detectedLinks.push({
          url: cleanUrl,
          host: extractHost(cleanUrl),
          type: "hoster",
          unrestrictedLink: unrestrictedCache.get(cleanUrl)
        });
      }
    }
  }

  return detectedLinks;
}

/**
 * Scan the page for all links
 */
async function scanPageForLinks(): Promise<DetectedLink[]> {
  const detectedLinks: DetectedLink[] = [];
  const seenUrls = new Set<string>();

  // Get hoster patterns
  const hostsRegex = await getHostsRegex();

  // Find all anchor elements
  const anchors = document.querySelectorAll("a[href]");

  for (const anchor of anchors) {
    const href = (anchor as HTMLAnchorElement).href;

    // Skip empty or javascript: URLs
    if (!href || href.startsWith("javascript:") || seenUrls.has(href)) {
      continue;
    }

    seenUrls.add(href);

    // Check for magnet links
    if (href.startsWith("magnet:")) {
      detectedLinks.push({
        url: href,
        host: "magnet",
        type: "magnet",
      });
      continue;
    }

    // Check for supported hoster links
    if (matchesHosterPattern(href, hostsRegex)) {
      detectedLinks.push({
        url: href,
        host: extractHost(href),
        type: "hoster",
        unrestrictedLink: unrestrictedCache.get(href)
      });
    }
  }

  // Scan text nodes for non-anchor links
  const textLinks = scanTextNodes(hostsRegex);
  for (const link of textLinks) {
    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      detectedLinks.push(link);
    }
  }

  return detectedLinks;
}

/**
 * Message listener for scan requests
 */
chrome.runtime.onMessage.addListener(
  (
    message: Message,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (message.type === "SCAN_PAGE_LINKS") {
      scanPageForLinks()
        .then((links) => {
          reportLinksToBackground(links);
          sendResponse(success(links));
        })
        .catch((err) => {
          sendResponse(
            error(err instanceof Error ? err.message : "Failed to scan page")
          );
        });

      // Return true to indicate async response
      return true;
    }

    return false;
  }
);

/**
 * Get user preferences
 */
async function getPreferences() {
  return new Promise<{ autoScanEnabled: boolean; autoUnrestrict: boolean }>((resolve) => {
    chrome.storage.sync.get("preferences", (result) => {
      const prefs = result.preferences || {};
      resolve({
        // Default to true if undefined
        autoScanEnabled: prefs.autoScanEnabled !== false,
        autoUnrestrict: prefs.autoUnrestrict !== false
      });
    });
  });
}

/**
 * Report detected links to background script
 */
function reportLinksToBackground(links: DetectedLink[]): void {
  chrome.runtime.sendMessage(
    { type: "REPORT_DETECTED_LINKS", payload: { links } },
    () => {
      // Ignore errors - background might not be ready
      if (chrome.runtime.lastError) {
        // Suppress error
      }
    }
  );
}

/**
 * Auto-unrestrict links
 */
async function autoUnrestrictLinks(links: DetectedLink[]) {
  const hosterLinks = links.filter(l => l.type === "hoster");
  let hasNewUnrestrictions = false;
  
  for (const link of hosterLinks) {
    // Skip if already processed in this session
    if (processedLinks.has(link.url)) continue;
    processedLinks.add(link.url);

    try {
      const result = await sendMessage({
        type: "UNRESTRICT_LINK",
        payload: { link: link.url }
      });
      
      if (result.success && result.data) {
        unrestrictedCache.set(link.url, result.data);
        link.unrestrictedLink = result.data;
        hasNewUnrestrictions = true;
      }
    } catch (err) {
      console.error("[Real-Debrid] Auto-unrestrict failed for:", link.url, err);
    }
  }

  // If we have new unrestrictions, report updated links to background
  if (hasNewUnrestrictions) {
    reportLinksToBackground(links);
  }
}

/**
 * Perform auto-scan and report results to background
 */
async function performAutoScan(): Promise<void> {
  if (isScanning) return;
  isScanning = true;

  try {
    const { autoScanEnabled, autoUnrestrict } = await getPreferences();
    
    if (!autoScanEnabled) {
      isScanning = false;
      return;
    }

    const links = await scanPageForLinks();
    
    // Only report/unrestrict if we found something
    if (links.length > 0) {
      reportLinksToBackground(links);
      
      if (autoUnrestrict) {
        await autoUnrestrictLinks(links);
      }
    }
  } catch (err) {
    console.error("[Real-Debrid] Auto-scan failed:", err);
  } finally {
    isScanning = false;
  }
}

/**
 * Trigger a debounced scan
 */
function triggerScan() {
  if (scanTimeout) {
    clearTimeout(scanTimeout);
  }
  scanTimeout = setTimeout(() => {
    performAutoScan();
  }, SCAN_DEBOUNCE_MS);
}

/**
 * Initialize auto-scan
 */
async function initAutoScan(): Promise<void> {
  const { autoScanEnabled } = await getPreferences();
  
  if (autoScanEnabled) {
    // Initial scan
    performAutoScan();
    
    // Set up observer for future changes
    if (!observer) {
      observer = new MutationObserver((mutations) => {
        // Simple check: if any nodes were added, trigger scan
        let shouldScan = false;
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            shouldScan = true;
            break;
          }
        }
        
        if (shouldScan) {
          triggerScan();
        }
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  } else {
    // Clean up if disabled
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimeout) {
      clearTimeout(scanTimeout);
      scanTimeout = null;
    }
  }
}

/**
 * Listen for preference changes to react to auto-scan toggle
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.preferences) {
    initAutoScan();
  }
});

// Initialize auto-scan when content script loads
initAutoScan();
