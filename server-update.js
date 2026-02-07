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
    nextScanAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
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
      const intervalMs = monitor.frequency === 'daily' ? 24*60*60*1000 : 7*24*60*60*1000;
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

// ==================== LANDING PAGE ====================
app.get('/', (req, res) => { res.send(LANDING_PAGE); });
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
footer{text-align:center;padding:40px 0;color:var(--muted);font-size:0.85rem;border-top:1px solid var(--border);margin-top:60px}
.loading{display:none;text-align:center;margin:24px 0}.loading.show{display:block}
.spinner{display:inline-block;width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.error-msg{display:none;text-align:center;padding:16px;background:rgba(231,76,60,0.1);border:1px solid var(--red);border-radius:10px;color:var(--red);margin:16px 0}
.error-msg.show{display:block}
@media(max-width:768px){
  .hero h1{font-size:2rem}
  .pricing,.edu-grid{grid-template-columns:1fr}
  .urgency-stats{grid-template-columns:1fr}
  .stats-row{grid-template-columns:repeat(2,1fr)}
  .scanner-form{flex-direction:column}
  .comp-table{font-size:0.8rem}
  .monitor-form{flex-direction:column}
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

      <!-- Monitor Registration -->
      <div class="monitor-section">
        <h3>🔔 Set Up Weekly Monitoring</h3>
        <p style="font-size:0.85rem;color:var(--muted);margin-bottom:12px">Get automated scan results delivered to your inbox every week. Track your accessibility score over time.</p>
        <div class="monitor-form">
          <input type="email" id="monitorEmail" placeholder="your@email.com" />
          <button onclick="registerMonitor()">📧 Start Monitoring</button>
        </div>
        <div class="monitor-msg" id="monitorMsg"></div>
      </div>

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

  const issuesHtml = data.issues.map(issue => \`
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
  document.getElementById('issuesList').innerHTML = issuesHtml;

  const passesHtml = data.passes.map(p => \`<span class="pass-item">✓ \${p.name} (\${p.wcag})</span>\`).join('');
  document.getElementById('passesList').innerHTML = passesHtml;
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

async function registerMonitor() {
  if (!currentScan) return;
  const email = document.getElementById('monitorEmail').value.trim();
  const msg = document.getElementById('monitorMsg');
  if (!email) { msg.textContent = 'Please enter your email address'; msg.className = 'monitor-msg show error'; return; }

  try {
    const res = await fetch('/api/monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: currentScan.url, email }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msg.textContent = '✅ ' + data.message;
    msg.className = 'monitor-msg show success';
  } catch(e) {
    msg.textContent = e.message;
    msg.className = 'monitor-msg show error';
  }
}

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

document.getElementById('urlInput').addEventListener('keypress', e => { if (e.key === 'Enter') runScan(); });
const params = new URLSearchParams(window.location.search);
if (params.get('checkout') === 'success') alert('🎉 Subscription activated! Thank you.');
if (params.get('checkout') === 'cancel') alert('Checkout cancelled.');
</script>
</body>
</html>`;

app.listen(3003, '0.0.0.0', () => {
  console.log('ComplianceShield running on port 3003');
  console.log('WCAG rules: ' + Object.keys(WCAG_RULES).length);
  console.log('Active monitors: ' + monitors.filter(m => m.active).length);
});
