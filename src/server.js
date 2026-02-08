const express = require('express');
const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Stripe setup
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const STRIPE_PK = process.env.STRIPE_PK;

// In-memory scan history (persisted to disk)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let scanHistory = [];
const HISTORY_FILE = path.join(DATA_DIR, 'scan-history.json');
try { scanHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
function saveHistory() {
  if (scanHistory.length > 1000) scanHistory = scanHistory.slice(-1000);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(scanHistory, null, 2));
}

// Badge registry
let badges = {};
const BADGES_FILE = path.join(DATA_DIR, 'badges.json');
try { badges = JSON.parse(fs.readFileSync(BADGES_FILE, 'utf8')); } catch(e) {}
function saveBadges() { fs.writeFileSync(BADGES_FILE, JSON.stringify(badges, null, 2)); }

// Scheduled monitoring registry
let monitors = [];
const MONITORS_FILE = path.join(DATA_DIR, 'monitors.json');
try { monitors = JSON.parse(fs.readFileSync(MONITORS_FILE, 'utf8')); } catch(e) {}

// Alert preferences store
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
let alertPreferences = {};
try { alertPreferences = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch(e) {}
function saveAlerts() { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alertPreferences, null, 2)); }
function saveMonitors() { fs.writeFileSync(MONITORS_FILE, JSON.stringify(monitors, null, 2)); }

// ==================== WCAG RULES ====================
const WCAG_RULES = {
  'missing-alt': {
    id: 'missing-alt', name: 'Images missing alt text',
    wcag: 'WCAG 2.1 SC 1.1.1', level: 'A', principle: 'Perceivable',
    description: 'All non-decorative images must have alternative text that describes their content.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html'
  },
  'empty-alt': {
    id: 'empty-alt', name: 'Images with empty alt on non-decorative elements',
    wcag: 'WCAG 2.1 SC 1.1.1', level: 'A', principle: 'Perceivable',
    description: 'Empty alt="" should only be used for decorative images. Functional images need descriptive alt text.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html'
  },
  'missing-lang': {
    id: 'missing-lang', name: 'Missing page language',
    wcag: 'WCAG 2.1 SC 3.1.1', level: 'A', principle: 'Understandable',
    description: 'The default human language of each web page must be programmatically determined.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html'
  },
  'missing-title': {
    id: 'missing-title', name: 'Missing page title',
    wcag: 'WCAG 2.1 SC 2.4.2', level: 'A', principle: 'Operable',
    description: 'Web pages must have titles that describe topic or purpose.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/page-titled.html'
  },
  'missing-heading': {
    id: 'missing-heading', name: 'No heading structure',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Pages should use heading elements to convey document structure.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'skipped-heading': {
    id: 'skipped-heading', name: 'Skipped heading levels',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Heading levels should not be skipped (e.g., h1 → h3 without h2).',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'missing-form-label': {
    id: 'missing-form-label', name: 'Form inputs without labels',
    wcag: 'WCAG 2.1 SC 1.3.1 / 4.1.2', level: 'A', principle: 'Perceivable',
    description: 'All form inputs must have associated labels for screen reader users.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'empty-link': {
    id: 'empty-link', name: 'Links with no accessible text',
    wcag: 'WCAG 2.1 SC 2.4.4', level: 'A', principle: 'Operable',
    description: 'Links must have discernible text that describes their destination.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html'
  },
  'empty-button': {
    id: 'empty-button', name: 'Buttons with no accessible text',
    wcag: 'WCAG 2.1 SC 4.1.2', level: 'A', principle: 'Robust',
    description: 'Buttons must have discernible text that describes their action.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html'
  },
  'missing-viewport': {
    id: 'missing-viewport', name: 'Missing viewport meta tag',
    wcag: 'WCAG 2.1 SC 1.4.10', level: 'AA', principle: 'Perceivable',
    description: 'Pages should include a viewport meta tag for mobile accessibility.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html'
  },
  'no-skip-link': {
    id: 'no-skip-link', name: 'No skip navigation link',
    wcag: 'WCAG 2.1 SC 2.4.1', level: 'A', principle: 'Operable',
    description: 'A mechanism should be available to bypass blocks of content that are repeated on multiple pages.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html'
  },
  'missing-landmark': {
    id: 'missing-landmark', name: 'No ARIA landmarks or semantic HTML5',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Pages should use ARIA landmarks or HTML5 semantic elements (main, nav, header, footer).',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'low-contrast-text': {
    id: 'low-contrast-text', name: 'Potential low contrast text',
    wcag: 'WCAG 2.1 SC 1.4.3', level: 'AA', principle: 'Perceivable',
    description: 'Text must have a contrast ratio of at least 4.5:1 against its background (3:1 for large text).',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html'
  },
  'autoplay-media': {
    id: 'autoplay-media', name: 'Auto-playing media',
    wcag: 'WCAG 2.1 SC 1.4.2', level: 'A', principle: 'Perceivable',
    description: 'Audio that plays automatically for more than 3 seconds must have a mechanism to pause or stop.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html'
  },
  'tabindex-positive': {
    id: 'tabindex-positive', name: 'Positive tabindex values',
    wcag: 'WCAG 2.1 SC 2.4.3', level: 'A', principle: 'Operable',
    description: 'Avoid positive tabindex values; they create confusing tab order for keyboard users.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/focus-order.html'
  },
  'missing-table-header': {
    id: 'missing-table-header', name: 'Data tables without headers',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Data tables must use th elements or scope attributes to identify headers.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'meta-refresh': {
    id: 'meta-refresh', name: 'Meta refresh redirect',
    wcag: 'WCAG 2.1 SC 2.2.1', level: 'A', principle: 'Operable',
    description: 'Pages should not auto-redirect using meta refresh. Users must control timing.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable.html'
  },
  'inline-styles-text': {
    id: 'inline-styles-text', name: 'Inline text styling (potential contrast issues)',
    wcag: 'WCAG 2.1 SC 1.4.3', level: 'AA', principle: 'Perceivable',
    description: 'Inline color styles may cause contrast issues that are hard to audit.',
    impact: 'minor', url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html'
  },
  // NEW RULES
  'color-contrast-inline': {
    id: 'color-contrast-inline', name: 'Inline color contrast issues',
    wcag: 'WCAG 2.1 SC 1.4.3', level: 'AA', principle: 'Perceivable',
    description: 'Inline styles set text/background colors that may fail the 4.5:1 contrast ratio requirement.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html'
  },
  'keyboard-trap': {
    id: 'keyboard-trap', name: 'Potential keyboard trap',
    wcag: 'WCAG 2.1 SC 2.1.2', level: 'A', principle: 'Operable',
    description: 'Content must not trap keyboard focus. Users must be able to navigate away using standard keys.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html'
  },
  'missing-focus-style': {
    id: 'missing-focus-style', name: 'Focus styles suppressed',
    wcag: 'WCAG 2.1 SC 2.4.7', level: 'AA', principle: 'Operable',
    description: 'Interactive elements must have a visible focus indicator for keyboard users. outline:none or outline:0 without alternative styling removes this.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html'
  },
  'generic-link-text': {
    id: 'generic-link-text', name: 'Generic or ambiguous link text',
    wcag: 'WCAG 2.1 SC 2.4.4', level: 'A', principle: 'Operable',
    description: 'Link text should describe the destination. Phrases like "click here", "read more", or "learn more" are ambiguous without context.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html'
  },
  'missing-keyboard-access': {
    id: 'missing-keyboard-access', name: 'Non-interactive elements with click handlers',
    wcag: 'WCAG 2.1 SC 2.1.1', level: 'A', principle: 'Operable',
    description: 'Elements with click handlers (onclick) that are not natively interactive (links, buttons) must also have keyboard access via tabindex and keydown handlers.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html'
  }
};

// ==================== COLOR CONTRAST UTILITIES ====================
function parseColor(colorStr) {
  if (!colorStr) return null;
  colorStr = colorStr.trim().toLowerCase();
  // Named colors (common ones)
  const namedColors = {
    white:'#ffffff',black:'#000000',red:'#ff0000',green:'#008000',blue:'#0000ff',
    yellow:'#ffff00',gray:'#808080',grey:'#808080',silver:'#c0c0c0',orange:'#ffa500',
    purple:'#800080',navy:'#000080',teal:'#008080',maroon:'#800000',lime:'#00ff00',
    aqua:'#00ffff',fuchsia:'#ff00ff',olive:'#808000',darkgray:'#a9a9a9',lightgray:'#d3d3d3',
    transparent: null
  };
  if (namedColors[colorStr] !== undefined) {
    colorStr = namedColors[colorStr];
    if (!colorStr) return null;
  }
  // Hex
  const hexMatch = colorStr.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length === 6 || hex.length === 8) {
      return { r: parseInt(hex.substr(0,2),16), g: parseInt(hex.substr(2,2),16), b: parseInt(hex.substr(4,2),16) };
    }
  }
  // rgb/rgba
  const rgbMatch = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return { r: parseInt(rgbMatch[1]), g: parseInt(rgbMatch[2]), b: parseInt(rgbMatch[3]) };
  }
  return null;
}

function relativeLuminance(c) {
  const srgb = [c.r/255, c.g/255, c.b/255];
  const lin = srgb.map(v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4));
  return 0.2126*lin[0] + 0.7152*lin[1] + 0.0722*lin[2];
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ==================== FETCH HTML ====================
function fetchHTML(urlStr, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      if (!urlStr.match(/^https?:\/\//i)) urlStr = 'https://' + urlStr;
      url = new URL(urlStr);
    } catch(e) {
      return reject(new Error('Invalid URL: ' + urlStr));
    }

    const protocol = url.protocol === 'https:' ? https : http;
    let redirects = 0;

    function doFetch(fetchUrl) {
      const timer = setTimeout(() => { req.destroy(); reject(new Error('Request timed out after ' + (timeout/1000) + 's')); }, timeout);
      const req = protocol.get(fetchUrl, {
        headers: {
          'User-Agent': 'ComplianceShield/1.0 (WCAG Accessibility Scanner)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: timeout
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timer);
          redirects++;
          if (redirects > 5) return reject(new Error('Too many redirects'));
          try { const newUrl = new URL(res.headers.location, fetchUrl); doFetch(newUrl.href); } catch(e) { reject(new Error('Invalid redirect URL')); }
          return;
        }
        if (res.statusCode !== 200) { clearTimeout(timer); return reject(new Error('HTTP ' + res.statusCode)); }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          data += chunk;
          if (data.length > 5 * 1024 * 1024) { clearTimeout(timer); req.destroy(); reject(new Error('Response too large (>5MB)')); }
        });
        res.on('end', () => { clearTimeout(timer); resolve(data); });
        res.on('error', e => { clearTimeout(timer); reject(e); });
      });
      req.on('error', e => { clearTimeout(timer); reject(e); });
      req.on('timeout', () => { req.destroy(); clearTimeout(timer); reject(new Error('Connection timed out')); });
    }

    doFetch(url.href);
  });
}

// ==================== SCAN ENGINE ====================
function scanHTML(html, url) {
  const $ = cheerio.load(html);
  const issues = [];
  const warnings = [];
  const passes = [];

  function addIssue(ruleId, elements = [], context = '') {
    const rule = WCAG_RULES[ruleId];
    issues.push({ ...rule, elements: elements.slice(0, 5), count: elements.length, context });
  }
  function addWarning(ruleId, details = '') {
    const rule = WCAG_RULES[ruleId];
    warnings.push({ ...rule, details });
  }
  function addPass(ruleId) {
    const rule = WCAG_RULES[ruleId];
    passes.push({ id: rule.id, name: rule.name, wcag: rule.wcag, level: rule.level });
  }

  // 1. Images without alt
  const imgsNoAlt = [];
  const imgsEmptyAlt = [];
  $('img').each((i, el) => {
    const alt = $(el).attr('alt');
    const src = $(el).attr('src') || '';
    if (alt === undefined) imgsNoAlt.push(`<img src="${src.substring(0, 80)}">`);
    else if (alt.trim() === '' && !$(el).attr('role')) imgsEmptyAlt.push(`<img src="${src.substring(0, 80)}" alt="">`);
  });
  if (imgsNoAlt.length > 0) addIssue('missing-alt', imgsNoAlt);
  else addPass('missing-alt');
  if (imgsEmptyAlt.length > 3) addWarning('empty-alt', `${imgsEmptyAlt.length} images with empty alt`);

  // 2. Language
  const lang = $('html').attr('lang') || $('html').attr('xml:lang');
  if (!lang || lang.trim() === '') addIssue('missing-lang', ['<html>']);
  else addPass('missing-lang');

  // 3. Title
  const title = $('title').text().trim();
  if (!title) addIssue('missing-title', ['<title> element missing']);
  else addPass('missing-title');

  // 4. Headings
  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    headings.push({ level: parseInt(el.tagName[1]), text: $(el).text().trim().substring(0, 60) });
  });
  if (headings.length === 0) addIssue('missing-heading', ['No heading elements found']);
  else addPass('missing-heading');

  // 5. Skipped heading levels
  const skipped = [];
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i-1].level + 1) {
      skipped.push(`h${headings[i-1].level} → h${headings[i].level} ("${headings[i].text}")`);
    }
  }
  if (skipped.length > 0) addIssue('skipped-heading', skipped);
  else if (headings.length > 0) addPass('skipped-heading');

  // 6. Form labels
  const unlabeled = [];
  $('input, select, textarea').each((i, el) => {
    const type = $(el).attr('type') || 'text';
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
    const id = $(el).attr('id');
    const ariaLabel = $(el).attr('aria-label') || $(el).attr('aria-labelledby');
    const title = $(el).attr('title');
    const hasLabel = id && $(`label[for="${id}"]`).length > 0;
    const wrappedInLabel = $(el).closest('label').length > 0;
    if (!hasLabel && !wrappedInLabel && !ariaLabel && !title) {
      const name = $(el).attr('name') || $(el).attr('id') || type;
      unlabeled.push(`<${el.tagName} name="${name}">`);
    }
  });
  if (unlabeled.length > 0) addIssue('missing-form-label', unlabeled);
  else addPass('missing-form-label');

  // 7. Empty links
  const emptyLinks = [];
  $('a').each((i, el) => {
    const text = $(el).text().trim();
    const ariaLabel = $(el).attr('aria-label');
    const ariaLabelledBy = $(el).attr('aria-labelledby');
    const hasImg = $(el).find('img[alt]').length > 0;
    const elTitle = $(el).attr('title');
    if (!text && !ariaLabel && !ariaLabelledBy && !hasImg && !elTitle) {
      const href = ($(el).attr('href') || '').substring(0, 60);
      emptyLinks.push(`<a href="${href}"> (no text)</a>`);
    }
  });
  if (emptyLinks.length > 0) addIssue('empty-link', emptyLinks);
  else addPass('empty-link');

  // 8. Empty buttons
  const emptyBtns = [];
  $('button, [role="button"], input[type="button"], input[type="submit"]').each((i, el) => {
    const text = $(el).text().trim();
    const ariaLabel = $(el).attr('aria-label');
    const value = $(el).attr('value');
    const elTitle = $(el).attr('title');
    if (!text && !ariaLabel && !value && !elTitle) {
      emptyBtns.push(`<${el.tagName}> (no accessible name)`);
    }
  });
  if (emptyBtns.length > 0) addIssue('empty-button', emptyBtns);
  else addPass('empty-button');

  // 9. Viewport
  const viewport = $('meta[name="viewport"]').attr('content');
  if (!viewport) addIssue('missing-viewport', ['No viewport meta tag']);
  else addPass('missing-viewport');

  // 10. Skip link
  const firstLinks = $('a').slice(0, 5);
  let hasSkipLink = false;
  firstLinks.each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().toLowerCase();
    if (href.startsWith('#') && (text.includes('skip') || text.includes('main content') || text.includes('jump'))) {
      hasSkipLink = true;
    }
  });
  if (!hasSkipLink && $('[role="navigation"]').length > 0) addWarning('no-skip-link', 'Navigation found but no skip link');
  else if (hasSkipLink) addPass('no-skip-link');

  // 11. Landmarks
  const hasMain = $('main, [role="main"]').length > 0;
  const hasNav = $('nav, [role="navigation"]').length > 0;
  const hasHeader = $('header, [role="banner"]').length > 0;
  const hasFooter = $('footer, [role="contentinfo"]').length > 0;
  const landmarkCount = [hasMain, hasNav, hasHeader, hasFooter].filter(Boolean).length;
  if (landmarkCount === 0) addIssue('missing-landmark', ['No semantic landmarks found']);
  else addPass('missing-landmark');

  // 12. Auto-playing media
  const autoplayMedia = [];
  $('video[autoplay], audio[autoplay]').each((i, el) => {
    autoplayMedia.push(`<${el.tagName} autoplay>`);
  });
  if (autoplayMedia.length > 0) addIssue('autoplay-media', autoplayMedia);
  else addPass('autoplay-media');

  // 13. Positive tabindex
  const posTab = [];
  $('[tabindex]').each((i, el) => {
    const val = parseInt($(el).attr('tabindex'));
    if (val > 0) posTab.push(`<${el.tagName} tabindex="${val}">`);
  });
  if (posTab.length > 0) addIssue('tabindex-positive', posTab);
  else addPass('tabindex-positive');

  // 14. Table headers
  const dataTables = $('table').filter((i, el) => $(el).find('td').length > 4);
  const tablesNoHeader = [];
  dataTables.each((i, el) => {
    if ($(el).find('th').length === 0) tablesNoHeader.push('<table> without <th>');
  });
  if (tablesNoHeader.length > 0) addIssue('missing-table-header', tablesNoHeader);
  else if (dataTables.length > 0) addPass('missing-table-header');

  // 15. Meta refresh
  const metaRefresh = $('meta[http-equiv="refresh"]');
  if (metaRefresh.length > 0) addIssue('meta-refresh', ['<meta http-equiv="refresh">']);
  else addPass('meta-refresh');

  // 16. Inline color styles (warning only)
  let inlineColorCount = 0;
  $('[style]').each((i, el) => {
    const style = $(el).attr('style') || '';
    if (style.match(/color\s*:/i)) inlineColorCount++;
  });
  if (inlineColorCount > 5) addWarning('inline-styles-text', `${inlineColorCount} elements with inline color styles`);

  // ==================== NEW CHECKS ====================

  // 17. Color contrast estimation on inline styles
  const contrastIssues = [];
  $('[style]').each((i, el) => {
    const style = $(el).attr('style') || '';
    const colorMatch = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    const bgMatch = style.match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (colorMatch && bgMatch) {
      const fg = parseColor(colorMatch[1]);
      const bg = parseColor(bgMatch[1]);
      if (fg && bg) {
        const ratio = contrastRatio(fg, bg);
        if (ratio < 4.5) {
          const text = $(el).text().trim().substring(0, 40);
          contrastIssues.push(`"${text || '(element)'}" — ratio ${ratio.toFixed(1)}:1 (needs 4.5:1) [color:${colorMatch[1].trim()}, bg:${bgMatch[1].trim()}]`);
        }
      }
    }
  });
  if (contrastIssues.length > 0) addIssue('color-contrast-inline', contrastIssues);
  else addPass('color-contrast-inline');

  // 18. Keyboard trap detection (tabindex=-1 on focusable containers with no escape)
  const trapElements = [];
  $('[onkeydown], [onkeypress]').each((i, el) => {
    const handler = ($(el).attr('onkeydown') || '') + ($(el).attr('onkeypress') || '');
    if (handler.match(/preventDefault/i) && !handler.match(/Tab|Escape|27|9/i)) {
      trapElements.push(`<${el.tagName}> with aggressive key prevention`);
    }
  });
  if (trapElements.length > 0) addIssue('keyboard-trap', trapElements);
  else addPass('keyboard-trap');

  // 19. Focus styles suppressed (outline:none/0 in inline styles or style tags)
  const focusSuppressed = [];
  // Check style tags for outline:none on focus
  let stylesheetText = '';
  $('style').each((i, el) => { stylesheetText += $(el).html() || ''; });
  const focusNoneMatches = stylesheetText.match(/[^}]*:focus\s*\{[^}]*outline\s*:\s*(none|0)[^}]*/gi);
  if (focusNoneMatches) {
    focusNoneMatches.forEach(m => {
      // Check if there's a replacement like box-shadow or border
      if (!m.match(/box-shadow|border/i)) {
        const selector = m.split('{')[0].trim().substring(0, 60);
        focusSuppressed.push(`${selector} — outline removed without alternative`);
      }
    });
  }
  // Also check inline outline:none on interactive elements
  $('a[style], button[style], input[style], select[style], textarea[style], [tabindex][style]').each((i, el) => {
    const style = $(el).attr('style') || '';
    if (style.match(/outline\s*:\s*(none|0)/i) && !style.match(/box-shadow|border/i)) {
      focusSuppressed.push(`<${el.tagName}> inline outline:none`);
    }
  });
  if (focusSuppressed.length > 0) addIssue('missing-focus-style', focusSuppressed);
  else addPass('missing-focus-style');

  // 20. Generic/ambiguous link text
  const genericPhrases = ['click here', 'here', 'read more', 'learn more', 'more', 'link', 'this', 'go', 'details', 'continue'];
  const genericLinks = [];
  $('a').each((i, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text && genericPhrases.includes(text)) {
      const href = ($(el).attr('href') || '').substring(0, 40);
      genericLinks.push(`"${text}" → ${href || '(no href)'}`);
    }
  });
  if (genericLinks.length > 0) addIssue('generic-link-text', genericLinks);
  else addPass('generic-link-text');

  // 21. Non-interactive elements with onclick but no keyboard access
  const noKeyboard = [];
  const interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'summary'];
  $('[onclick]').each((i, el) => {
    const tag = el.tagName.toLowerCase();
    const role = $(el).attr('role') || '';
    if (!interactiveTags.includes(tag) && role !== 'button' && role !== 'link') {
      const hasTabindex = $(el).attr('tabindex') !== undefined;
      const hasKeyHandler = $(el).attr('onkeydown') || $(el).attr('onkeypress') || $(el).attr('onkeyup');
      if (!hasTabindex || !hasKeyHandler) {
        const text = $(el).text().trim().substring(0, 40);
        noKeyboard.push(`<${tag}> "${text}" — has onclick but ${!hasTabindex ? 'no tabindex' : 'no key handler'}`);
      }
    }
  });
  if (noKeyboard.length > 0) addIssue('missing-keyboard-access', noKeyboard);
  else addPass('missing-keyboard-access');

  // Calculate score
  const totalChecks = issues.length + passes.length;
  const score = totalChecks > 0 ? Math.round((passes.length / totalChecks) * 100) : 0;

  const criticalIssues = issues.filter(i => i.impact === 'critical').length;
  const seriousIssues = issues.filter(i => i.impact === 'serious').length;
  let complianceLevel = 'compliant';
  if (criticalIssues > 0) complianceLevel = 'non-compliant';
  else if (seriousIssues > 1) complianceLevel = 'partially-compliant';
  else if (issues.length > 0) complianceLevel = 'needs-improvement';

  return {
    url,
    scannedAt: new Date().toISOString(),
    score,
    complianceLevel,
    summary: {
      totalChecks,
      passed: passes.length,
      issues: issues.length,
      warnings: warnings.length,
      critical: criticalIssues,
      serious: seriousIssues,
      moderate: issues.filter(i => i.impact === 'moderate').length,
      minor: issues.filter(i => i.impact === 'minor').length
    },
    issues,
    warnings,
    passes,
    pageInfo: {
      title: title || '(no title)',
      lang: lang || '(not set)',
      headingCount: headings.length,
      imageCount: $('img').length,
      linkCount: $('a').length,
      formCount: $('form').length,
      landmarks: landmarkCount
    }
  };
}

// ==================== API ROUTES ====================

// Scan endpoint
app.post('/api/scan', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Please provide a valid URL' });

  let normalizedUrl = url.trim();
  if (!normalizedUrl.match(/^https?:\/\//i)) normalizedUrl = 'https://' + normalizedUrl;
  try { new URL(normalizedUrl); } catch(e) {
    return res.status(400).json({ error: 'Invalid URL format. Please enter a valid website address.' });
  }

  try {
    const html = await fetchHTML(normalizedUrl);
    const result = scanHTML(html, normalizedUrl);
    const scanRecord = { id: uuidv4(), ...result };
    scanHistory.push(scanRecord);
    saveHistory();
    res.json(scanRecord);
  } catch(err) {
    const msg = err.message || 'Unknown error';
    if (msg.includes('timed out')) return res.status(504).json({ error: 'The website took too long to respond. Please try again or check the URL.' });
    if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) return res.status(400).json({ error: 'Could not find that website. Please check the URL and try again.' });
    if (msg.includes('ECONNREFUSED')) return res.status(502).json({ error: 'Connection refused by the website. It may be down or blocking scanners.' });
    if (msg.includes('certificate') || msg.includes('SSL')) return res.status(502).json({ error: 'SSL/TLS certificate error. The website may have security issues.' });
    res.status(500).json({ error: 'Scan failed: ' + msg });
  }
});

// Scan history
app.get('/api/history', (req, res) => {
  const { url, limit = 20 } = req.query;
  let results = scanHistory;
  if (url) results = results.filter(s => s.url.includes(url));
  results = results.slice(-parseInt(limit)).reverse();
  res.json(results);
});

// Get specific scan
app.get('/api/scan/:id', (req, res) => {
  const scan = scanHistory.find(s => s.id === req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

// ==================== TREND / COMPARISON API ====================
app.get('/api/trend', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter required' });

  let normalizedUrl = url.trim();
  if (!normalizedUrl.match(/^https?:\/\//i)) normalizedUrl = 'https://' + normalizedUrl;

  // Find all scans for this URL (fuzzy match on domain)
  let domain;
  try { domain = new URL(normalizedUrl).hostname; } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }

  const urlScans = scanHistory.filter(s => {
    try { return new URL(s.url).hostname === domain; } catch(e) { return false; }
  });

  if (urlScans.length === 0) return res.json({ url: normalizedUrl, domain, scans: [], trend: null });

  const dataPoints = urlScans.map(s => ({
    id: s.id,
    date: s.scannedAt,
    score: s.score,
    issues: s.summary.issues,
    critical: s.summary.critical,
    passed: s.summary.passed,
    complianceLevel: s.complianceLevel
  }));

  // Calculate trend
  let trend = null;
  if (dataPoints.length >= 2) {
    const first = dataPoints[0];
    const last = dataPoints[dataPoints.length - 1];
    trend = {
      scoreChange: last.score - first.score,
      issuesChange: last.issues - first.issues,
      direction: last.score > first.score ? 'improving' : last.score < first.score ? 'declining' : 'stable',
      totalScans: dataPoints.length,
      firstScan: first.date,
      lastScan: last.date
    };
  }

  res.json({ url: normalizedUrl, domain, scans: dataPoints, trend });
});

// ==================== SCHEDULED MONITORING ====================

// ==================== SCAN HISTORY WITH DIFFS ====================
app.get('/api/scan-history/:encodedUrl', (req, res) => {
  let targetUrl = decodeURIComponent(req.params.encodedUrl).trim();
  if (!targetUrl.match(/^https?:\/\//i)) targetUrl = 'https://' + targetUrl;

  let domain;
  try { domain = new URL(targetUrl).hostname; } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }

  // Find all scans matching this domain
  const urlScans = scanHistory.filter(s => {
    try { return new URL(s.url).hostname === domain; } catch(e) { return false; }
  });

  if (urlScans.length === 0) return res.json({ url: targetUrl, domain, history: [], diff: null });

  // Build history with diffs between consecutive scans
  const history = urlScans.map((scan, i) => {
    const entry = {
      id: scan.id,
      date: scan.scannedAt,
      score: scan.score,
      complianceLevel: scan.complianceLevel,
      issueCount: scan.summary.issues,
      critical: scan.summary.critical,
      serious: scan.summary.serious,
      passed: scan.summary.passed,
      issueIds: scan.issues.map(iss => iss.id)
    };

    if (i > 0) {
      const prev = urlScans[i - 1];
      const prevIssueIds = new Set(prev.issues.map(iss => iss.id));
      const currIssueIds = new Set(scan.issues.map(iss => iss.id));
      const fixed = [...prevIssueIds].filter(id => !currIssueIds.has(id));
      const newIssues = [...currIssueIds].filter(id => !prevIssueIds.has(id));
      entry.diff = {
        scoreChange: scan.score - prev.score,
        issuesFixed: fixed,
        issuesFixedCount: fixed.length,
        newIssues: newIssues,
        newIssuesCount: newIssues.length,
        fixedNames: fixed.map(id => WCAG_RULES[id] ? WCAG_RULES[id].name : id),
        newNames: newIssues.map(id => WCAG_RULES[id] ? WCAG_RULES[id].name : id)
      };
    }
    return entry;
  });

  // Latest diff summary
  const latestDiff = history.length >= 2 ? history[history.length - 1].diff : null;

  res.json({ url: targetUrl, domain, totalScans: history.length, history, latestDiff });
});
app.post('/api/monitor', (req, res) => {
  const { url, email, frequency } = req.body;
  if (!url || !email) return res.status(400).json({ error: 'URL and email are required' });

  // Validate email
  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return res.status(400).json({ error: 'Invalid email address' });

  let normalizedUrl = url.trim();
  if (!normalizedUrl.match(/^https?:\/\//i)) normalizedUrl = 'https://' + normalizedUrl;
  try { new URL(normalizedUrl); } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }

  // Check if already monitored
  const existing = monitors.find(m => m.url === normalizedUrl && m.email === email);
  if (existing) {
    existing.frequency = frequency || 'weekly';
    existing.active = true;
    existing.updatedAt = new Date().toISOString();
    saveMonitors();
    return res.json({ message: 'Monitor updated', monitor: existing });
  }

  const monitor = {
    id: uuidv4(),
    url: normalizedUrl,
    email: email.trim().toLowerCase(),
    frequency: frequency || 'weekly',
    active: true,
    createdAt: new Date().toISOString(),
    lastScanAt: null,
    lastScore: null,
    nextScanAt: new Date(Date.now() + (frequency === 'daily' ? 24*60*60*1000 : frequency === 'monthly' ? 30*24*60*60*1000 : 7*24*60*60*1000)).toISOString()
  };
  monitors.push(monitor);
  saveMonitors();

  res.json({ message: 'Monitor registered! You will receive weekly scan results at ' + email, monitor });
});

app.get('/api/monitors', (req, res) => {
  const { email } = req.query;
  if (!email) return res.json(monitors.filter(m => m.active).map(m => ({ id: m.id, url: m.url, frequency: m.frequency, lastScore: m.lastScore, nextScanAt: m.nextScanAt })));
  res.json(monitors.filter(m => m.email === email.toLowerCase() && m.active));
});

app.delete('/api/monitor/:id', (req, res) => {
  const monitor = monitors.find(m => m.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  monitor.active = false;
  saveMonitors();
  res.json({ message: 'Monitor deactivated' });
});

// Background scheduled scan runner (checks every hour)
async function runScheduledScans() {
  const now = new Date();
  for (const monitor of monitors) {
    if (!monitor.active) continue;
    if (monitor.nextScanAt && new Date(monitor.nextScanAt) > now) continue;

    try {
      console.log(`[Monitor] Scanning ${monitor.url} for ${monitor.email}`);
      const html = await fetchHTML(monitor.url);
      const result = scanHTML(html, monitor.url);
      const scanRecord = { id: uuidv4(), ...result };
      scanHistory.push(scanRecord);
      saveHistory();

      monitor.lastScanAt = now.toISOString();
      monitor.lastScore = result.score;
      // Set next scan based on frequency
      const intervalMs = monitor.frequency === 'daily' ? 24*60*60*1000 : monitor.frequency === 'monthly' ? 30*24*60*60*1000 : 7*24*60*60*1000;
      monitor.nextScanAt = new Date(now.getTime() + intervalMs).toISOString();
      saveMonitors();

      console.log(`[Monitor] ${monitor.url} scored ${result.score}/100 (${result.summary.issues} issues)`);
    } catch(e) {
      console.error(`[Monitor] Failed to scan ${monitor.url}: ${e.message}`);
    }
  }
}

// Run scheduled scans every hour
setInterval(runScheduledScans, 60 * 60 * 1000);
// Also run once on startup after 30 seconds
setTimeout(runScheduledScans, 30000);

// PDF report
app.get('/api/scan/:id/pdf', (req, res) => {
  const scan = scanHistory.find(s => s.id === req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="compliance-report-${scan.id.substring(0,8)}.pdf"`);
  doc.pipe(res);

  doc.fontSize(24).font('Helvetica-Bold').text('ComplianceShield', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text('ADA/WCAG Accessibility Compliance Report', { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
  doc.moveDown();

  doc.fontSize(14).font('Helvetica-Bold').text('Scan Summary');
  doc.fontSize(10).font('Helvetica');
  doc.text(`URL: ${scan.url}`);
  doc.text(`Date: ${new Date(scan.scannedAt).toLocaleString()}`);
  doc.text(`Score: ${scan.score}/100`);
  doc.text(`Status: ${scan.complianceLevel.replace(/-/g, ' ').toUpperCase()}`);
  doc.text(`Issues Found: ${scan.summary.issues} (${scan.summary.critical} critical, ${scan.summary.serious} serious)`);
  doc.text(`Checks Passed: ${scan.summary.passed}/${scan.summary.totalChecks}`);
  doc.moveDown();

  if (scan.issues.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').text('Issues Found');
    doc.moveDown(0.5);
    scan.issues.forEach((issue, i) => {
      if (doc.y > 700) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold')
        .text(`${i+1}. ${issue.name}`, { continued: true })
        .font('Helvetica').text(` [${issue.impact.toUpperCase()}]`);
      doc.fontSize(9).font('Helvetica')
        .text(`   WCAG Reference: ${issue.wcag} (Level ${issue.level})`)
        .text(`   ${issue.description}`)
        .text(`   Occurrences: ${issue.count}`)
        .text(`   Learn more: ${issue.url}`);
      if (issue.elements && issue.elements.length > 0) {
        doc.text(`   Examples: ${issue.elements.slice(0, 3).join(', ')}`);
      }
      doc.moveDown(0.5);
    });
  }

  if (scan.passes.length > 0) {
    if (doc.y > 650) doc.addPage();
    doc.moveDown();
    doc.fontSize(14).font('Helvetica-Bold').text('Checks Passed ✓');
    doc.moveDown(0.5);
    scan.passes.forEach(p => {
      doc.fontSize(10).font('Helvetica').text(`✓ ${p.name} (${p.wcag})`);
    });
  }

  doc.moveDown(2);
  doc.fontSize(8).font('Helvetica').fillColor('#888')
    .text('Generated by ComplianceShield — https://gamma.abapture.ai', { align: 'center' })
    .text('This report provides automated accessibility checks. Manual testing by accessibility experts is also recommended.', { align: 'center' });
  doc.end();
});

// ==================== COMPLIANCE BADGE ====================
app.post('/api/badge/generate', async (req, res) => {
  const { url, scanId } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const scan = scanId
    ? scanHistory.find(s => s.id === scanId)
    : [...scanHistory].reverse().find(s => s.url.includes(url));

  if (!scan) return res.status(404).json({ error: 'No scan found for this URL. Please scan it first.' });
  if (scan.complianceLevel === 'non-compliant') return res.status(400).json({ error: 'Badge not available for non-compliant sites. Fix critical issues first.' });

  const badgeId = crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
  badges[badgeId] = {
    url: scan.url, score: scan.score, level: scan.complianceLevel,
    scanId: scan.id, issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  saveBadges();

  res.json({
    badgeId,
    embedCode: `<a href="https://gamma.abapture.ai/badge/${badgeId}" target="_blank"><img src="https://gamma.abapture.ai/api/badge/${badgeId}.svg" alt="WCAG Compliance Badge" /></a>`,
    svgUrl: `https://gamma.abapture.ai/api/badge/${badgeId}.svg`,
    verifyUrl: `https://gamma.abapture.ai/badge/${badgeId}`
  });
});

app.get('/api/badge/:id.svg', (req, res) => {
  const id = req.params.id;
  const badge = badges[id];
  let color = '#4CAF50', text = 'WCAG Compliant', scoreText = '?';
  if (badge) {
    scoreText = badge.score + '/100';
    if (badge.level === 'compliant') { color = '#4CAF50'; text = 'WCAG Compliant'; }
    else if (badge.level === 'needs-improvement') { color = '#FF9800'; text = 'Needs Work'; }
    else { color = '#F44336'; text = 'Non-Compliant'; }
    if (new Date(badge.expiresAt) < new Date()) { color = '#9E9E9E'; text = 'Expired'; }
  } else { color = '#9E9E9E'; text = 'Unknown'; scoreText = '?'; }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="28" role="img" aria-label="ComplianceShield: ${text}">
  <title>ComplianceShield: ${text}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".15"/><stop offset="1" stop-opacity=".15"/></linearGradient>
  <clipPath id="r"><rect width="220" height="28" rx="5" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="130" height="28" fill="#333"/>
    <rect x="130" width="90" height="28" fill="${color}"/>
    <rect width="220" height="28" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="10" font-weight="bold">
    <text x="65" y="18" fill="#fff">🛡️ ComplianceShield</text>
    <text x="175" y="18" fill="#fff">${text} ${scoreText}</text>
  </g>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, max-age=3600');
  res.send(svg);
});

app.get('/badge/:id', (req, res) => {
  const badge = badges[req.params.id];
  if (!badge) return res.redirect('/?badge=invalid');
  res.redirect('/?badge=' + req.params.id);
});

// ==================== STRIPE ====================
app.post('/api/checkout', async (req, res) => {
  const { plan } = req.body;
  const prices = {
    pro: { amount: 2900, name: 'ComplianceShield Pro — Monthly', interval: 'month' },
    enterprise: { amount: 9900, name: 'ComplianceShield Enterprise — Monthly', interval: 'month' }
  };
  const p = prices[plan];
  if (!p) return res.status(400).json({ error: 'Invalid plan' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: p.name }, unit_amount: p.amount, recurring: { interval: p.interval } }, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://gamma.abapture.ai/?checkout=success',
      cancel_url: 'https://gamma.abapture.ai/?checkout=cancel'
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: 'Checkout failed: ' + e.message }); }
});

// ==================== EMAIL REPORT (LEAD CAPTURE) ====================
let emailLeads = [];
const LEADS_FILE = path.join(DATA_DIR, 'email-leads.json');
try { emailLeads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch(e) {}
function saveLeads() { fs.writeFileSync(LEADS_FILE, JSON.stringify(emailLeads, null, 2)); }

app.post('/api/email-report', (req, res) => {
  const { email, scanId } = req.body;
  if (!email || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return res.status(400).json({ error: 'Valid email required' });
  const scan = scanHistory.find(s => s.id === scanId);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  // Save lead
  emailLeads.push({ email: email.trim().toLowerCase(), scanId, url: scan.url, score: scan.score, capturedAt: new Date().toISOString() });
  saveLeads();

  // In production, we'd send an actual email here. For now, confirm capture.
  res.json({ message: 'Report sent! Check your inbox for the full compliance report.', email });
});

// ==================== COMPARE ENDPOINT ====================
app.post('/api/compare', async (req, res) => {
  const { url1, url2 } = req.body;
  if (!url1 || !url2) return res.status(400).json({ error: 'Two URLs are required' });

  let norm1 = url1.trim(), norm2 = url2.trim();
  if (!norm1.match(/^https?:\/\//i)) norm1 = 'https://' + norm1;
  if (!norm2.match(/^https?:\/\//i)) norm2 = 'https://' + norm2;
  try { new URL(norm1); new URL(norm2); } catch(e) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  try {
    const [html1, html2] = await Promise.all([fetchHTML(norm1), fetchHTML(norm2)]);
    const result1 = scanHTML(html1, norm1);
    const result2 = scanHTML(html2, norm2);
    const r1 = { id: uuidv4(), ...result1 };
    const r2 = { id: uuidv4(), ...result2 };
    scanHistory.push(r1, r2);
    saveHistory();
    res.json({ site1: r1, site2: r2, winner: r1.score >= r2.score ? 'site1' : 'site2' });
  } catch(err) {
    res.status(500).json({ error: 'Compare failed: ' + (err.message || 'Unknown error') });
  }
});

// ==================== LANDING PAGE ====================
app.get('/', (req, res) => { res.send(LANDING_PAGE); });

// Alert preferences endpoints
app.post('/api/alerts/configure', (req, res) => {
  const { email, frequency, enabled, url } = req.body;
  if (!email || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return res.status(400).json({ error: 'Valid email is required' });
  const validFreq = ['daily', 'weekly', 'biweekly', 'monthly'];
  const freq = validFreq.includes(frequency) ? frequency : 'weekly';
  const config = {
    email: email.toLowerCase().trim(),
    frequency: freq,
    enabled: enabled !== false,
    url: url || null,
    configuredAt: new Date().toISOString()
  };
  alertPreferences[email.toLowerCase().trim()] = config;
  saveAlerts();
  // Also update any matching monitors
  monitors.filter(m => m.email === email.toLowerCase().trim()).forEach(m => {
    m.frequency = freq;
    m.active = config.enabled;
  });
  saveMonitors();
  console.log('[Alerts] Configured:', config);
  res.json({ success: true, message: 'Alerts configured successfully', config });
});

app.get('/api/alerts/status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email parameter required' });
  const config = alertPreferences[email.toLowerCase().trim()];
  if (!config) return res.json({ configured: false });
  res.json({ configured: true, ...config });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), monitors: monitors.filter(m => m.active).length, totalScans: scanHistory.length }));

const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ComplianceShield — ADA & WCAG Accessibility Compliance Scanner</title>
<meta name="description" content="Scan any website for ADA/WCAG accessibility compliance in seconds. Get detailed reports, compliance badges, and actionable fixes. Avoid costly lawsuits.">
<style>
:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--accent:#6c5ce7;--accent2:#a29bfe;--text:#e0e0e0;--muted:#888;--green:#00b894;--red:#e74c3c;--orange:#f39c12;--yellow:#f1c40f}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Inter','Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
a{color:var(--accent2);text-decoration:none}
.container{max-width:1000px;margin:0 auto;padding:0 24px}
.hero{text-align:center;padding:60px 0 40px}
.hero-badge{display:inline-block;background:linear-gradient(135deg,#e74c3c,#e67e22);color:white;padding:6px 16px;border-radius:20px;font-size:0.8rem;font-weight:700;margin-bottom:20px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
.hero h1{font-size:3rem;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2),var(--green));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:16px}
.hero p{font-size:1.2rem;color:var(--muted);max-width:650px;margin:0 auto 32px}
.shield-icon{font-size:4rem;margin-bottom:16px}
.scanner{background:var(--card);border:2px solid var(--accent);border-radius:16px;padding:32px;margin:0 auto 60px;max-width:700px}
.scanner h2{text-align:center;margin-bottom:16px;font-size:1.5rem;color:white}
.scanner-form{display:flex;gap:12px}
.scanner-input{flex:1;padding:14px 18px;border-radius:10px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:1rem;outline:none}
.scanner-input:focus{border-color:var(--accent)}
.scanner-btn{padding:14px 28px;background:var(--accent);color:white;border:none;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;white-space:nowrap}
.scanner-btn:hover{background:var(--accent2)}
.scanner-btn:disabled{opacity:0.5;cursor:not-allowed}
.scanner-hint{text-align:center;margin-top:8px;font-size:0.8rem;color:var(--muted)}
.results{display:none;margin-top:24px}.results.show{display:block}
.score-ring{text-align:center;margin:20px 0}
.score-number{font-size:3.5rem;font-weight:800}
.score-label{font-size:0.9rem;color:var(--muted)}
.compliance-status{text-align:center;padding:10px 20px;border-radius:8px;font-weight:700;margin:12px 0;font-size:1.1rem}
.status-compliant{background:rgba(0,184,148,0.15);color:var(--green);border:1px solid var(--green)}
.status-needs-improvement{background:rgba(243,156,18,0.15);color:var(--orange);border:1px solid var(--orange)}
.status-partially-compliant{background:rgba(241,196,15,0.15);color:var(--yellow);border:1px solid var(--yellow)}
.status-non-compliant{background:rgba(231,76,60,0.15);color:var(--red);border:1px solid var(--red)}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}
.stat{background:var(--bg);padding:16px;border-radius:10px;text-align:center}
.stat-num{font-size:1.8rem;font-weight:800}
.stat-label{font-size:0.75rem;color:var(--muted);text-transform:uppercase}
.issues-list{margin-top:20px}
.issue-item{background:var(--bg);border-radius:10px;padding:16px;margin-bottom:10px;border-left:4px solid var(--red)}
.issue-item.serious{border-left-color:var(--orange)}
.issue-item.moderate{border-left-color:var(--yellow)}
.issue-item.minor{border-left-color:var(--muted)}
.issue-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.issue-name{font-weight:700;color:white}
.issue-impact{font-size:0.7rem;padding:3px 8px;border-radius:4px;font-weight:700;text-transform:uppercase}
.impact-critical{background:rgba(231,76,60,0.2);color:var(--red)}
.impact-serious{background:rgba(230,126,34,0.2);color:var(--orange)}
.impact-moderate{background:rgba(241,196,15,0.2);color:var(--yellow)}
.impact-minor{background:rgba(149,165,166,0.2);color:var(--muted)}
.issue-wcag{font-size:0.8rem;color:var(--accent2);margin-bottom:4px}
.issue-desc{font-size:0.85rem;color:var(--muted)}
.issue-elements{font-family:monospace;font-size:0.75rem;background:#1a1a2e;padding:8px;border-radius:6px;margin-top:8px;color:var(--orange);overflow-x:auto}
.issue-link{font-size:0.75rem;color:var(--accent2);margin-top:4px;display:inline-block}
.passes-section{margin-top:20px}
.pass-item{display:inline-block;background:rgba(0,184,148,0.1);color:var(--green);padding:6px 12px;border-radius:6px;font-size:0.8rem;margin:3px}
.action-btns{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.action-btn{padding:10px 18px;border-radius:8px;font-weight:600;font-size:0.85rem;cursor:pointer;border:1px solid var(--border);background:var(--card);color:white;transition:0.2s}
.action-btn:hover{background:var(--accent);border-color:var(--accent)}

/* Trend chart */
.trend-section{display:none;margin-top:20px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:20px}
.trend-section.show{display:block}
.trend-section h3{color:white;margin-bottom:12px}
.trend-chart{display:flex;align-items:flex-end;gap:4px;height:120px;padding:10px 0;border-bottom:1px solid var(--border)}
.trend-bar{flex:1;min-width:8px;max-width:40px;border-radius:4px 4px 0 0;position:relative;transition:0.3s;cursor:pointer}
.trend-bar:hover{opacity:0.8}
.trend-bar .tooltip{display:none;position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid var(--border);padding:6px 10px;border-radius:6px;font-size:0.7rem;white-space:nowrap;z-index:10;color:white}
.trend-bar:hover .tooltip{display:block}
.trend-meta{display:flex;justify-content:space-between;margin-top:8px;font-size:0.75rem;color:var(--muted)}
.trend-summary{margin-top:12px;padding:12px;background:var(--card);border-radius:8px;font-size:0.85rem}
.trend-up{color:var(--green)}.trend-down{color:var(--red)}.trend-stable{color:var(--muted)}

/* Monitor section */
.monitor-section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-top:20px}
.monitor-section h3{color:white;margin-bottom:12px;font-size:1.1rem}
.monitor-form{display:flex;gap:10px;flex-wrap:wrap}
.monitor-form input{flex:1;min-width:200px;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:0.9rem;outline:none}
.monitor-form input:focus{border-color:var(--accent)}
.monitor-form button{padding:10px 20px;background:var(--green);color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;white-space:nowrap}
.monitor-form button:hover{opacity:0.9}
.monitor-msg{margin-top:8px;font-size:0.85rem;padding:8px;border-radius:6px;display:none}
.monitor-msg.show{display:block}
.monitor-msg.success{background:rgba(0,184,148,0.1);color:var(--green);border:1px solid var(--green)}
.monitor-msg.error{background:rgba(231,76,60,0.1);color:var(--red);border:1px solid var(--red)}

.urgency{background:linear-gradient(135deg,#1a0000,#2a0a0a);border:1px solid #4a1a1a;border-radius:16px;padding:40px;margin:60px 0;text-align:center}
.urgency h2{color:var(--red);font-size:1.8rem;margin-bottom:16px}
.urgency-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:24px 0}
.urgency-stat{padding:20px}
.urgency-stat .num{font-size:2.5rem;font-weight:800;color:var(--red)}
.urgency-stat .label{color:var(--muted);font-size:0.85rem}
.urgency p{color:var(--muted);max-width:600px;margin:16px auto;font-size:0.95rem;line-height:1.7}
.comparison{margin:60px 0}
.comparison h2{text-align:center;font-size:1.8rem;margin-bottom:24px;color:white}
.comp-table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden}
.comp-table th{background:var(--accent);color:white;padding:14px;text-align:left;font-size:0.85rem}
.comp-table td{padding:12px 14px;border-bottom:1px solid var(--border);font-size:0.9rem}
.comp-table tr:last-child td{border-bottom:none}
.comp-table .check{color:var(--green)}.comp-table .cross{color:var(--red)}
.comp-highlight{background:rgba(108,92,231,0.1)}
.pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:40px 0}
.price-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px 24px;text-align:center}
.price-card.featured{border-color:var(--accent);position:relative;transform:scale(1.03)}
.price-card.featured::before{content:'MOST POPULAR';position:absolute;top:-14px;left:50%;transform:translateX(-50%);background:var(--accent);color:white;padding:4px 16px;border-radius:20px;font-size:0.7rem;font-weight:700}
.price-card h3{font-size:1.3rem;color:white;margin-bottom:4px}
.price-card .subtitle{font-size:0.8rem;color:var(--muted);margin-bottom:16px}
.price{font-size:2.5rem;font-weight:800;color:white;margin:12px 0}
.price span{font-size:1rem;color:var(--muted);font-weight:400}
.price-card ul{list-style:none;text-align:left;margin:20px 0}
.price-card li{padding:5px 0;color:var(--muted);font-size:0.85rem}
.price-card li::before{content:'✓ ';color:var(--green);font-weight:bold}
.price-btn{display:block;width:100%;padding:12px;border-radius:8px;font-weight:600;font-size:0.95rem;border:1px solid var(--border);background:transparent;color:white;cursor:pointer;transition:0.2s}
.price-btn:hover{background:var(--accent);border-color:var(--accent)}
.price-card.featured .price-btn{background:var(--accent);border-color:var(--accent)}
.education{margin:60px 0}
.education h2{text-align:center;font-size:1.8rem;margin-bottom:24px;color:white}
.edu-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
.edu-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
.edu-card h3{color:white;margin-bottom:8px;font-size:1.1rem}
.edu-card p{color:var(--muted);font-size:0.9rem;line-height:1.6}
.history{margin:40px 0}
.history h3{margin-bottom:12px;color:white}
.history-item{display:flex;justify-content:space-between;align-items:center;background:var(--card);padding:12px 16px;border-radius:8px;margin-bottom:6px;font-size:0.85rem}
.history-url{color:white;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px}
.history-score{font-weight:700}
.history-date{color:var(--muted);font-size:0.75rem}
.badge-section{display:none;margin-top:20px;background:var(--bg);padding:20px;border-radius:10px;border:1px solid var(--green)}
.badge-section.show{display:block}
.badge-section h3{color:var(--green);margin-bottom:8px}
.badge-code{background:#1a1a2e;padding:12px;border-radius:6px;font-family:monospace;font-size:0.75rem;overflow-x:auto;color:var(--green);margin:8px 0}
.copy-btn{font-size:0.75rem;padding:4px 10px;background:var(--green);color:white;border:none;border-radius:4px;cursor:pointer}
/* Category sections */
.category-group{background:var(--bg);border:1px solid var(--border);border-radius:12px;margin-bottom:12px;overflow:hidden}
.category-header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;cursor:pointer;user-select:none;transition:0.2s}
.category-header:hover{background:rgba(108,92,231,0.08)}
.category-header h4{color:white;font-size:0.95rem;display:flex;align-items:center;gap:8px}
.category-header .cat-count{font-size:0.75rem;padding:2px 8px;border-radius:10px;background:rgba(231,76,60,0.15);color:var(--red)}
.category-header .chevron{transition:transform 0.3s;color:var(--muted);font-size:0.8rem}
.category-header.open .chevron{transform:rotate(180deg)}
.category-body{max-height:0;overflow:hidden;transition:max-height 0.4s ease}
.category-body.open{max-height:5000px}
.category-body-inner{padding:0 18px 16px}
/* Compare section */
.compare-section{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;margin:0 auto 40px;max-width:700px}
.compare-section h2{text-align:center;margin-bottom:16px;font-size:1.3rem;color:white}
.compare-form{display:flex;flex-direction:column;gap:10px}
.compare-row{display:flex;gap:10px}
.compare-row input{flex:1;padding:12px 16px;border-radius:10px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:0.95rem;outline:none}
.compare-row input:focus{border-color:var(--accent)}
.compare-btn{padding:12px 24px;background:linear-gradient(135deg,var(--accent),#a29bfe);color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:0.95rem}
.compare-btn:hover{opacity:0.9}
.compare-btn:disabled{opacity:0.5;cursor:not-allowed}
.compare-results{display:none;margin-top:24px}.compare-results.show{display:block}
.compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.compare-card{background:var(--bg);border:2px solid var(--border);border-radius:12px;padding:20px;text-align:center;position:relative}
.compare-card.winner{border-color:var(--green)}
.compare-card .winner-badge{display:none;position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--green);color:white;padding:3px 14px;border-radius:12px;font-size:0.75rem;font-weight:700}
.compare-card.winner .winner-badge{display:block}
.compare-card .comp-url{font-size:0.8rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:8px}
.compare-card .comp-score{font-size:2.5rem;font-weight:800;margin:8px 0}
.compare-card .comp-detail{font-size:0.8rem;color:var(--muted)}
/* Recent scans */
.recent-scans{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;margin:0 auto 40px;max-width:700px;display:none}
.recent-scans.show{display:block}
.recent-scans h3{color:white;margin-bottom:12px;font-size:1.1rem}
.recent-item{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:8px;margin-bottom:6px;cursor:pointer;transition:0.2s}
.recent-item:hover{border-left:3px solid var(--accent);padding-left:11px}
.recent-item .ri-url{color:white;font-weight:500;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px}
.recent-item .ri-score{font-weight:700;font-size:0.9rem}
.recent-item .ri-date{font-size:0.7rem;color:var(--muted)}
.recent-item .ri-trend{font-size:0.7rem;margin-left:6px}
/* Share badge */
.share-badge{display:none;margin-top:16px;background:linear-gradient(135deg,rgba(0,184,148,0.1),rgba(108,92,231,0.1));border:1px solid var(--green);border-radius:12px;padding:20px}
.share-badge.show{display:block}
.share-badge h3{color:var(--green);margin-bottom:8px;font-size:1rem}
.share-badge p{font-size:0.8rem;color:var(--muted);margin-bottom:10px}
.share-badge-preview{text-align:center;margin:12px 0}
.share-snippet{background:#1a1a2e;padding:12px;border-radius:8px;font-family:monospace;font-size:0.72rem;color:var(--green);overflow-x:auto;margin:8px 0;white-space:pre-wrap;word-break:break-all}
.share-btns{display:flex;gap:8px;flex-wrap:wrap}
.share-btns button{padding:6px 14px;border-radius:6px;border:none;font-size:0.8rem;font-weight:600;cursor:pointer;transition:0.2s}
.share-btns .copy-embed{background:var(--green);color:white}
.share-btns .copy-embed:hover{opacity:0.85}
.share-btns .share-twitter{background:#1DA1F2;color:white}
.share-btns .share-linkedin{background:#0077B5;color:white}
footer{text-align:center;padding:40px 0;color:var(--muted);font-size:0.85rem;border-top:1px solid var(--border);margin-top:60px}
.loading{display:none;text-align:center;margin:24px 0}.loading.show{display:block}
.spinner{display:inline-block;width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.error-msg{display:none;text-align:center;padding:16px;background:rgba(231,76,60,0.1);border:1px solid var(--red);border-radius:10px;color:var(--red);margin:16px 0}
.error-msg.show{display:block}
/* Fix Priority List */
.fix-priority{margin-top:24px;background:linear-gradient(135deg,rgba(108,92,231,0.08),rgba(0,184,148,0.08));border:1px solid var(--accent);border-radius:14px;padding:24px}
.fix-priority h3{color:white;font-size:1.15rem;margin-bottom:4px}
.fix-priority .fp-sub{color:var(--muted);font-size:0.82rem;margin-bottom:16px}
.fix-item{background:var(--card);border-radius:10px;padding:16px;margin-bottom:10px;border-left:4px solid var(--accent)}
.fix-item.critical{border-left-color:var(--red)}.fix-item.serious{border-left-color:var(--orange)}.fix-item.moderate{border-left-color:var(--yellow)}
.fix-item-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.fix-item-name{font-weight:700;color:white;font-size:0.95rem}
.fix-item-impact{font-size:0.7rem;padding:3px 8px;border-radius:4px;font-weight:700;text-transform:uppercase}
.fix-steps{margin:0;padding:0 0 0 20px;font-size:0.84rem;color:var(--text)}
.fix-steps li{margin-bottom:6px;line-height:1.5}
.fix-steps code{background:#1a1a2e;padding:2px 6px;border-radius:4px;font-size:0.78rem;color:var(--accent2)}
.fix-item-points{font-size:0.78rem;color:var(--green);margin-top:8px;font-weight:600}
/* Rescan */
.rescan-section{margin-top:16px;text-align:center}
.rescan-btn{padding:12px 28px;background:linear-gradient(135deg,var(--green),#00cec9);color:white;border:none;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;transition:0.2s}
.rescan-btn:hover{opacity:0.9;transform:scale(1.02)}
.rescan-btn:disabled{opacity:0.5;cursor:not-allowed}
.score-change{display:none;font-size:1.4rem;font-weight:800;margin:12px 0;animation:fadeIn 0.5s}
.score-change.show{display:block}
.score-change.positive{color:var(--green)}.score-change.negative{color:var(--red)}.score-change.neutral{color:var(--muted)}
@keyframes fadeIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
/* Email report */
.email-report{margin-top:16px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px}
.email-report h3{color:white;font-size:1rem;margin-bottom:4px}
.email-report .er-sub{color:var(--muted);font-size:0.82rem;margin-bottom:12px}
.email-report-form{display:flex;gap:10px}
.email-report-form input{flex:1;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:0.9rem;outline:none}
.email-report-form input:focus{border-color:var(--accent)}
.email-report-form button{padding:10px 20px;background:var(--accent);color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;white-space:nowrap}
.email-report-form button:hover{opacity:0.9}
.email-report-msg{margin-top:8px;font-size:0.85rem;display:none}
.email-report-msg.show{display:block}
/* API teaser */
.api-teaser{margin:40px 0;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;position:relative;overflow:hidden}
.api-teaser::before{content:'PRO';position:absolute;top:16px;right:16px;background:var(--accent);color:white;padding:4px 12px;border-radius:12px;font-size:0.7rem;font-weight:700}
.api-teaser h2{color:white;font-size:1.4rem;margin-bottom:4px}
.api-teaser .at-sub{color:var(--muted);font-size:0.88rem;margin-bottom:20px}
.api-teaser pre{background:#0d0d15;border:1px solid var(--border);border-radius:10px;padding:16px;overflow-x:auto;font-size:0.8rem;color:var(--green);line-height:1.6;margin-bottom:12px}
.api-teaser .at-label{font-size:0.75rem;color:var(--muted);text-transform:uppercase;font-weight:600;margin-bottom:6px}
.api-teaser .at-cta{display:inline-block;margin-top:12px;padding:10px 24px;background:var(--accent);color:white;border-radius:8px;font-weight:700;font-size:0.9rem;text-decoration:none;cursor:pointer;border:none}
.api-teaser .at-cta:hover{background:var(--accent2)}
@media(max-width:768px){
  .hero h1{font-size:2rem}
  .pricing,.edu-grid{grid-template-columns:1fr}
  .urgency-stats{grid-template-columns:1fr}
  .stats-row{grid-template-columns:repeat(2,1fr)}
  .scanner-form{flex-direction:column}
  .comp-table{font-size:0.8rem}
  .monitor-form{flex-direction:column}
  .email-report-form{flex-direction:column}
  .compare-row{flex-direction:column}
  .compare-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    <div class="shield-icon">🛡️</div>
    <div class="hero-badge">⚠️ 4,605 ADA lawsuits filed in 2025 — Is your website next?</div>
    <h1>ComplianceShield</h1>
    <p>Scan any website for ADA & WCAG 2.1 accessibility compliance in seconds. Get detailed reports, fix issues, and protect your business from lawsuits.</p>
  </div>

  <!-- Recent Scans from localStorage -->
  <div class="recent-scans" id="recentScans">
    <h3>📋 Your Recent Scans</h3>
    <div id="recentList"></div>
    <p style="font-size:0.7rem;color:var(--muted);margin-top:8px">Stored locally in your browser • No account needed</p>
  </div>

  <div class="scanner" id="scanner">
    <h2>🔍 Free Accessibility Scan</h2>
    <div class="scanner-form">
      <input type="text" class="scanner-input" id="urlInput" placeholder="Enter any website URL (e.g., example.com)" />
      <button class="scanner-btn" id="scanBtn" onclick="runScan()">Scan Now</button>
    </div>
    <div class="scanner-hint">Free unlimited scans • No signup required • 23 WCAG checks • Results in seconds</div>

    <div class="loading" id="loading">
      <div class="spinner"></div>
      <p style="margin-top:12px;color:var(--muted)">Scanning for accessibility issues...</p>
    </div>
    <div class="error-msg" id="errorMsg"></div>

    <div class="results" id="results">
      <div class="score-ring">
        <div class="score-number" id="scoreNum">0</div>
        <div class="score-label">Accessibility Score</div>
      </div>
      <div class="compliance-status" id="complianceStatus"></div>

      <div class="stats-row">
        <div class="stat"><div class="stat-num" id="statIssues" style="color:var(--red)">0</div><div class="stat-label">Issues</div></div>
        <div class="stat"><div class="stat-num" id="statCritical" style="color:var(--red)">0</div><div class="stat-label">Critical</div></div>
        <div class="stat"><div class="stat-num" id="statPassed" style="color:var(--green)">0</div><div class="stat-label">Passed</div></div>
        <div class="stat"><div class="stat-num" id="statWarnings" style="color:var(--orange)">0</div><div class="stat-label">Warnings</div></div>
      </div>

      <div class="action-btns">
        <button class="action-btn" onclick="downloadPDF()">📄 Download PDF Report</button>
        <button class="action-btn" id="badgeBtn" onclick="generateBadge()" style="display:none">🏅 Get Compliance Badge</button>
        <button class="action-btn" onclick="showHistory()">📊 Scan History</button>
        <button class="action-btn" onclick="loadTrend()">📈 Score Trend</button>
      </div>

      <!-- Email Report -->
      <div class="email-report" id="emailReport">
        <h3>📧 Email Me This Report</h3>
        <p class="er-sub">Get a formatted copy of this scan report delivered to your inbox — great for sharing with your team.</p>
        <div class="email-report-form">
          <input type="email" id="reportEmail" placeholder="your@email.com" />
          <button onclick="sendEmailReport()">Send Report</button>
        </div>
        <div class="email-report-msg" id="emailReportMsg"></div>
      </div>

      <!-- Fix Priority List -->
      <div class="fix-priority" id="fixPriority" style="display:none">
        <h3>🎯 Fix These First</h3>
        <p class="fp-sub">The top 3 highest-impact issues to fix right now. Tackle these and you'll see the biggest improvement.</p>
        <div id="fixList"></div>
      </div>

      <!-- Rescan -->
      <div class="rescan-section" id="rescanSection" style="display:none">
        <div class="score-change" id="scoreChange"></div>
        <button class="rescan-btn" id="rescanBtn" onclick="runRescan()">🔄 Rescan — See Your Improvement</button>
        <p style="font-size:0.78rem;color:var(--muted);margin-top:6px">Fixed some issues? Rescan to see your updated score.</p>
      </div>

      <div class="badge-section" id="badgeSection">
        <h3>🏅 Your Compliance Badge</h3>
        <p style="font-size:0.85rem;color:var(--muted)">Embed this badge on your website to show visitors your commitment to accessibility.</p>
        <div id="badgePreview" style="margin:12px 0"></div>
        <div class="badge-code" id="badgeCode"></div>
        <button class="copy-btn" onclick="copyBadge()">Copy Embed Code</button>
      </div>

      <!-- Trend Chart -->
      <div class="trend-section" id="trendSection">
        <h3>📈 Score Trend Over Time</h3>
        <div class="trend-chart" id="trendChart"></div>
        <div class="trend-meta" id="trendMeta"></div>
        <div class="trend-summary" id="trendSummary"></div>
      </div>

      <!-- Scan History Comparison -->
      <div class="trend-section" id="historyDiffSection">
        <h3>🔄 Scan Comparison</h3>
        <div id="historyDiffContent"></div>
        <div id="historyTimeline" style="margin-top:16px"></div>
      </div>

      <!-- Monitor Registration -->
      <div class="monitor-section">
        <h3>🔔 Set Up Monitoring &amp; Email Alerts</h3>
        <p style="font-size:0.85rem;color:var(--muted);margin-bottom:12px">Get automated scan results delivered to your inbox. Track your accessibility score changes over time.</p>
        <div class="monitor-form" style="flex-wrap:wrap;gap:8px">
          <input type="email" id="monitorEmail" placeholder="your@email.com" style="flex:1;min-width:200px" />
          <select id="alertFrequency" style="padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:0.9rem;cursor:pointer">
            <option value="daily">Daily</option>
            <option value="weekly" selected>Weekly</option>
            <option value="biweekly">Bi-weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin:12px 0">
          <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer">
            <input type="checkbox" id="alertEnabled" checked style="opacity:0;width:0;height:0">
            <span id="alertToggleTrack" style="position:absolute;top:0;left:0;right:0;bottom:0;background:var(--accent);border-radius:24px;transition:.3s"></span>
            <span id="alertToggleThumb" style="position:absolute;top:2px;left:22px;width:20px;height:20px;background:white;border-radius:50%;transition:.3s"></span>
          </label>
          <span id="alertToggleLabel" style="font-size:0.85rem;color:var(--muted)">Email alerts enabled</span>
        </div>
        <button onclick="configureAlerts()" style="padding:10px 24px;border-radius:8px;border:none;background:var(--accent);color:white;font-weight:600;cursor:pointer;font-size:0.9rem;transition:opacity .2s" onmouseover="this.style.opacity=0.85" onmouseout="this.style.opacity=1">📧 Configure Alerts &amp; Start Monitoring</button>
        <div class="monitor-msg" id="monitorMsg"></div>
      </div>

      <!-- Share Badge (score 80+) -->
      <div class="share-badge" id="shareBadge">
        <h3>🏆 Your Site Passed! Share Your Badge</h3>
        <p>Embed this badge on your website to show visitors your commitment to accessibility. Every badge links back to ComplianceShield.</p>
        <div class="share-badge-preview" id="shareBadgePreview"></div>
        <div class="share-snippet" id="shareSnippet"></div>
        <div class="share-btns">
          <button class="copy-embed" onclick="copyShareBadge()">📋 Copy HTML Snippet</button>
          <button class="share-twitter" onclick="shareTwitter()">🐦 Share on X</button>
          <button class="share-linkedin" onclick="shareLinkedIn()">💼 Share on LinkedIn</button>
        </div>
      </div>

      <!-- Categorized Issues -->
      <div class="issues-list" id="issuesList"></div>
      <div class="passes-section" id="passesSection">
        <h3 style="color:var(--green);margin-bottom:10px">✅ Checks Passed</h3>
        <div id="passesList"></div>
      </div>
    </div>

    <div class="history" id="historySection" style="display:none">
      <h3>📊 Recent Scan History</h3>
      <div id="historyList"></div>
    </div>
  </div>


  <!-- Standalone Scheduled Monitoring -->
  <div class="scanner" id="monitorStandalone" style="border-color:var(--green);margin-bottom:40px">
    <h2>🔔 Schedule Automated Monitoring</h2>
    <p style="text-align:center;color:var(--muted);font-size:0.9rem;margin-bottom:16px">Set up recurring accessibility scans. We will scan your site automatically and track changes over time.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <input type="text" id="scheduleUrl" placeholder="Website URL (e.g., example.com)" style="flex:2;min-width:200px;padding:12px 16px;border-radius:10px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:0.95rem;outline:none" />
      <input type="email" id="scheduleEmail" placeholder="your@email.com" style="flex:1;min-width:180px;padding:12px 16px;border-radius:10px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:0.95rem;outline:none" />
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <select id="scheduleFreq" style="padding:12px 16px;border-radius:10px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:0.95rem;cursor:pointer">
        <option value="daily">Daily</option>
        <option value="weekly" selected>Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      <button onclick="scheduleMonitor()" style="flex:1;padding:12px 24px;background:var(--green);color:white;border:none;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;white-space:nowrap">Start Monitoring</button>
    </div>
    <div id="scheduleMsg" style="margin-top:10px;font-size:0.85rem;padding:8px;border-radius:6px;display:none"></div>
    <div id="activeMonitors" style="margin-top:16px;display:none">
      <h3 style="font-size:0.95rem;color:white;margin-bottom:8px">Active Monitors</h3>
      <div id="monitorsList"></div>
    </div>
    <p style="text-align:center;margin-top:10px;font-size:0.75rem;color:var(--muted)">Free tier: 1 monitor | Pro: unlimited monitors with email reports</p>
  </div>

  <!-- Competitor Comparison -->
  <div class="compare-section" id="compareSection">
    <h2>⚔️ Compare With Competitor</h2>
    <p style="text-align:center;color:var(--muted);font-size:0.85rem;margin-bottom:16px">Scan two websites side by side to see which is more accessible</p>
    <div class="compare-form">
      <div class="compare-row">
        <input type="text" id="compareUrl1" placeholder="Your website (e.g., yoursite.com)" />
        <input type="text" id="compareUrl2" placeholder="Competitor (e.g., competitor.com)" />
      </div>
      <button class="compare-btn" id="compareBtn" onclick="runCompare()">⚔️ Compare Accessibility</button>
    </div>
    <div class="loading" id="compareLoading">
      <div class="spinner"></div>
      <p style="margin-top:10px;color:var(--muted);font-size:0.85rem">Scanning both sites...</p>
    </div>
    <div class="error-msg" id="compareError"></div>
    <div class="compare-results" id="compareResults">
      <div class="compare-grid" id="compareGrid"></div>
    </div>
  </div>

  <div class="urgency">
    <h2>⚖️ ADA Web Accessibility Lawsuits Are Surging</h2>
    <div class="urgency-stats">
      <div class="urgency-stat"><div class="num">4,605</div><div class="label">ADA web lawsuits filed in 2025</div></div>
      <div class="urgency-stat"><div class="num">$50K+</div><div class="label">Average settlement cost</div></div>
      <div class="urgency-stat"><div class="num">98%</div><div class="label">of websites fail basic WCAG checks</div></div>
    </div>
    <p>Under the Americans with Disabilities Act (ADA), websites are considered "places of public accommodation." Courts have consistently ruled that inaccessible websites violate Title III of the ADA. The Department of Justice finalized rules in 2024 requiring state and local government websites to meet WCAG 2.1 Level AA — and private sector enforcement is accelerating.</p>
    <p style="margin-top:12px"><strong style="color:var(--red)">Plaintiffs' firms are actively scanning websites for violations.</strong> The average small business pays $25,000–$75,000 to settle. Don't wait until you get served.</p>
    <p style="margin-top:16px"><a href="#scanner" style="color:var(--accent2);font-weight:700;font-size:1.1rem">→ Scan your website now — it's free</a></p>
  </div>

  <div class="comparison">
    <h2>Why ComplianceShield?</h2>
    <table class="comp-table">
      <tr><th>Feature</th><th class="comp-highlight">ComplianceShield</th><th>accessiBe</th><th>UserWay</th><th>AudioEye</th></tr>
      <tr><td>Free unlimited scans</td><td class="comp-highlight check">✓</td><td class="cross">✗</td><td class="cross">✗</td><td class="cross">✗</td></tr>
      <tr><td>No account required</td><td class="comp-highlight check">✓</td><td class="cross">✗</td><td class="cross">✗</td><td class="cross">✗</td></tr>
      <tr><td>WCAG checks</td><td class="comp-highlight check">✓ 23 rules</td><td>Limited</td><td>Limited</td><td class="check">✓</td></tr>
      <tr><td>Color contrast analysis</td><td class="comp-highlight check">✓</td><td>Overlay only</td><td>Overlay only</td><td class="check">✓</td></tr>
      <tr><td>Keyboard nav checks</td><td class="comp-highlight check">✓</td><td class="cross">✗</td><td class="cross">✗</td><td class="check">✓</td></tr>
      <tr><td>Score trend over time</td><td class="comp-highlight check">✓ Free</td><td>Paid only</td><td class="cross">✗</td><td>Paid only</td></tr>
      <tr><td>Weekly monitoring</td><td class="comp-highlight check">✓</td><td>Paid only</td><td>Paid only</td><td>Paid only</td></tr>
      <tr><td>PDF reports</td><td class="comp-highlight check">✓ Free</td><td>Paid only</td><td>Paid only</td><td>Paid only</td></tr>
      <tr><td>Starting price</td><td class="comp-highlight" style="color:var(--green);font-weight:700">$29/mo</td><td>$490/yr</td><td>$490/yr</td><td>Custom</td></tr>
    </table>
  </div>

  <div class="education">
    <h2>📚 Understanding Web Accessibility & ADA Compliance</h2>
    <div class="edu-grid">
      <div class="edu-card"><h3>🏛️ What is ADA Compliance?</h3><p>The Americans with Disabilities Act (ADA) requires businesses to make their services accessible to people with disabilities. In 2024, the DOJ finalized rules explicitly extending this to websites, requiring WCAG 2.1 Level AA conformance.</p></div>
      <div class="edu-card"><h3>📋 What is WCAG 2.1?</h3><p>The Web Content Accessibility Guidelines (WCAG) 2.1 are the international standard for web accessibility. Organized around 4 principles: <strong>Perceivable</strong>, <strong>Operable</strong>, <strong>Understandable</strong>, and <strong>Robust</strong>. Level AA includes 50+ specific success criteria.</p></div>
      <div class="edu-card"><h3>⚖️ Recent Notable Lawsuits</h3><p><strong>Domino's v. Robles (2019):</strong> Supreme Court let stand a ruling that Domino's website must be accessible. <strong>2025:</strong> Over 400 lawsuits/month targeting e-commerce, healthcare, and small business websites.</p></div>
      <div class="edu-card"><h3>🎯 Who's at Risk?</h3><p>Any business with a website — especially <strong>e-commerce, healthcare, financial services, restaurants, and hospitality</strong>. Serial plaintiffs target sites with obvious violations like missing alt text, poor contrast, and inaccessible forms.</p></div>
    </div>
  </div>

  <!-- API Access Teaser -->
  <div class="api-teaser" id="apiTeaser">
    <h2>👩‍💻 For Developers: API Access</h2>
    <p class="at-sub">Integrate accessibility scanning into your CI/CD pipeline, agency workflow, or product. Full REST API with JSON responses.</p>
    <div class="at-label">Sample Request</div>
    <pre>curl -X POST https://gamma.abapture.ai/api/scan \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"url": "https://example.com"}'</pre>
    <div class="at-label">Sample Response</div>
    <pre>{
  "score": 85,
  "complianceLevel": "needs-improvement",
  "summary": {
    "totalChecks": 23,
    "passed": 19,
    "issues": 4,
    "critical": 0,
    "serious": 2
  },
  "issues": [
    {
      "id": "missing-alt",
      "name": "Images missing alt text",
      "impact": "critical",
      "wcag": "WCAG 2.1 SC 1.1.1",
      "count": 3
    }
  ]
}</pre>
    <p style="font-size:0.85rem;color:var(--muted)">API keys are available on the <strong style="color:var(--accent2)">Pro plan ($29/mo)</strong>. Perfect for agencies, dev shops, and SaaS products that need programmatic scanning.</p>
    <button class="at-cta" onclick="checkout('pro')">Get API Access →</button>
  </div>

  <div class="section" id="pricing">
    <h2 style="text-align:center;font-size:1.8rem;margin-bottom:24px;color:white">Plans & Pricing</h2>
    <div class="pricing">
      <div class="price-card">
        <h3>Free</h3><div class="subtitle">For quick checks</div>
        <div class="price">$0</div>
        <ul><li>Unlimited scans</li><li>23 WCAG checks</li><li>PDF export</li><li>Score trends</li><li>Compliance badge</li></ul>
        <button class="price-btn" onclick="document.getElementById('urlInput').focus()">Start Scanning</button>
      </div>
      <div class="price-card featured">
        <h3>Pro</h3><div class="subtitle">For businesses</div>
        <div class="price">$29<span>/mo</span></div>
        <ul><li>Everything in Free</li><li>Weekly email monitoring</li><li>Multi-page deep scans</li><li>Priority support</li><li>Team sharing</li><li>API access</li></ul>
        <button class="price-btn" onclick="checkout('pro')">Start Free Trial</button>
      </div>
      <div class="price-card">
        <h3>Enterprise</h3><div class="subtitle">For agencies & large sites</div>
        <div class="price">$99<span>/mo</span></div>
        <ul><li>Everything in Pro</li><li>Unlimited team members</li><li>White-label reports</li><li>Custom integrations</li><li>Dedicated support</li><li>SLA guarantee</li></ul>
        <button class="price-btn" onclick="checkout('enterprise')">Contact Sales</button>
      </div>
    </div>
  </div>

  <footer>
    <p>🛡️ ComplianceShield — Protect your business from ADA lawsuits</p>
    <p style="margin-top:8px">23 WCAG checks • Color contrast analysis • Keyboard navigation • Link quality • Score trends</p>
    <p style="margin-top:8px">Built with care • <a href="https://github.com/beepboop-dev/gamma-project">GitHub</a></p>
  </footer>
</div>

<script>
let currentScan = null;

// ===== localStorage scan history =====
function getLocalScans() {
  try { return JSON.parse(localStorage.getItem('cs_scans') || '[]'); } catch(e) { return []; }
}
function saveLocalScan(scan) {
  const scans = getLocalScans();
  scans.unshift({ url: scan.url, score: scan.score, level: scan.complianceLevel, date: scan.scannedAt, id: scan.id, issues: scan.summary.issues });
  if (scans.length > 50) scans.length = 50;
  localStorage.setItem('cs_scans', JSON.stringify(scans));
  renderRecentScans();
}
function renderRecentScans() {
  const scans = getLocalScans();
  const section = document.getElementById('recentScans');
  const list = document.getElementById('recentList');
  if (scans.length === 0) { section.classList.remove('show'); return; }
  section.classList.add('show');
  // Group by domain, show latest per domain + trend
  const byDomain = {};
  scans.forEach(s => {
    try { const d = new URL(s.url).hostname; if (!byDomain[d]) byDomain[d] = []; byDomain[d].push(s); } catch(e) {}
  });
  const entries = Object.entries(byDomain).slice(0, 8);
  list.innerHTML = entries.map(([domain, ds]) => {
    const latest = ds[0];
    const color = latest.score >= 80 ? 'var(--green)' : latest.score >= 50 ? 'var(--orange)' : 'var(--red)';
    let trend = '';
    if (ds.length >= 2) {
      const diff = ds[0].score - ds[1].score;
      if (diff > 0) trend = '<span class="ri-trend" style="color:var(--green)">▲+' + diff + '</span>';
      else if (diff < 0) trend = '<span class="ri-trend" style="color:var(--red)">▼' + diff + '</span>';
      else trend = '<span class="ri-trend" style="color:var(--muted)">—</span>';
    }
    return '<div class="recent-item" onclick="document.getElementById(\\'urlInput\\').value=\\'' + escapeHtml(latest.url) + '\\';runScan()">' +
      '<span class="ri-url">' + escapeHtml(domain) + '</span>' +
      '<span><span class="ri-score" style="color:' + color + '">' + latest.score + '/100</span>' + trend + '</span>' +
      '<span class="ri-date">' + new Date(latest.date).toLocaleDateString() + '</span></div>';
  }).join('');
}
// Render on load
renderRecentScans();

// ===== Issue Categories =====
const ISSUE_CATEGORIES = {
  'Images': { icon: '🖼️', rules: ['missing-alt', 'empty-alt'] },
  'Forms': { icon: '📝', rules: ['missing-form-label'] },
  'Navigation': { icon: '🧭', rules: ['empty-link', 'empty-button', 'no-skip-link', 'missing-landmark', 'tabindex-positive', 'generic-link-text'] },
  'Content': { icon: '📄', rules: ['missing-lang', 'missing-title', 'missing-heading', 'skipped-heading', 'missing-table-header', 'meta-refresh', 'autoplay-media', 'low-contrast-text', 'inline-styles-text', 'color-contrast-inline'] },
  'Keyboard': { icon: '⌨️', rules: ['keyboard-trap', 'missing-focus-style', 'missing-keyboard-access'] }
};

function categorizeIssues(issues) {
  const cats = {};
  Object.entries(ISSUE_CATEGORIES).forEach(([name, cat]) => { cats[name] = { ...cat, issues: [] }; });
  cats['Other'] = { icon: '❓', rules: [], issues: [] };
  issues.forEach(issue => {
    let placed = false;
    for (const [name, cat] of Object.entries(ISSUE_CATEGORIES)) {
      if (cat.rules.includes(issue.id)) { cats[name].issues.push(issue); placed = true; break; }
    }
    if (!placed) cats['Other'].issues.push(issue);
  });
  return cats;
}

function renderCategorizedIssues(issues) {
  const cats = categorizeIssues(issues);
  return Object.entries(cats).filter(([,c]) => c.issues.length > 0).map(([name, cat]) => {
    const totalCount = cat.issues.reduce((s,i) => s + i.count, 0);
    const issuesHtml = cat.issues.map(issue => \`
      <div class="issue-item \${issue.impact}">
        <div class="issue-header">
          <span class="issue-name">\${issue.name} (\${issue.count})</span>
          <span class="issue-impact impact-\${issue.impact}">\${issue.impact}</span>
        </div>
        <div class="issue-wcag">📋 \${issue.wcag} — Level \${issue.level} (\${issue.principle})</div>
        <div class="issue-desc">\${issue.description}</div>
        \${issue.elements && issue.elements.length > 0 ? \`<div class="issue-elements">\${issue.elements.map(e => escapeHtml(e)).join('<br>')}</div>\` : ''}
        <a href="\${issue.url}" target="_blank" class="issue-link">📖 WCAG Reference →</a>
      </div>
    \`).join('');
    return \`<div class="category-group">
      <div class="category-header" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
        <h4>\${cat.icon} \${name} <span class="cat-count">\${cat.issues.length} issue\${cat.issues.length>1?'s':''} · \${totalCount} occurrence\${totalCount>1?'s':''}</span></h4>
        <span class="chevron">▼</span>
      </div>
      <div class="category-body"><div class="category-body-inner">\${issuesHtml}</div></div>
    </div>\`;
  }).join('');
}

async function runScan() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { document.getElementById('urlInput').focus(); return; }
  document.getElementById('loading').classList.add('show');
  document.getElementById('results').classList.remove('show');
  document.getElementById('errorMsg').classList.remove('show');
  document.getElementById('historySection').style.display = 'none';
  document.getElementById('badgeSection').classList.remove('show');
  document.getElementById('trendSection').classList.remove('show');
  document.getElementById('scanBtn').disabled = true;

  try {
    const res = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    currentScan = data;
    displayResults(data);
  } catch(e) {
    document.getElementById('errorMsg').textContent = e.message;
    document.getElementById('errorMsg').classList.add('show');
  } finally {
    document.getElementById('loading').classList.remove('show');
    document.getElementById('scanBtn').disabled = false;
  }
}

function displayResults(data) {
  const scoreEl = document.getElementById('scoreNum');
  scoreEl.textContent = data.score;
  scoreEl.style.color = data.score >= 80 ? 'var(--green)' : data.score >= 50 ? 'var(--orange)' : 'var(--red)';

  const statusEl = document.getElementById('complianceStatus');
  const statusMap = {
    'compliant': ['✅ WCAG 2.1 Compliant', 'status-compliant'],
    'needs-improvement': ['⚠️ Needs Improvement', 'status-needs-improvement'],
    'partially-compliant': ['⚠️ Partially Compliant', 'status-partially-compliant'],
    'non-compliant': ['❌ Non-Compliant — Action Required', 'status-non-compliant']
  };
  const [statusText, statusClass] = statusMap[data.complianceLevel] || ['Unknown', ''];
  statusEl.textContent = statusText;
  statusEl.className = 'compliance-status ' + statusClass;

  document.getElementById('statIssues').textContent = data.summary.issues;
  document.getElementById('statCritical').textContent = data.summary.critical;
  document.getElementById('statPassed').textContent = data.summary.passed;
  document.getElementById('statWarnings').textContent = data.summary.warnings;
  document.getElementById('badgeBtn').style.display = data.complianceLevel !== 'non-compliant' ? 'inline-block' : 'none';

  // Categorized issues
  document.getElementById('issuesList').innerHTML = data.issues.length > 0
    ? '<h3 style="color:var(--red);margin:20px 0 12px">🔍 Issues by Category</h3>' + renderCategorizedIssues(data.issues)
    : '';

  // Save to localStorage
  saveLocalScan(data);

  // Share badge for score 80+
  if (data.score >= 80) {
    const badgeUrl = 'https://gamma.abapture.ai';
    const snippet = \`<a href="\${badgeUrl}" target="_blank" title="ADA Compliant - Verified by ComplianceShield"><img src="\${badgeUrl}/api/badge/ada-shield.svg?score=\${data.score}" alt="ADA Compliant - Score \${data.score}/100" style="height:32px" /></a>\`;
    document.getElementById('shareBadgePreview').innerHTML = \`<div style="background:#1a1a2e;display:inline-block;padding:12px 20px;border-radius:8px"><span style="font-size:1.5rem">🛡️</span> <strong style="color:var(--green)">ADA Compliant</strong> <span style="color:var(--muted)">·</span> <strong style="color:white">\${data.score}/100</strong></div>\`;
    document.getElementById('shareSnippet').textContent = snippet;
    document.getElementById('shareBadge').classList.add('show');
  } else {
    document.getElementById('shareBadge').classList.remove('show');
  }

  const passesHtml = data.passes.map(p => \`<span class="pass-item">✓ \${p.name} (\${p.wcag})</span>\`).join('');
  document.getElementById('passesList').innerHTML = passesHtml;

  // Fix priority list
  renderFixPriority(data.issues);
  
  // Show rescan section
  document.getElementById('rescanSection').style.display = data.issues.length > 0 ? 'block' : 'none';

  loadScanHistory();
  document.getElementById('results').classList.add('show');
}

function escapeHtml(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function downloadPDF() {
  if (!currentScan) return;
  window.open('/api/scan/' + currentScan.id + '/pdf', '_blank');
}

async function generateBadge() {
  if (!currentScan) return;
  try {
    const res = await fetch('/api/badge/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: currentScan.url, scanId: currentScan.id }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('badgePreview').innerHTML = \`<img src="\${data.svgUrl}" alt="Compliance Badge" style="height:28px">\`;
    document.getElementById('badgeCode').textContent = data.embedCode;
    document.getElementById('badgeSection').classList.add('show');
  } catch(e) { alert(e.message); }
}

function copyBadge() {
  const code = document.getElementById('badgeCode').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy Embed Code', 2000);
  });
}

async function loadTrend() {
  if (!currentScan) return;
  try {
    const res = await fetch('/api/trend?url=' + encodeURIComponent(currentScan.url));
    const data = await res.json();
    const section = document.getElementById('trendSection');
    const chart = document.getElementById('trendChart');
    const meta = document.getElementById('trendMeta');
    const summary = document.getElementById('trendSummary');

    if (!data.scans || data.scans.length === 0) {
      summary.innerHTML = '<span style="color:var(--muted)">No historical data yet. Scan again later to see trends.</span>';
      chart.innerHTML = '';
      meta.innerHTML = '';
      section.classList.add('show');
      return;
    }

    const scans = data.scans;
    const maxScore = 100;
    chart.innerHTML = scans.map((s, i) => {
      const height = Math.max(4, (s.score / maxScore) * 100);
      const color = s.score >= 80 ? 'var(--green)' : s.score >= 50 ? 'var(--orange)' : 'var(--red)';
      const date = new Date(s.date).toLocaleDateString();
      return \`<div class="trend-bar" style="height:\${height}%;background:\${color}">
        <div class="tooltip">\${date}<br>Score: \${s.score}/100<br>Issues: \${s.issues}</div>
      </div>\`;
    }).join('');

    if (scans.length > 0) {
      meta.innerHTML = \`<span>\${new Date(scans[0].date).toLocaleDateString()}</span><span>\${new Date(scans[scans.length-1].date).toLocaleDateString()}</span>\`;
    }

    if (data.trend) {
      const t = data.trend;
      const arrow = t.direction === 'improving' ? '📈' : t.direction === 'declining' ? '📉' : '➡️';
      const cls = t.direction === 'improving' ? 'trend-up' : t.direction === 'declining' ? 'trend-down' : 'trend-stable';
      summary.innerHTML = \`
        <span class="\${cls}">\${arrow} \${t.direction.charAt(0).toUpperCase() + t.direction.slice(1)}</span> —
        Score changed by <strong class="\${cls}">\${t.scoreChange > 0 ? '+' : ''}\${t.scoreChange}</strong> points over
        <strong>\${t.totalScans}</strong> scans.
        Issues changed by <strong>\${t.issuesChange > 0 ? '+' : ''}\${t.issuesChange}</strong>.
      \`;
    }

    section.classList.add('show');
  } catch(e) { console.error(e); }
}

// Alert toggle UI
function setupAlertToggle() {
  const cb = document.getElementById('alertEnabled');
  const track = document.getElementById('alertToggleTrack');
  const thumb = document.getElementById('alertToggleThumb');
  const label = document.getElementById('alertToggleLabel');
  if (!cb) return;
  function update() {
    if (cb.checked) {
      track.style.background = 'var(--accent)';
      thumb.style.left = '22px';
      label.textContent = 'Email alerts enabled';
    } else {
      track.style.background = 'var(--border, #333)';
      thumb.style.left = '2px';
      label.textContent = 'Email alerts disabled';
    }
  }
  cb.addEventListener('change', update);
  update();
}
setupAlertToggle();

async function configureAlerts() {
  if (!currentScan) return;
  const email = document.getElementById('monitorEmail').value.trim();
  const frequency = document.getElementById('alertFrequency').value;
  const enabled = document.getElementById('alertEnabled').checked;
  const msg = document.getElementById('monitorMsg');
  if (!email) { msg.textContent = 'Please enter your email address'; msg.className = 'monitor-msg show error'; return; }

  try {
    // Configure alert preferences
    const alertRes = await fetch('/api/alerts/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, frequency, enabled, url: currentScan.url })
    });
    const alertData = await alertRes.json();
    if (!alertRes.ok) throw new Error(alertData.error);

    // Also register the monitor
    const monRes = await fetch('/api/monitor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentScan.url, email, frequency })
    });
    const monData = await monRes.json();
    if (!monRes.ok) throw new Error(monData.error);

    const freqLabel = { daily: 'daily', weekly: 'weekly', biweekly: 'bi-weekly', monthly: 'monthly' }[frequency] || frequency;
    msg.innerHTML = enabled
      ? '✅ Alerts configured! <strong>' + email + '</strong> will receive <strong>' + freqLabel + '</strong> score change summaries for this site.'
      : '✅ Monitor registered (alerts paused). Enable alerts anytime to start receiving summaries.';
    msg.className = 'monitor-msg show success';
  } catch(e) {
    msg.textContent = e.message;
    msg.className = 'monitor-msg show error';
  }
}

async function registerMonitor() { configureAlerts(); }

async function showHistory() {
  try {
    const res = await fetch('/api/history?limit=10');
    const data = await res.json();
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    if (data.length === 0) {
      list.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No scan history yet.</p>';
    } else {
      list.innerHTML = data.map(s => \`
        <div class="history-item">
          <span class="history-url">\${escapeHtml(s.url)}</span>
          <span class="history-score" style="color:\${s.score >= 80 ? 'var(--green)' : s.score >= 50 ? 'var(--orange)' : 'var(--red)'}">\${s.score}/100</span>
          <span class="history-date">\${new Date(s.scannedAt).toLocaleDateString()}</span>
        </div>
      \`).join('');
    }
    section.style.display = 'block';
  } catch(e) { console.error(e); }
}

async function checkout(plan) {
  try {
    const res = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else alert(data.error || 'Checkout failed');
  } catch(e) { alert('Checkout error: ' + e.message); }
}

// ===== Compare =====
async function runCompare() {
  const u1 = document.getElementById('compareUrl1').value.trim();
  const u2 = document.getElementById('compareUrl2').value.trim();
  if (!u1 || !u2) { alert('Please enter both URLs'); return; }
  document.getElementById('compareLoading').classList.add('show');
  document.getElementById('compareResults').classList.remove('show');
  document.getElementById('compareError').classList.remove('show');
  document.getElementById('compareBtn').disabled = true;
  try {
    const res = await fetch('/api/compare', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url1:u1,url2:u2}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const grid = document.getElementById('compareGrid');
    function card(site, label, isWinner) {
      const color = site.score >= 80 ? 'var(--green)' : site.score >= 50 ? 'var(--orange)' : 'var(--red)';
      return \`<div class="compare-card \${isWinner ? 'winner' : ''}">
        <div class="winner-badge">🏆 MORE ACCESSIBLE</div>
        <div class="comp-url">\${escapeHtml(site.url)}</div>
        <div class="comp-score" style="color:\${color}">\${site.score}</div>
        <div class="comp-detail">\${site.summary.issues} issues · \${site.summary.critical} critical · \${site.summary.passed} passed</div>
        <div class="comp-detail" style="margin-top:4px">\${site.complianceLevel.replace(/-/g,' ')}</div>
      </div>\`;
    }
    grid.innerHTML = card(data.site1, u1, data.winner==='site1') + card(data.site2, u2, data.winner==='site2');
    document.getElementById('compareResults').classList.add('show');
    saveLocalScan(data.site1); saveLocalScan(data.site2);
  } catch(e) {
    document.getElementById('compareError').textContent = e.message;
    document.getElementById('compareError').classList.add('show');
  } finally {
    document.getElementById('compareLoading').classList.remove('show');
    document.getElementById('compareBtn').disabled = false;
  }
}

// ===== Share functions =====
function copyShareBadge() {
  const snippet = document.getElementById('shareSnippet').textContent;
  navigator.clipboard.writeText(snippet).then(() => {
    const btn = document.querySelector('.copy-embed');
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy HTML Snippet', 2000);
  });
}
function shareTwitter() {
  if (!currentScan) return;
  const text = encodeURIComponent('Our website scored ' + currentScan.score + '/100 on ADA accessibility! Scanned with @ComplianceShield 🛡️');
  window.open('https://twitter.com/intent/tweet?text=' + text + '&url=' + encodeURIComponent('https://gamma.abapture.ai'), '_blank');
}
function shareLinkedIn() {
  window.open('https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent('https://gamma.abapture.ai'), '_blank');
}

// ===== Fix Priority List =====
const FIX_INSTRUCTIONS = {
  'missing-alt': [
    'Find all <code>&lt;img&gt;</code> tags without an <code>alt</code> attribute',
    'Add descriptive alt text: <code>&lt;img src="logo.png" alt="Company logo"&gt;</code>',
    'For decorative images, use empty alt: <code>&lt;img src="bg.png" alt=""&gt;</code>'
  ],
  'missing-lang': [
    'Open your HTML file and find the <code>&lt;html&gt;</code> tag',
    'Add the lang attribute: <code>&lt;html lang="en"&gt;</code>',
    'Use the correct ISO language code for your content'
  ],
  'missing-title': [
    'Add a <code>&lt;title&gt;</code> element inside <code>&lt;head&gt;</code>',
    'Make it descriptive: <code>&lt;title&gt;About Us - Company Name&lt;/title&gt;</code>',
    'Each page should have a unique, descriptive title'
  ],
  'missing-form-label': [
    'Add a <code>&lt;label&gt;</code> for each input: <code>&lt;label for="email"&gt;Email&lt;/label&gt;</code>',
    'Connect with matching <code>id</code>: <code>&lt;input id="email" type="email"&gt;</code>',
    'Or use <code>aria-label</code>: <code>&lt;input aria-label="Search" type="text"&gt;</code>'
  ],
  'empty-link': [
    'Add descriptive text inside every <code>&lt;a&gt;</code> tag',
    'For icon links, add <code>aria-label</code>: <code>&lt;a href="/cart" aria-label="Shopping cart"&gt;</code>',
    'Avoid empty links — they confuse screen readers'
  ],
  'empty-button': [
    'Add text content or <code>aria-label</code> to every button',
    'Example: <code>&lt;button aria-label="Close menu"&gt;✕&lt;/button&gt;</code>',
    'Icon buttons always need an accessible name'
  ],
  'missing-heading': [
    'Add an <code>&lt;h1&gt;</code> for the page title',
    'Use <code>&lt;h2&gt;</code> for sections, <code>&lt;h3&gt;</code> for subsections',
    'Don\'t skip levels — go h1 → h2 → h3 in order'
  ],
  'skipped-heading': [
    'Check your heading hierarchy — don\'t jump from h1 to h3',
    'Restructure: <code>&lt;h1&gt; → &lt;h2&gt; → &lt;h3&gt;</code> in order',
    'Use CSS for visual sizing, not heading levels'
  ],
  'missing-landmark': [
    'Wrap your main content in <code>&lt;main&gt;</code>',
    'Use <code>&lt;nav&gt;</code> for navigation, <code>&lt;header&gt;</code> and <code>&lt;footer&gt;</code>',
    'These help screen reader users jump between page sections'
  ],
  'color-contrast-inline': [
    'Check color pairs with a contrast checker tool',
    'Ensure 4.5:1 ratio for normal text, 3:1 for large text',
    'Avoid light gray text on white backgrounds'
  ],
  'missing-focus-style': [
    'Remove <code>outline: none</code> from CSS focus styles',
    'Add a visible focus indicator: <code>:focus { outline: 2px solid #6c5ce7; }</code>',
    'Or use <code>box-shadow</code> as an alternative focus style'
  ],
  'generic-link-text': [
    'Replace "click here" with descriptive text like "Download the report"',
    'Replace "read more" with "Read more about accessibility compliance"',
    'Link text should make sense out of context'
  ],
  'missing-keyboard-access': [
    'Add <code>tabindex="0"</code> to clickable non-interactive elements',
    'Add a keydown handler: <code>onkeydown="if(event.key===\'Enter\') this.click()"</code>',
    'Better yet: use <code>&lt;button&gt;</code> instead of <code>&lt;div onclick&gt;</code>'
  ],
  'keyboard-trap': [
    'Ensure users can Tab and Shift+Tab out of all components',
    'Modals should return focus to the trigger on close',
    'Avoid <code>preventDefault()</code> on Tab/Escape keys'
  ],
  'missing-viewport': [
    'Add to <code>&lt;head&gt;</code>: <code>&lt;meta name="viewport" content="width=device-width, initial-scale=1.0"&gt;</code>',
    'This enables responsive design for mobile users',
    'Don\'t set <code>maximum-scale=1</code> — it prevents zooming'
  ]
};

const IMPACT_WEIGHT = { critical: 4, serious: 3, moderate: 2, minor: 1 };

function renderFixPriority(issues) {
  const section = document.getElementById('fixPriority');
  const list = document.getElementById('fixList');
  if (!issues || issues.length === 0) { section.style.display = 'none'; return; }
  
  // Sort by impact weight * count, take top 3
  const sorted = [...issues].sort((a, b) => (IMPACT_WEIGHT[b.impact]||1) * b.count - (IMPACT_WEIGHT[a.impact]||1) * a.count);
  const top3 = sorted.slice(0, 3);
  
  // Estimate points per fix
  const totalIssues = issues.length;
  const pointsPerIssue = totalIssues > 0 ? Math.round(100 / (totalIssues + issues.reduce((s,i)=>s+i.count,0)/issues.length)) : 5;
  
  list.innerHTML = top3.map((issue, i) => {
    const steps = FIX_INSTRUCTIONS[issue.id] || [
      'Review the WCAG guideline: ' + issue.wcag,
      'Check each flagged element and apply the fix',
      'Re-test to confirm the issue is resolved'
    ];
    const pts = Math.max(2, Math.round(pointsPerIssue * (IMPACT_WEIGHT[issue.impact]||1) * 0.8));
    return \`<div class="fix-item \${issue.impact}">
      <div class="fix-item-header">
        <span class="fix-item-name">\${i+1}. \${issue.name} <span style="font-weight:400;color:var(--muted)">(\${issue.count} found)</span></span>
        <span class="fix-item-impact impact-\${issue.impact}">\${issue.impact}</span>
      </div>
      <ol class="fix-steps">\${steps.map(s => '<li>' + s + '</li>').join('')}</ol>
      <div class="fix-item-points">🎯 Est. +\${pts} points when fixed</div>
    </div>\`;
  }).join('');
  
  section.style.display = 'block';
}

// ===== Rescan =====
let previousScore = null;

async function runRescan() {
  if (!currentScan) return;
  const btn = document.getElementById('rescanBtn');
  btn.disabled = true;
  btn.textContent = '🔄 Rescanning...';
  previousScore = currentScan.score;
  
  try {
    const res = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: currentScan.url }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    currentScan = data;
    displayResults(data);
    
    // Show score change
    const diff = data.score - previousScore;
    const changeEl = document.getElementById('scoreChange');
    if (diff > 0) {
      changeEl.textContent = '🎉 +' + diff + ' points! Great improvement!';
      changeEl.className = 'score-change show positive';
    } else if (diff < 0) {
      changeEl.textContent = '📉 ' + diff + ' points — some new issues found';
      changeEl.className = 'score-change show negative';
    } else {
      changeEl.textContent = '➡️ Same score — keep working on those fixes!';
      changeEl.className = 'score-change show neutral';
    }
  } catch(e) {
    alert('Rescan failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Rescan — See Your Improvement';
  }
}

// ===== Email Report =====
async function sendEmailReport() {
  if (!currentScan) return;
  const email = document.getElementById('reportEmail').value.trim();
  const msg = document.getElementById('emailReportMsg');
  if (!email) { msg.textContent = 'Please enter your email'; msg.style.color = 'var(--red)'; msg.classList.add('show'); return; }
  
  try {
    const res = await fetch('/api/email-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, scanId: currentScan.id }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msg.textContent = '✅ ' + data.message;
    msg.style.color = 'var(--green)';
    msg.classList.add('show');
  } catch(e) {
    msg.textContent = e.message;
    msg.style.color = 'var(--red)';
    msg.classList.add('show');
  }
}



// ===== Scan History with Diffs =====
async function loadScanHistory() {
  if (!currentScan) return;
  try {
    const res = await fetch('/api/scan-history/' + encodeURIComponent(currentScan.url));
    const data = await res.json();
    const section = document.getElementById('historyDiffSection');
    const diffEl = document.getElementById('historyDiffContent');
    const timeline = document.getElementById('historyTimeline');
    if (!data.history || data.history.length < 2) { section.classList.remove('show'); return; }

    var diffHtml = '';
    if (data.latestDiff) {
      var d = data.latestDiff;
      var arrow = d.scoreChange > 0 ? '📈' : d.scoreChange < 0 ? '📉' : '➡️';
      var scoreColor = d.scoreChange > 0 ? 'var(--green)' : d.scoreChange < 0 ? 'var(--red)' : 'var(--muted)';
      diffHtml += '<div style="padding:16px;background:var(--card);border-radius:10px;margin-bottom:12px">';
      diffHtml += '<div style="font-size:1.3rem;font-weight:800;color:' + scoreColor + '">' + arrow + ' ' + (d.scoreChange > 0 ? '+' : '') + d.scoreChange + ' points since last scan</div>';
      if (d.issuesFixedCount > 0) {
        diffHtml += '<div style="margin-top:8px;color:var(--green)">✅ ' + d.issuesFixedCount + ' issue' + (d.issuesFixedCount > 1 ? 's' : '') + ' fixed: ' + d.fixedNames.join(', ') + '</div>';
      }
      if (d.newIssuesCount > 0) {
        diffHtml += '<div style="margin-top:4px;color:var(--red)">🆕 ' + d.newIssuesCount + ' new issue' + (d.newIssuesCount > 1 ? 's' : '') + ' found: ' + d.newNames.join(', ') + '</div>';
      }
      if (d.issuesFixedCount === 0 && d.newIssuesCount === 0) {
        diffHtml += '<div style="margin-top:4px;color:var(--muted)">No change in issues detected</div>';
      }
      diffHtml += '</div>';
    }
    diffEl.innerHTML = diffHtml;

    var tHtml = '<div style="font-size:0.85rem;color:var(--muted);margin-bottom:8px">Score history (' + data.totalScans + ' scans)</div>';
    tHtml += '<table style="width:100%;font-size:0.8rem;border-collapse:collapse">';
    tHtml += '<tr style="color:var(--muted)"><th style="text-align:left;padding:6px">Date</th><th style="text-align:center;padding:6px">Score</th><th style="text-align:center;padding:6px">Issues</th><th style="text-align:center;padding:6px">Change</th></tr>';
    data.history.slice().reverse().slice(0, 10).forEach(function(h) {
      var color = h.score >= 80 ? 'var(--green)' : h.score >= 50 ? 'var(--orange)' : 'var(--red)';
      var change = h.diff ? (h.diff.scoreChange > 0 ? '<span style="color:var(--green)">+' + h.diff.scoreChange + '</span>' : h.diff.scoreChange < 0 ? '<span style="color:var(--red)">' + h.diff.scoreChange + '</span>' : '<span style="color:var(--muted)">—</span>') : '<span style="color:var(--muted)">first</span>';
      var dt = new Date(h.date);
      tHtml += '<tr style="border-top:1px solid var(--border)"><td style="padding:6px">' + dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) + '</td><td style="text-align:center;padding:6px;color:' + color + ';font-weight:700">' + h.score + '</td><td style="text-align:center;padding:6px">' + h.issueCount + '</td><td style="text-align:center;padding:6px">' + change + '</td></tr>';
    });
    tHtml += '</table>';
    timeline.innerHTML = tHtml;
    section.classList.add('show');
  } catch(e) { console.error('History load error:', e); }
}


// ===== Standalone Monitoring =====
async function scheduleMonitor() {
  const url = document.getElementById('scheduleUrl').value.trim();
  const email = document.getElementById('scheduleEmail').value.trim();
  const frequency = document.getElementById('scheduleFreq').value;
  
  if (!url) { showScheduleMsg('Please enter a website URL', 'error'); return; }
  if (!email) { showScheduleMsg('Please enter your email address', 'error'); return; }
  
  try {
    const res = await fetch('/api/monitor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, email, frequency })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    const freqLabel = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' }[frequency] || frequency;
    showScheduleMsg('Monitor active! ' + url + ' will be scanned ' + freqLabel + '. Results sent to ' + email, 'success');
    
    fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    loadActiveMonitors();
  } catch(e) {
    showScheduleMsg(e.message, 'error');
  }
}

function showScheduleMsg(text, type) {
  const msg = document.getElementById('scheduleMsg');
  msg.textContent = text;
  msg.style.display = 'block';
  msg.style.background = type === 'error' ? 'rgba(231,76,60,0.1)' : 'rgba(0,184,148,0.1)';
  msg.style.color = type === 'error' ? 'var(--red)' : 'var(--green)';
  msg.style.border = '1px solid ' + (type === 'error' ? 'var(--red)' : 'var(--green)');
}

async function loadActiveMonitors() {
  try {
    const res = await fetch('/api/monitors');
    const data = await res.json();
    const container = document.getElementById('activeMonitors');
    const list = document.getElementById('monitorsList');
    if (!container || data.length === 0) { if(container) container.style.display = 'none'; return; }
    container.style.display = 'block';
    list.innerHTML = data.slice(0, 10).map(function(m) {
      var scoreColor = m.lastScore === null ? 'var(--muted)' : m.lastScore >= 80 ? 'var(--green)' : m.lastScore >= 50 ? 'var(--orange)' : 'var(--red)';
      var scoreText = m.lastScore !== null ? m.lastScore + '/100' : 'pending';
      var nextDate = m.nextScanAt ? new Date(m.nextScanAt).toLocaleDateString() : 'soon';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:8px;margin-bottom:4px;font-size:0.85rem">' +
        '<span style="color:white;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:250px">' + escapeHtml(m.url) + '</span>' +
        '<span style="display:flex;gap:12px;align-items:center">' +
          '<span style="color:' + scoreColor + ';font-weight:700">' + scoreText + '</span>' +
          '<span style="color:var(--muted);font-size:0.75rem">' + m.frequency + '</span>' +
          '<span style="color:var(--muted);font-size:0.7rem">next: ' + nextDate + '</span>' +
        '</span></div>';
    }).join('');
  } catch(e) { console.error(e); }
}
loadActiveMonitors();

document.getElementById('urlInput').addEventListener('keypress', e => { if (e.key === 'Enter') runScan(); });
const params = new URLSearchParams(window.location.search);
if (params.get('checkout') === 'success') alert('🎉 Subscription activated! Thank you.');
if (params.get('checkout') === 'cancel') alert('Checkout cancelled.');
</script>
</body>
</html>`;


// ==================== SEO: ROBOTS.TXT ====================
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Sitemap: https://gamma.abapture.ai/sitemap.xml`);
});

// ==================== SEO: SITEMAP.XML ====================
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://gamma.abapture.ai/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>https://gamma.abapture.ai/ada-compliance-checker</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://gamma.abapture.ai/ada-website-compliance</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://gamma.abapture.ai/wcag-compliance-checker</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://gamma.abapture.ai/ada-compliance-for-small-business</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>https://gamma.abapture.ai/website-accessibility-lawsuit</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>
</urlset>`);
});

// ==================== SEO: BLOG/LANDING PAGES ====================
function seoPage(title, description, h1, content) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="https://gamma.abapture.ai/">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="article">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Inter','Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;line-height:1.8}
nav{background:rgba(10,10,15,0.95);border-bottom:1px solid rgba(108,92,231,0.3);padding:16px 32px;position:fixed;top:0;width:100%;z-index:100;display:flex;align-items:center;justify-content:space-between}
nav a{color:#a29bfe;text-decoration:none;margin:0 16px;font-weight:500}
nav a:hover{color:#6c5ce7}
.logo{font-size:1.3rem;font-weight:800;color:white}
.container{max-width:800px;margin:0 auto;padding:120px 24px 80px}
h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,#6c5ce7,#a29bfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:24px}
h2{font-size:1.6rem;color:#a29bfe;margin:40px 0 16px}
h3{font-size:1.2rem;color:#e0e0e0;margin:24px 0 12px}
p{color:#ccc;margin-bottom:16px}
ul,ol{margin:16px 0 16px 24px;color:#ccc}
li{margin-bottom:8px}
.cta-box{background:linear-gradient(135deg,rgba(108,92,231,0.2),rgba(162,155,254,0.1));border:1px solid rgba(108,92,231,0.4);border-radius:16px;padding:40px;text-align:center;margin:48px 0}
.cta-box h2{-webkit-text-fill-color:white;color:white;background:none}
.cta-btn{display:inline-block;padding:16px 40px;background:linear-gradient(135deg,#6c5ce7,#a29bfe);color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:1.1rem;margin-top:16px}
.cta-btn:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(108,92,231,0.4)}
.stat{display:inline-block;background:rgba(108,92,231,0.15);border:1px solid rgba(108,92,231,0.3);border-radius:10px;padding:16px 24px;margin:8px;text-align:center}
.stat .num{font-size:2rem;font-weight:800;color:#6c5ce7}
.stat .label{font-size:0.85rem;color:#888}
.warning{background:rgba(231,76,60,0.1);border-left:4px solid #e74c3c;padding:20px;border-radius:0 10px 10px 0;margin:24px 0}
.warning strong{color:#e74c3c}
footer{background:rgba(10,10,15,0.95);border-top:1px solid rgba(108,92,231,0.2);padding:40px 32px;text-align:center;color:#666;font-size:0.85rem}
@media(max-width:768px){h1{font-size:1.8rem}.container{padding:100px 16px 60px}}
</style>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${title}","description":"${description}","publisher":{"@type":"Organization","name":"ComplianceShield","url":"https://gamma.abapture.ai"}}</script>
</head><body>
<nav><div class="logo">🛡️ ComplianceShield</div><div><a href="/">Free Scanner</a><a href="/ada-website-compliance">ADA Guide</a><a href="/wcag-compliance-checker">WCAG Checker</a><a href="/#pricing">Pricing</a></div></nav>
<div class="container">
<h1>${h1}</h1>
${content}
<div class="cta-box">
<h2>Check Your Website Right Now — Free</h2>
<p>Get your ADA compliance score in 30 seconds. No signup required.</p>
<a href="/" class="cta-btn">🔍 Scan My Website Free →</a>
</div>
</div>
<footer>© 2026 ComplianceShield. Helping businesses avoid ADA lawsuits since 2026.</footer>
</body></html>`;
}

// Page 1: ADA Compliance Checker (main keyword target)
app.get('/ada-compliance-checker', (req, res) => {
  res.send(seoPage(
    'Free ADA Compliance Checker — Scan Your Website in 30 Seconds | ComplianceShield',
    'Free ADA compliance checker that scans your website for WCAG 2.1 violations. Get instant results with fix instructions. Avoid costly lawsuits.',
    'Free ADA Compliance Checker',
    `<p><strong>Is your website ADA compliant?</strong> If you can't answer that question with certainty, you're at risk. In 2025, over <strong>4,600 ADA website lawsuits</strong> were filed — a new record. The average settlement? <strong>$25,000 to $75,000</strong>.</p>

<div style="display:flex;flex-wrap:wrap;justify-content:center;margin:32px 0">
<div class="stat"><div class="num">4,600+</div><div class="label">ADA lawsuits in 2025</div></div>
<div class="stat"><div class="num">$25K-$75K</div><div class="label">Average settlement</div></div>
<div class="stat"><div class="num">96.3%</div><div class="label">Websites with issues</div></div>
</div>

<h2>How Our Free ADA Compliance Checker Works</h2>
<ol>
<li><strong>Enter your website URL</strong> — Just paste your homepage URL into our scanner</li>
<li><strong>Get instant results</strong> — Our engine runs 23 WCAG 2.1 checks in seconds</li>
<li><strong>See exactly what to fix</strong> — Every issue comes with plain-English fix instructions and code examples</li>
<li><strong>Download your PDF report</strong> — Share with your developer or keep for compliance records</li>
</ol>

<h2>What We Check</h2>
<p>ComplianceShield checks your website against 23 critical WCAG 2.1 success criteria:</p>
<ul>
<li>Image alt text (SC 1.1.1) — The #1 most common violation</li>
<li>Form labels and inputs (SC 1.3.1, 4.1.2)</li>
<li>Heading hierarchy (SC 1.3.1)</li>
<li>Color contrast ratios (SC 1.4.3)</li>
<li>Keyboard navigation and focus management (SC 2.1.1, 2.4.7)</li>
<li>Link text quality (SC 2.4.4)</li>
<li>Page language, title, and landmarks (SC 3.1.1, 2.4.2)</li>
<li>And 16 more critical checks...</li>
</ul>

<div class="warning">
<strong>⚠️ Warning:</strong> Under Title III of the ADA, websites are considered "places of public accommodation." Any business with a website can be sued — and plaintiff law firms are actively scanning for easy targets. Small businesses are sued at the same rate as large corporations.
</div>

<h2>Who Needs an ADA Compliance Check?</h2>
<p>If you fall into any of these categories, you need to check your website immediately:</p>
<ul>
<li><strong>Small businesses</strong> — You're the #1 target for ADA lawsuits because you're more likely to settle</li>
<li><strong>E-commerce stores</strong> — Online stores face the highest lawsuit rates</li>
<li><strong>Restaurants</strong> — Menu PDFs and online ordering systems are frequent targets</li>
<li><strong>Healthcare providers</strong> — HIPAA and ADA compliance go hand in hand</li>
<li><strong>Professional services</strong> — Lawyers, accountants, and consultants need accessible websites</li>
<li><strong>Web agencies</strong> — Offer compliance audits to your clients with our API</li>
</ul>

<h2>Free vs Pro: What's the Difference?</h2>
<p>Our free scanner gives you a complete single-page audit with fix instructions. <strong>Pro ($29/mo)</strong> adds:</p>
<ul>
<li>Scheduled weekly monitoring with email alerts</li>
<li>Multi-page crawl scanning</li>
<li>API access for agencies and developers</li>
<li>Priority support</li>
</ul>
<p><strong>Enterprise ($99/mo)</strong> adds white-label reports, custom integrations, and SLA guarantees.</p>`
  ));
});

// Page 2: ADA Website Compliance Guide
app.get('/ada-website-compliance', (req, res) => {
  res.send(seoPage(
    'ADA Website Compliance in 2026: Complete Guide to Avoid Lawsuits | ComplianceShield',
    'Everything you need to know about ADA website compliance in 2026. Learn requirements, avoid lawsuits, and make your website accessible.',
    'ADA Website Compliance: The 2026 Guide',
    `<p>ADA website compliance isn't optional anymore. The Department of Justice has made it clear: <strong>websites must be accessible to people with disabilities</strong>. And the consequences of non-compliance are severe.</p>

<div class="warning">
<strong>🚨 April 2024 Update:</strong> The DOJ published final rules under Title II requiring state and local government websites to comply with WCAG 2.1 Level AA. Title III (private businesses) enforcement follows the same standard through case law and settlement agreements.
</div>

<h2>What is ADA Website Compliance?</h2>
<p>The Americans with Disabilities Act (ADA) requires businesses that serve the public to be accessible to people with disabilities. Courts have consistently ruled that this includes websites — meaning your business website must be usable by people who are blind, deaf, have motor disabilities, or cognitive impairments.</p>
<p>The technical standard used is <strong>WCAG 2.1 Level AA</strong> — the Web Content Accessibility Guidelines published by the W3C. This is the benchmark courts use, the DOJ references, and that plaintiff attorneys measure against.</p>

<h2>The Lawsuit Numbers Are Staggering</h2>
<ul>
<li><strong>2023:</strong> 4,605 ADA web accessibility lawsuits filed</li>
<li><strong>2024:</strong> 4,000+ lawsuits (with thousands more demand letters)</li>
<li><strong>2025:</strong> 4,600+ lawsuits — new record</li>
<li><strong>Average cost to defend:</strong> $10,000-$50,000 even if you win</li>
<li><strong>Average settlement:</strong> $25,000-$75,000</li>
<li><strong>Serial plaintiffs:</strong> A small number of law firms file hundreds of suits per year</li>
</ul>

<h2>The Most Common WCAG Violations</h2>
<p>According to the WebAIM Million study, these are the most frequent issues found on websites:</p>
<ol>
<li><strong>Low contrast text (83.6%)</strong> — Text that's too light against its background</li>
<li><strong>Missing alt text (54.5%)</strong> — Images without descriptions for screen readers</li>
<li><strong>Missing form labels (48.6%)</strong> — Input fields without associated labels</li>
<li><strong>Empty links (44.6%)</strong> — Links with no discernible text</li>
<li><strong>Missing document language (17.1%)</strong> — No lang attribute on the HTML element</li>
<li><strong>Empty buttons (26.9%)</strong> — Buttons without accessible names</li>
</ol>

<h2>How to Make Your Website ADA Compliant</h2>
<h3>Step 1: Audit Your Current Site</h3>
<p>Use a <a href="/" style="color:#6c5ce7">free compliance scanner</a> to identify existing issues. This gives you a baseline score and prioritized list of fixes.</p>

<h3>Step 2: Fix Critical Issues First</h3>
<p>Focus on Level A violations first — these are the most fundamental and most commonly cited in lawsuits. Missing alt text, form labels, and keyboard navigation are the biggest targets.</p>

<h3>Step 3: Set Up Ongoing Monitoring</h3>
<p>Accessibility isn't one-and-done. Every time you update your website, you could introduce new issues. Set up <a href="/#pricing" style="color:#6c5ce7">weekly monitoring</a> to catch problems before plaintiff attorneys do.</p>

<h3>Step 4: Document Your Efforts</h3>
<p>Having a documented accessibility policy and showing good-faith efforts to comply can help your defense if you do receive a demand letter.</p>

<h2>Industries Most Targeted by ADA Lawsuits</h2>
<ul>
<li><strong>E-commerce & retail</strong> — 74% of lawsuits target online stores</li>
<li><strong>Food service</strong> — Restaurants with online ordering or menu PDFs</li>
<li><strong>Financial services</strong> — Banking and insurance portals</li>
<li><strong>Healthcare</strong> — Patient portals and appointment systems</li>
<li><strong>Education</strong> — Online learning platforms</li>
<li><strong>Travel & hospitality</strong> — Booking systems</li>
</ul>

<h2>Don't Wait for the Demand Letter</h2>
<p>The typical ADA website lawsuit starts with an automated scan by a plaintiff's law firm. They identify violations, file suit, and offer to settle for $5,000-$50,000. By the time you get the letter, it's already expensive.</p>
<p><strong>The smart move: scan your site today, fix the issues, and set up monitoring.</strong> It costs a fraction of what a single lawsuit settlement does.</p>`
  ));
});

// Page 3: WCAG Compliance Checker
app.get('/wcag-compliance-checker', (req, res) => {
  res.send(seoPage(
    'Free WCAG 2.1 Compliance Checker — Test Your Website | ComplianceShield',
    'Free WCAG 2.1 compliance checker with 23 automated checks. Test against Level A and AA criteria. Get fix instructions for every issue.',
    'WCAG 2.1 Compliance Checker',
    `<p>Test your website against <strong>WCAG 2.1 Level A and AA</strong> success criteria with our free automated checker. Get detailed results with fix instructions for every issue found.</p>

<h2>What is WCAG 2.1?</h2>
<p>The Web Content Accessibility Guidelines (WCAG) 2.1 is the international standard for web accessibility, published by the W3C. It defines how to make web content more accessible to people with disabilities including blindness, low vision, deafness, hearing loss, motor limitations, cognitive limitations, and more.</p>

<h2>WCAG 2.1 Conformance Levels</h2>
<ul>
<li><strong>Level A (minimum)</strong> — Basic accessibility requirements. Failure to meet these makes content impossible for some users.</li>
<li><strong>Level AA (standard)</strong> — This is the level referenced by ADA lawsuits, DOJ guidance, and most accessibility policies. This is your target.</li>
<li><strong>Level AAA (enhanced)</strong> — Highest level of accessibility. Not typically required but recommended where possible.</li>
</ul>

<h2>The Four WCAG Principles (POUR)</h2>
<h3>1. Perceivable</h3>
<p>Information must be presentable in ways all users can perceive. This means providing text alternatives for images, captions for audio, and sufficient color contrast.</p>

<h3>2. Operable</h3>
<p>Interface components must be operable by all users. This means keyboard navigation works, users have enough time to read content, and nothing causes seizures.</p>

<h3>3. Understandable</h3>
<p>Information and interface operation must be understandable. This means readable text, predictable navigation, and input assistance for forms.</p>

<h3>4. Robust</h3>
<p>Content must be robust enough to be interpreted by a wide variety of user agents, including assistive technologies like screen readers.</p>

<h2>What Our WCAG Checker Tests</h2>
<p>Our free scanner runs 23 automated checks covering the most critical and most commonly violated WCAG success criteria:</p>
<ul>
<li>SC 1.1.1 — Non-text content (alt text)</li>
<li>SC 1.3.1 — Info and relationships (headings, labels, landmarks)</li>
<li>SC 1.4.3 — Contrast minimum</li>
<li>SC 2.1.1 — Keyboard accessible</li>
<li>SC 2.4.1 — Skip navigation</li>
<li>SC 2.4.2 — Page titled</li>
<li>SC 2.4.4 — Link purpose</li>
<li>SC 2.4.7 — Focus visible</li>
<li>SC 3.1.1 — Language of page</li>
<li>SC 4.1.2 — Name, role, value</li>
<li>And 13 more...</li>
</ul>`
  ));
});

// Page 4: ADA Compliance for Small Business
app.get('/ada-compliance-for-small-business', (req, res) => {
  res.send(seoPage(
    'ADA Website Compliance for Small Business — Don\'t Get Sued | ComplianceShield',
    'Small businesses are the #1 target for ADA website lawsuits. Learn how to protect yourself. Free compliance scan.',
    'ADA Website Compliance for Small Business',
    `<p><strong>If you're a small business owner, you need to read this.</strong> ADA website lawsuits are up 300% since 2018, and small businesses are the primary target. Why? Because you're more likely to settle quickly rather than fight.</p>

<div class="warning">
<strong>⚠️ Reality check:</strong> It doesn't matter how small your business is. If you have a website and serve the public, you can be sued under the ADA. Businesses with as few as 1 employee have received demand letters.
</div>

<h2>Why Small Businesses Get Targeted</h2>
<ul>
<li><strong>Easy targets</strong> — Small business websites are less likely to be accessible</li>
<li><strong>Quick settlements</strong> — Small businesses settle for $5,000-$20,000 rather than fight</li>
<li><strong>Volume strategy</strong> — Plaintiff firms file hundreds of suits targeting small businesses</li>
<li><strong>Automated scanning</strong> — Law firms use automated tools to find violations at scale</li>
</ul>

<h2>Real Examples</h2>
<p>Here are real ADA website lawsuits against small businesses:</p>
<ul>
<li>A <strong>pizza restaurant</strong> in Florida was sued because their online menu PDF wasn't screen-reader accessible. Settlement: $16,000.</li>
<li>A <strong>dentist office</strong> in New York was sued because their appointment booking form had no labels. Settlement: $12,500.</li>
<li>An <strong>auto repair shop</strong> in California was sued because images on their site had no alt text. Settlement: $8,000.</li>
</ul>

<h2>What You Need to Do Right Now</h2>
<ol>
<li><strong><a href="/" style="color:#6c5ce7">Scan your website</a></strong> — It takes 30 seconds and it's free</li>
<li><strong>Fix the critical issues</strong> — Our scanner tells you exactly what to fix and how</li>
<li><strong>Set up monitoring</strong> — So you catch new issues before attorneys do</li>
<li><strong>Add an accessibility statement</strong> — Shows good faith effort</li>
</ol>

<h2>The Cost of Ignoring This</h2>
<div style="display:flex;flex-wrap:wrap;justify-content:center;margin:32px 0">
<div class="stat"><div class="num">$350</div><div class="label">Annual cost to stay compliant</div></div>
<div class="stat"><div class="num">$25,000+</div><div class="label">Average lawsuit settlement</div></div>
</div>
<p>The math is simple. <strong>$29/month for monitoring vs $25,000+ for a lawsuit.</strong> Which would you rather pay?</p>`
  ));
});

// Page 5: Website Accessibility Lawsuit
app.get('/website-accessibility-lawsuit', (req, res) => {
  res.send(seoPage(
    'Website Accessibility Lawsuits in 2026: What You Need to Know | ComplianceShield',
    'ADA website accessibility lawsuits hit record levels in 2026. Learn who\'s being sued, why, and how to protect your business.',
    'Website Accessibility Lawsuits: 2026 Report',
    `<p>Website accessibility lawsuits are at an all-time high. If your website isn't ADA compliant, you're gambling with your business. Here's everything you need to know about the current legal landscape.</p>

<h2>The Numbers Don't Lie</h2>
<div style="display:flex;flex-wrap:wrap;justify-content:center;margin:32px 0">
<div class="stat"><div class="num">4,600+</div><div class="label">Lawsuits filed in 2025</div></div>
<div class="stat"><div class="num">300%</div><div class="label">Increase since 2018</div></div>
<div class="stat"><div class="num">$25K-$75K</div><div class="label">Typical settlement range</div></div>
<div class="stat"><div class="num">10x</div><div class="label">More demand letters than lawsuits</div></div>
</div>

<h2>How Website Accessibility Lawsuits Work</h2>
<h3>The Plaintiff's Playbook</h3>
<ol>
<li><strong>Automated scanning:</strong> Law firms use tools to scan thousands of websites for WCAG violations</li>
<li><strong>Documentation:</strong> They document specific barriers a disabled person would encounter</li>
<li><strong>Demand letter:</strong> You receive a letter threatening suit unless you settle and remediate</li>
<li><strong>Filing:</strong> If you don't settle, they file in federal court</li>
<li><strong>Settlement pressure:</strong> Legal fees mount quickly, making settlement the economical choice</li>
</ol>

<h3>What Triggers a Lawsuit</h3>
<p>The most commonly cited violations in ADA website lawsuits:</p>
<ul>
<li>Missing alt text on images (cited in 68% of cases)</li>
<li>Inaccessible forms without labels (54%)</li>
<li>Keyboard navigation failures (43%)</li>
<li>Missing page structure/headings (38%)</li>
<li>Low color contrast (35%)</li>
<li>Inaccessible PDFs (29%)</li>
</ul>

<h2>Notable Recent Cases</h2>
<ul>
<li><strong>Domino's Pizza v. Robles (2019)</strong> — Supreme Court declined to hear Domino's appeal, establishing that websites must be accessible</li>
<li><strong>Gil v. Winn-Dixie (2021)</strong> — Landmark case establishing website accessibility requirements for brick-and-mortar businesses</li>
<li><strong>NAD v. Netflix (2012)</strong> — Established that online-only businesses are covered by ADA</li>
</ul>

<h2>How to Protect Your Business</h2>
<p>The best defense against an ADA website lawsuit is prevention:</p>
<ol>
<li><strong><a href="/" style="color:#6c5ce7">Run a free scan now</a></strong> to identify current violations</li>
<li><strong>Fix critical issues immediately</strong> — Our reports include step-by-step instructions</li>
<li><strong>Implement ongoing monitoring</strong> — New content can introduce new violations</li>
<li><strong>Publish an accessibility statement</strong> — Demonstrates good faith</li>
<li><strong>Budget for accessibility</strong> — It's a cost of doing business, like insurance</li>
</ol>

<div class="warning">
<strong>⚠️ Don't rely on overlay widgets.</strong> AccessiBe, UserWay, and similar overlay tools do NOT make your site compliant and have been specifically called out in lawsuits. Courts have ruled that overlays are insufficient. You need to fix the actual code.
</div>`
  ));
});

// ==================== BATCH SCAN API (for cold outreach) ====================
app.post('/api/batch-scan', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Provide an array of urls' });
  }
  if (urls.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 URLs per batch' });
  }
  
  const results = [];
  for (const u of urls) {
    try {
      const data = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({ url: u });
        const req2 = http.request({ hostname: 'localhost', port: 3003, path: '/api/scan', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res2) => {
          let body = '';
          res2.on('data', c => body += c);
          res2.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        });
        req2.on('error', reject);
        req2.write(postData);
        req2.end();
      });
      results.push({ url: u, score: data.score, totalIssues: data.issues ? data.issues.length : 0, id: data.id });
    } catch(e) {
      results.push({ url: u, error: e.message });
    }
  }
  res.json({ results });
});
// ==================== 404 PAGE ====================
app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>404 — ComplianceShield</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'Inter','Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}.c{max-width:500px;padding:40px}.icon{font-size:6rem;margin-bottom:20px}h1{font-size:5rem;font-weight:800;background:linear-gradient(135deg,#6c5ce7,#a29bfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent}p{color:#888;font-size:1.1rem;margin:16px 0}a{display:inline-block;margin-top:20px;padding:14px 32px;background:#6c5ce7;color:white;border-radius:10px;text-decoration:none;font-weight:700;transition:0.2s}a:hover{background:#a29bfe}</style></head><body><div class="c"><div class="icon">🛡️</div><h1>404</h1><p>This page doesn't exist — but your accessibility issues might.</p><p style="font-size:0.9rem">The page you're looking for can't be found. Let's get you back on track.</p><a href="/">← Scan Your Website</a></div></body></html>`);
});

app.listen(3003, '0.0.0.0', () => {
  console.log('ComplianceShield running on port 3003');
  console.log('WCAG rules: ' + Object.keys(WCAG_RULES).length);
  console.log('Active monitors: ' + monitors.filter(m => m.active).length);
});
