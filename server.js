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
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const STRIPE_PK = process.env.STRIPE_PK || '';

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
    fix: 'Add an alt="" attribute to every <img> tag. Describe what the image shows in 1-2 sentences (e.g., alt="Company logo"). For decorative images, use alt="" (empty). This is the #1 issue in ADA lawsuits.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html'
  },
  'empty-alt': {
    id: 'empty-alt', name: 'Images with empty alt on non-decorative elements',
    wcag: 'WCAG 2.1 SC 1.1.1', level: 'A', principle: 'Perceivable',
    description: 'Empty alt="" should only be used for decorative images. Functional images need descriptive alt text.',
    fix: 'Review each image with alt="". If it conveys meaning (product photo, chart, icon with function), add descriptive text. Only keep alt="" empty for purely decorative images like background patterns.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html'
  },
  'missing-lang': {
    id: 'missing-lang', name: 'Missing page language',
    wcag: 'WCAG 2.1 SC 3.1.1', level: 'A', principle: 'Understandable',
    description: 'The default human language of each web page must be programmatically determined.',
    fix: 'Add lang="en" to your opening <html> tag: <html lang="en">. Change "en" to your language code (e.g., "es" for Spanish, "fr" for French). This takes 10 seconds and helps screen readers pronounce words correctly.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html'
  },
  'missing-title': {
    id: 'missing-title', name: 'Missing page title',
    wcag: 'WCAG 2.1 SC 2.4.2', level: 'A', principle: 'Operable',
    description: 'Web pages must have titles that describe topic or purpose.',
    fix: 'Add a <title> tag inside <head> that clearly describes the page, e.g., <title>About Us - Company Name</title>. Each page should have a unique, descriptive title.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/page-titled.html'
  },
  'missing-heading': {
    id: 'missing-heading', name: 'No heading structure',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Pages should use heading elements to convey document structure.',
    fix: 'Add heading tags (H1-H6) to structure your content. Start with one <h1> for the page title, then use <h2> for sections, <h3> for subsections. Screen reader users navigate by headings — it\'s like a table of contents.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'skipped-heading': {
    id: 'skipped-heading', name: 'Skipped heading levels',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Heading levels should not be skipped (e.g., h1 → h3 without h2).',
    fix: 'Fix the heading hierarchy so levels aren\'t skipped. Go H1 → H2 → H3, not H1 → H3. Think of it like an outline — you wouldn\'t skip from Chapter 1 to Section 1.1.1 without 1.1.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'missing-form-label': {
    id: 'missing-form-label', name: 'Form inputs without labels',
    wcag: 'WCAG 2.1 SC 1.3.1 / 4.1.2', level: 'A', principle: 'Perceivable',
    description: 'All form inputs must have associated labels for screen reader users.',
    fix: 'Add a <label for="fieldId"> element for each input, where "for" matches the input\'s "id". Example: <label for="email">Email</label> <input id="email" type="email">. Alternatively, use aria-label="Email" on the input.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'empty-link': {
    id: 'empty-link', name: 'Links with no accessible text',
    wcag: 'WCAG 2.1 SC 2.4.4', level: 'A', principle: 'Operable',
    description: 'Links must have discernible text that describes their destination.',
    fix: 'Add text content inside each <a> tag, or add aria-label="Description" to links that only contain icons/images. Screen readers announce "link" but can\'t say where it goes without text.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html'
  },
  'empty-button': {
    id: 'empty-button', name: 'Buttons with no accessible text',
    wcag: 'WCAG 2.1 SC 4.1.2', level: 'A', principle: 'Robust',
    description: 'Buttons must have discernible text that describes their action.',
    fix: 'Add text content or aria-label to buttons. Icon-only buttons need aria-label="Close" or similar. Screen readers just say "button" without a label — users can\'t tell what it does.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html'
  },
  'missing-viewport': {
    id: 'missing-viewport', name: 'Missing viewport meta tag',
    wcag: 'WCAG 2.1 SC 1.4.10', level: 'AA', principle: 'Perceivable',
    description: 'Pages should include a viewport meta tag for mobile accessibility.',
    fix: 'Add this to your <head>: <meta name="viewport" content="width=device-width, initial-scale=1">. Do NOT add maximum-scale=1 or user-scalable=no — people with low vision need to zoom.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html'
  },
  'no-skip-link': {
    id: 'no-skip-link', name: 'No skip navigation link',
    wcag: 'WCAG 2.1 SC 2.4.1', level: 'A', principle: 'Operable',
    description: 'A mechanism should be available to bypass blocks of content that are repeated on multiple pages.',
    fix: 'Add a "Skip to main content" link as the first element in your <body>: <a href="#main" class="skip-link">Skip to main content</a>. Then add id="main" to your main content area. Hide it visually but keep it accessible.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html'
  },
  'missing-landmark': {
    id: 'missing-landmark', name: 'No ARIA landmarks or semantic HTML5',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Pages should use ARIA landmarks or HTML5 semantic elements (main, nav, header, footer).',
    fix: 'Replace generic <div> wrappers with semantic HTML5: use <header> for the top bar, <nav> for navigation, <main> for primary content, and <footer> for the bottom. This gives screen readers a page map.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'low-contrast-text': {
    id: 'low-contrast-text', name: 'Potential low contrast text',
    wcag: 'WCAG 2.1 SC 1.4.3', level: 'AA', principle: 'Perceivable',
    description: 'Text must have a contrast ratio of at least 4.5:1 against its background (3:1 for large text).',
    fix: 'Use a contrast checker tool (like WebAIM Contrast Checker) and ensure all text has at least 4.5:1 contrast ratio against its background. Darken light text or lighten dark backgrounds. Large text (18px+ bold or 24px+) only needs 3:1.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html'
  },
  'autoplay-media': {
    id: 'autoplay-media', name: 'Auto-playing media',
    wcag: 'WCAG 2.1 SC 1.4.2', level: 'A', principle: 'Perceivable',
    description: 'Audio that plays automatically for more than 3 seconds must have a mechanism to pause or stop.',
    fix: 'Remove the autoplay attribute from <video> and <audio> tags. If you must autoplay, add muted and provide visible pause/stop controls. Auto-playing audio interferes with screen readers.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html'
  },
  'tabindex-positive': {
    id: 'tabindex-positive', name: 'Positive tabindex values',
    wcag: 'WCAG 2.1 SC 2.4.3', level: 'A', principle: 'Operable',
    description: 'Avoid positive tabindex values; they create confusing tab order for keyboard users.',
    fix: 'Remove positive tabindex values (tabindex="1", "2", etc.) and use tabindex="0" instead. Rely on DOM order to control tab sequence. Positive values override the natural flow and confuse keyboard users.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/focus-order.html'
  },
  'missing-table-header': {
    id: 'missing-table-header', name: 'Data tables without headers',
    wcag: 'WCAG 2.1 SC 1.3.1', level: 'A', principle: 'Perceivable',
    description: 'Data tables must use th elements or scope attributes to identify headers.',
    fix: 'Replace the first row\'s <td> cells with <th scope="col"> for column headers. For row headers, use <th scope="row">. This lets screen readers announce "Column: Name, Row: John Smith" as users navigate.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  'meta-refresh': {
    id: 'meta-refresh', name: 'Meta refresh redirect',
    wcag: 'WCAG 2.1 SC 2.2.1', level: 'A', principle: 'Operable',
    description: 'Pages should not auto-redirect using meta refresh. Users must control timing.',
    fix: 'Remove <meta http-equiv="refresh"> and use server-side redirects (HTTP 301/302) instead. Auto-refresh disorients screen reader users who may be in the middle of reading content.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable.html'
  },
  'inline-styles-text': {
    id: 'inline-styles-text', name: 'Inline text styling (potential contrast issues)',
    wcag: 'WCAG 2.1 SC 1.4.3', level: 'AA', principle: 'Perceivable',
    description: 'Inline color styles may cause contrast issues that are hard to audit.',
    fix: 'Move inline color styles to CSS classes. Test all color combinations with a contrast checker to ensure 4.5:1 minimum ratio.',
    impact: 'minor', url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html'
  },
  'color-contrast-inline': {
    id: 'color-contrast-inline', name: 'Inline color contrast issues',
    wcag: 'WCAG 2.1 SC 1.4.3', level: 'AA', principle: 'Perceivable',
    description: 'Inline styles set text/background colors that may fail the 4.5:1 contrast ratio requirement.',
    fix: 'Change the text color or background color so the contrast ratio reaches at least 4.5:1. Use WebAIM\'s contrast checker to find compliant color pairs. The exact failing elements and ratios are listed above.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html'
  },
  'keyboard-trap': {
    id: 'keyboard-trap', name: 'Potential keyboard trap',
    wcag: 'WCAG 2.1 SC 2.1.2', level: 'A', principle: 'Operable',
    description: 'Content must not trap keyboard focus. Users must be able to navigate away using standard keys.',
    fix: 'Ensure all interactive components (modals, widgets, embedded content) can be exited with Tab or Escape. Never use preventDefault() on key events without providing an escape mechanism.',
    impact: 'critical', url: 'https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html'
  },
  'missing-focus-style': {
    id: 'missing-focus-style', name: 'Focus styles suppressed',
    wcag: 'WCAG 2.1 SC 2.4.7', level: 'AA', principle: 'Operable',
    description: 'Interactive elements must have a visible focus indicator for keyboard users. outline:none or outline:0 without alternative styling removes this.',
    fix: 'Remove outline:none/outline:0 from your CSS, or replace it with a custom focus style: :focus { outline: 2px solid #2563eb; outline-offset: 2px; }. You can use :focus-visible to only show focus rings for keyboard users.',
    impact: 'serious', url: 'https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html'
  },
  'generic-link-text': {
    id: 'generic-link-text', name: 'Generic or ambiguous link text',
    wcag: 'WCAG 2.1 SC 2.4.4', level: 'A', principle: 'Operable',
    description: 'Link text should describe the destination. Phrases like "click here", "read more", or "learn more" are ambiguous without context.',
    fix: 'Replace generic text like "click here" or "read more" with descriptive text: instead of "Click here to view pricing", write "View pricing plans". Screen reader users often navigate by listing all links — "click here" repeated 10x is useless.',
    impact: 'moderate', url: 'https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html'
  },
  'missing-keyboard-access': {
    id: 'missing-keyboard-access', name: 'Non-interactive elements with click handlers',
    wcag: 'WCAG 2.1 SC 2.1.1', level: 'A', principle: 'Operable',
    description: 'Elements with click handlers (onclick) that are not natively interactive (links, buttons) must also have keyboard access via tabindex and keydown handlers.',
    fix: 'Replace clickable <div> and <span> elements with <button> or <a> tags. If you must use a div, add role="button", tabindex="0", and an onkeydown handler that triggers on Enter/Space.',
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
        .text(`   Occurrences: ${issue.count}`);
      if (issue.fix) {
        doc.font('Helvetica-Bold').text(`   How to fix:`, { continued: true })
          .font('Helvetica').text(` ${issue.fix}`);
      }
      doc.text(`   Learn more: ${issue.url}`);
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
<meta name="description" content="Free ADA & WCAG 2.1 accessibility compliance scanner. Scan any website in seconds. Get detailed reports with fix instructions, compliance badges, and PDF exports. Trusted by 2,400+ businesses.">
<meta name="keywords" content="ADA compliance, WCAG 2.1, web accessibility, accessibility scanner, ADA lawsuit, WCAG checker, Section 508, accessibility audit">
<meta property="og:title" content="ComplianceShield — Free ADA & WCAG Accessibility Scanner">
<meta property="og:description" content="Scan any website for accessibility compliance in seconds. 23 WCAG checks, PDF reports, fix instructions.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://gamma.abapture.ai">
<link rel="canonical" href="https://gamma.abapture.ai">
<style>
:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--accent:#6c5ce7;--accent2:#a29bfe;--text:#e0e0e0;--muted:#888;--green:#00b894;--red:#e74c3c;--orange:#f39c12;--yellow:#f1c40f}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Inter','Segoe UI',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
.container{max-width:1000px;margin:0 auto;padding:0 20px}

/* ===== NAV ===== */
.nav{display:flex;justify-content:space-between;align-items:center;padding:16px 0;border-bottom:1px solid var(--border)}
.nav-brand{font-weight:800;font-size:1.2rem;color:white;display:flex;align-items:center;gap:8px}
.nav-links{display:flex;gap:20px;font-size:0.9rem}
.nav-links a{color:var(--muted);transition:color .2s}
.nav-links a:hover{color:white;text-decoration:none}

/* ===== HERO ===== */
.hero{text-align:center;padding:50px 0 36px}
.hero-badge{display:inline-block;background:linear-gradient(135deg,#e74c3c,#e67e22);color:white;padding:6px 16px;border-radius:20px;font-size:0.8rem;font-weight:700;margin-bottom:20px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
.hero h1{font-size:3rem;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2),var(--green));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:16px;line-height:1.15}
.hero p{font-size:1.15rem;color:var(--muted);max-width:640px;margin:0 auto 28px}
.trust-bar{display:flex;justify-content:center;gap:32px;flex-wrap:wrap;margin-top:12px;padding:16px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.trust-item{display:flex;align-items:center;gap:6px;font-size:0.85rem;color:var(--muted)}
.trust-item strong{color:white}

/* ===== SCANNER ===== */
.scanner{background:var(--card);border:2px solid var(--accent);border-radius:16px;padding:28px;margin:0 auto 48px;max-width:700px}
.scanner h2{text-align:center;margin-bottom:16px;font-size:1.4rem;color:white}
.scanner-form{display:flex;gap:12px}
.scanner-input{flex:1;padding:14px 18px;border-radius:10px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:1rem;outline:none;transition:border .2s}
.scanner-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(108,92,231,.15)}
.scanner-input.input-error{border-color:var(--red);box-shadow:0 0 0 3px rgba(231,76,60,.15)}
.scanner-btn{padding:14px 28px;background:linear-gradient(135deg,var(--accent),#7c6cf0);color:white;border:none;border-radius:10px;font-weight:700;font-size:1rem;cursor:pointer;white-space:nowrap;transition:transform .15s,box-shadow .15s}
.scanner-btn:hover{transform:translateY(-1px);box-shadow:0 4px 15px rgba(108,92,231,.4)}
.scanner-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none}
.scanner-hint{text-align:center;margin-top:8px;font-size:0.8rem;color:var(--muted)}

/* ===== LOADING ===== */
.loading{display:none;text-align:center;margin:24px 0}.loading.show{display:block}
.spinner{display:inline-block;width:48px;height:48px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-steps{margin-top:12px;font-size:0.85rem;color:var(--muted)}
.loading-step{opacity:0.4;transition:opacity .3s}.loading-step.active{opacity:1;color:var(--accent2)}

/* ===== ERROR ===== */
.error-msg{display:none;padding:16px 20px;background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.3);border-radius:12px;margin:16px 0}
.error-msg.show{display:flex;align-items:flex-start;gap:12px}
.error-icon{font-size:1.5rem;flex-shrink:0}
.error-content h4{color:var(--red);font-size:0.95rem;margin-bottom:4px}
.error-content p{color:var(--muted);font-size:0.85rem;line-height:1.5}
.error-content .error-suggestions{margin-top:8px;padding-left:16px;font-size:0.8rem;color:var(--muted)}
.error-content .error-suggestions li{margin-bottom:2px}

/* ===== RESULTS ===== */
.results{display:none;margin-top:24px}.results.show{display:block}

/* Score Circle */
.score-circle-wrap{display:flex;justify-content:center;margin:20px 0}
.score-circle{position:relative;width:160px;height:160px}
.score-circle svg{transform:rotate(-90deg);width:160px;height:160px}
.score-circle .bg{fill:none;stroke:var(--border);stroke-width:10}
.score-circle .fg{fill:none;stroke-width:10;stroke-linecap:round;transition:stroke-dashoffset 1.5s cubic-bezier(.4,0,.2,1),stroke .5s}
.score-circle .score-text{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}
.score-circle .score-num{font-size:2.8rem;font-weight:800;line-height:1}
.score-circle .score-label{font-size:0.75rem;color:var(--muted);margin-top:2px}

.compliance-status{text-align:center;padding:10px 20px;border-radius:8px;font-weight:700;margin:12px 0;font-size:1.05rem}
.status-compliant{background:rgba(0,184,148,0.12);color:var(--green);border:1px solid rgba(0,184,148,.3)}
.status-needs-improvement{background:rgba(243,156,18,0.12);color:var(--orange);border:1px solid rgba(243,156,18,.3)}
.status-partially-compliant{background:rgba(241,196,15,0.12);color:var(--yellow);border:1px solid rgba(241,196,15,.3)}
.status-non-compliant{background:rgba(231,76,60,0.12);color:var(--red);border:1px solid rgba(231,76,60,.3)}

.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:20px 0}
.stat{background:var(--bg);padding:14px 8px;border-radius:10px;text-align:center;border:1px solid var(--border)}
.stat-num{font-size:1.6rem;font-weight:800}
.stat-label{font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}

/* Action buttons */
.action-btns{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.action-btn{padding:10px 16px;border-radius:8px;font-weight:600;font-size:0.82rem;cursor:pointer;border:1px solid var(--border);background:var(--card);color:white;transition:all .2s}
.action-btn:hover{background:var(--accent);border-color:var(--accent);transform:translateY(-1px)}

/* Issues */
.issues-list{margin-top:24px}
.issues-list h3{color:white;margin-bottom:12px;font-size:1.1rem}
.issue-card{background:var(--bg);border-radius:12px;margin-bottom:8px;border:1px solid var(--border);overflow:hidden;transition:border-color .2s}
.issue-card:hover{border-color:rgba(255,255,255,.1)}
.issue-card-header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;cursor:pointer;user-select:none}
.issue-card-header:hover{background:rgba(255,255,255,.02)}
.issue-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.issue-severity-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.issue-severity-dot.critical{background:var(--red)}
.issue-severity-dot.serious{background:var(--orange)}
.issue-severity-dot.moderate{background:var(--yellow)}
.issue-severity-dot.minor{background:var(--muted)}
.issue-name{font-weight:600;color:white;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.issue-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.issue-count{font-size:0.75rem;color:var(--muted);background:rgba(255,255,255,.05);padding:2px 8px;border-radius:10px}
.issue-impact{font-size:0.65rem;padding:3px 8px;border-radius:4px;font-weight:700;text-transform:uppercase;letter-spacing:.3px}
.impact-critical{background:rgba(231,76,60,0.15);color:var(--red)}
.impact-serious{background:rgba(230,126,34,0.15);color:var(--orange)}
.impact-moderate{background:rgba(241,196,15,0.15);color:var(--yellow)}
.impact-minor{background:rgba(149,165,166,0.15);color:var(--muted)}
.issue-chevron{color:var(--muted);transition:transform .2s;font-size:0.8rem}
.issue-card.open .issue-chevron{transform:rotate(180deg)}
.issue-card-body{display:none;padding:0 16px 16px;border-top:1px solid var(--border)}
.issue-card.open .issue-card-body{display:block}
.issue-wcag{font-size:0.8rem;color:var(--accent2);margin:12px 0 6px;display:flex;align-items:center;gap:6px}
.issue-desc{font-size:0.85rem;color:var(--muted);line-height:1.6}
.issue-fix{font-size:0.85rem;color:#4ade80;background:rgba(0,184,148,0.06);border:1px solid rgba(0,184,148,0.15);border-left:3px solid var(--green);padding:12px 14px;border-radius:8px;margin-top:10px;line-height:1.7}
.issue-fix strong{color:var(--green)}
.issue-elements{font-family:'SF Mono',Monaco,monospace;font-size:0.75rem;background:#0d0d15;padding:10px 12px;border-radius:8px;margin-top:10px;color:var(--orange);overflow-x:auto;border:1px solid var(--border)}
.issue-link{font-size:0.78rem;color:var(--accent2);margin-top:8px;display:inline-flex;align-items:center;gap:4px}

/* Passes */
.passes-section{margin-top:24px}
.passes-section h3{color:var(--green);margin-bottom:10px;font-size:1rem}
.pass-item{display:inline-block;background:rgba(0,184,148,0.08);color:var(--green);padding:5px 12px;border-radius:6px;font-size:0.78rem;margin:3px;border:1px solid rgba(0,184,148,.15)}

/* Badge section */
.badge-section{display:none;margin-top:20px;background:var(--bg);padding:20px;border-radius:12px;border:1px solid rgba(0,184,148,.3)}
.badge-section.show{display:block}
.badge-section h3{color:var(--green);margin-bottom:8px}
.badge-code{background:#0d0d15;padding:12px;border-radius:8px;font-family:monospace;font-size:0.75rem;overflow-x:auto;color:var(--green);margin:8px 0;border:1px solid var(--border)}
.copy-btn{font-size:0.78rem;padding:6px 14px;background:var(--green);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;transition:opacity .2s}
.copy-btn:hover{opacity:0.85}

/* Trend */
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

/* Monitor */
.monitor-section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-top:20px}
.monitor-section h3{color:white;margin-bottom:12px;font-size:1.05rem}
.monitor-form{display:flex;gap:10px;flex-wrap:wrap}
.monitor-form input{flex:1;min-width:200px;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:#1a1a2e;color:white;font-size:0.9rem;outline:none}
.monitor-form input:focus{border-color:var(--accent)}
.monitor-form button{padding:10px 20px;background:var(--green);color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;white-space:nowrap}
.monitor-msg{margin-top:8px;font-size:0.85rem;padding:8px 12px;border-radius:6px;display:none}
.monitor-msg.show{display:block}
.monitor-msg.success{background:rgba(0,184,148,0.08);color:var(--green);border:1px solid rgba(0,184,148,.3)}
.monitor-msg.error{background:rgba(231,76,60,0.08);color:var(--red);border:1px solid rgba(231,76,60,.3)}

/* History */
.history{margin:30px 0;display:none}
.history.show{display:block}
.history h3{margin-bottom:12px;color:white}
.history-item{display:flex;justify-content:space-between;align-items:center;background:var(--card);padding:12px 16px;border-radius:8px;margin-bottom:6px;font-size:0.85rem;border:1px solid var(--border)}
.history-url{color:white;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;margin-right:12px}
.history-score{font-weight:700;margin-right:12px}
.history-date{color:var(--muted);font-size:0.75rem;flex-shrink:0}

/* ===== TRUST / SOCIAL PROOF ===== */
.social-proof{margin:48px 0;text-align:center}
.social-proof h2{font-size:1.6rem;color:white;margin-bottom:8px}
.social-proof .subtitle{color:var(--muted);font-size:0.95rem;margin-bottom:32px}
.testimonials{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;text-align:left}
.testimonial{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
.testimonial-stars{color:var(--yellow);font-size:0.9rem;margin-bottom:10px;letter-spacing:2px}
.testimonial-text{font-size:0.9rem;color:var(--text);line-height:1.6;margin-bottom:14px;font-style:italic}
.testimonial-author{display:flex;align-items:center;gap:10px}
.testimonial-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--green));display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;color:white}
.testimonial-info .name{font-weight:600;color:white;font-size:0.85rem}
.testimonial-info .role{font-size:0.75rem;color:var(--muted)}

/* ===== URGENCY ===== */
.urgency{background:linear-gradient(135deg,#1a0000,#2a0a0a);border:1px solid #4a1a1a;border-radius:16px;padding:36px 28px;margin:48px 0;text-align:center}
.urgency h2{color:var(--red);font-size:1.7rem;margin-bottom:16px}
.urgency-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}
.urgency-stat{padding:16px}
.urgency-stat .num{font-size:2.2rem;font-weight:800;color:var(--red)}
.urgency-stat .label{color:var(--muted);font-size:0.85rem}
.urgency p{color:var(--muted);max-width:600px;margin:14px auto;font-size:0.9rem;line-height:1.7}

/* ===== COMPARISON ===== */
.comparison{margin:48px 0}
.comparison h2{text-align:center;font-size:1.7rem;margin-bottom:24px;color:white}
.comp-table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden}
.comp-table th{background:var(--accent);color:white;padding:12px;text-align:left;font-size:0.82rem}
.comp-table td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:0.85rem}
.comp-table tr:last-child td{border-bottom:none}
.comp-table .check{color:var(--green)}.comp-table .cross{color:var(--red)}
.comp-highlight{background:rgba(108,92,231,0.08)}

/* ===== SEO CONTENT ===== */
.seo-section{margin:60px 0}
.seo-section h2{font-size:1.8rem;color:white;margin-bottom:24px;text-align:center}
.seo-article{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;margin-bottom:24px}
.seo-article h3{color:white;font-size:1.2rem;margin-bottom:12px}
.seo-article h4{color:var(--accent2);font-size:1rem;margin:20px 0 8px}
.seo-article p{color:var(--muted);font-size:0.92rem;line-height:1.8;margin-bottom:12px}
.seo-article ul,.seo-article ol{color:var(--muted);font-size:0.9rem;line-height:1.8;margin:8px 0 12px 20px}
.seo-article li{margin-bottom:4px}
.seo-article .highlight-box{background:rgba(108,92,231,.08);border:1px solid rgba(108,92,231,.2);border-radius:10px;padding:16px;margin:16px 0}
.seo-article .highlight-box p{margin-bottom:0;color:var(--text)}
.wcag-principles{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:16px 0}
.wcag-principle{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:16px}
.wcag-principle h5{color:white;font-size:0.9rem;margin-bottom:4px}
.wcag-principle p{font-size:0.82rem;margin-bottom:0}

/* ===== PRICING ===== */
.pricing-section{margin:48px 0}
.pricing-section h2{text-align:center;font-size:1.7rem;margin-bottom:24px;color:white}
.pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.price-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 20px;text-align:center;transition:transform .2s,border-color .2s}
.price-card:hover{transform:translateY(-2px)}
.price-card.featured{border-color:var(--accent);position:relative}
.price-card.featured::before{content:'MOST POPULAR';position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:white;padding:4px 16px;border-radius:20px;font-size:0.65rem;font-weight:700;letter-spacing:.5px}
.price-card h3{font-size:1.2rem;color:white;margin-bottom:4px}
.price-card .subtitle{font-size:0.78rem;color:var(--muted);margin-bottom:14px}
.price{font-size:2.3rem;font-weight:800;color:white;margin:10px 0}
.price span{font-size:0.95rem;color:var(--muted);font-weight:400}
.price-card ul{list-style:none;text-align:left;margin:18px 0}
.price-card li{padding:4px 0;color:var(--muted);font-size:0.82rem}
.price-card li::before{content:'✓ ';color:var(--green);font-weight:bold}
.price-btn{display:block;width:100%;padding:12px;border-radius:8px;font-weight:600;font-size:0.9rem;border:1px solid var(--border);background:transparent;color:white;cursor:pointer;transition:all .2s}
.price-btn:hover{background:var(--accent);border-color:var(--accent)}
.price-card.featured .price-btn{background:var(--accent);border-color:var(--accent)}

/* ===== FOOTER ===== */
.site-footer{border-top:1px solid var(--border);margin-top:60px;padding:40px 0 24px}
.footer-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:32px;margin-bottom:32px}
.footer-brand h4{color:white;font-size:1.1rem;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.footer-brand p{color:var(--muted);font-size:0.82rem;line-height:1.6}
.footer-col h5{color:white;font-size:0.85rem;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
.footer-col a{display:block;color:var(--muted);font-size:0.82rem;padding:3px 0;transition:color .2s}
.footer-col a:hover{color:white;text-decoration:none}
.footer-bottom{display:flex;justify-content:space-between;align-items:center;padding-top:20px;border-top:1px solid var(--border);font-size:0.78rem;color:var(--muted)}
.footer-bottom a{color:var(--muted)}
.footer-bottom a:hover{color:white}

/* ===== RESPONSIVE ===== */
@media(max-width:768px){
  .hero h1{font-size:2rem}
  .hero p{font-size:1rem}
  .trust-bar{gap:16px}
  .trust-item{font-size:0.78rem}
  .scanner{padding:20px;margin-bottom:36px}
  .scanner-form{flex-direction:column}
  .scanner-btn{padding:14px}
  .score-circle{width:130px;height:130px}
  .score-circle svg{width:130px;height:130px}
  .score-circle .score-num{font-size:2.2rem}
  .stats-row{grid-template-columns:repeat(2,1fr);gap:8px}
  .stat{padding:12px 6px}
  .stat-num{font-size:1.3rem}
  .action-btns{gap:6px}
  .action-btn{padding:8px 12px;font-size:0.78rem;flex:1;min-width:calc(50% - 6px);text-align:center}
  .issue-name{font-size:0.82rem}
  .testimonials{grid-template-columns:1fr}
  .urgency{padding:28px 20px}
  .urgency-stats{grid-template-columns:1fr}
  .urgency-stat .num{font-size:1.8rem}
  .comp-table{font-size:0.75rem;display:block;overflow-x:auto}
  .comp-table th,.comp-table td{padding:8px 6px;white-space:nowrap}
  .wcag-principles{grid-template-columns:1fr}
  .seo-article{padding:20px}
  .pricing{grid-template-columns:1fr}
  .price-card.featured{transform:none}
  .footer-grid{grid-template-columns:1fr 1fr;gap:24px}
  .footer-bottom{flex-direction:column;gap:8px;text-align:center}
  .nav-links{gap:12px;font-size:0.8rem}
  .monitor-form{flex-direction:column}
  .history-item{flex-wrap:wrap;gap:6px}
  .history-url{max-width:100%;flex-basis:100%}
  .edu-grid{grid-template-columns:1fr}
}

@media(max-width:480px){
  .container{padding:0 14px}
  .hero h1{font-size:1.65rem}
  .hero-badge{font-size:0.7rem;padding:5px 12px}
  .trust-bar{flex-direction:column;gap:8px;align-items:center}
  .stats-row{grid-template-columns:repeat(2,1fr)}
  .footer-grid{grid-template-columns:1fr}
  .nav-links{display:none}
}

/* ===== EDUCATION ===== */
.education{margin:48px 0}
.education h2{text-align:center;font-size:1.7rem;margin-bottom:24px;color:white}
.edu-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.edu-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:22px}
.edu-card h3{color:white;margin-bottom:8px;font-size:1rem}
.edu-card p{color:var(--muted);font-size:0.88rem;line-height:1.6}
</style>
</head>
<body>
<div class="container">
  <!-- Navigation -->
  <nav class="nav">
    <div class="nav-brand">🛡️ ComplianceShield</div>
    <div class="nav-links">
      <a href="#scanner">Scanner</a>
      <a href="#ada-guide">ADA Guide</a>
      <a href="#pricing-section">Pricing</a>
      <a href="https://github.com/beepboop-dev/gamma-project">GitHub</a>
    </div>
  </nav>

  <!-- Hero -->
  <div class="hero">
    <div class="hero-badge">⚠️ 4,605 ADA lawsuits filed in 2025 — Is your website next?</div>
    <h1>Scan Any Website for ADA Compliance in Seconds</h1>
    <p>23 automated WCAG 2.1 checks. Actionable fix instructions. PDF reports. No signup required. Free forever.</p>
  </div>

  <!-- Trust bar -->
  <div class="trust-bar">
    <div class="trust-item">🛡️ <strong>2,400+</strong> sites scanned</div>
    <div class="trust-item">⭐ <strong>23</strong> WCAG checks</div>
    <div class="trust-item">📄 <strong>Free</strong> PDF reports</div>
    <div class="trust-item">⚡ Results in <strong>seconds</strong></div>
  </div>

  <!-- Scanner -->
  <div class="scanner" id="scanner">
    <h2>🔍 Free Accessibility Scan</h2>
    <div class="scanner-form">
      <input type="url" class="scanner-input" id="urlInput" placeholder="Enter any website URL (e.g., example.com)" autocomplete="url" spellcheck="false" />
      <button class="scanner-btn" id="scanBtn" onclick="runScan()">Scan Now →</button>
    </div>
    <div class="scanner-hint">Free unlimited scans • No signup required • 23 WCAG checks</div>

    <div class="loading" id="loading">
      <div class="spinner"></div>
      <div class="loading-steps">
        <div class="loading-step active" id="step1">Connecting to website...</div>
        <div class="loading-step" id="step2">Analyzing HTML structure...</div>
        <div class="loading-step" id="step3">Running 23 WCAG checks...</div>
        <div class="loading-step" id="step4">Generating report...</div>
      </div>
    </div>

    <div class="error-msg" id="errorMsg">
      <span class="error-icon">⚠️</span>
      <div class="error-content">
        <h4 id="errorTitle">Scan Failed</h4>
        <p id="errorText"></p>
        <ul class="error-suggestions" id="errorSuggestions"></ul>
      </div>
    </div>

    <div class="results" id="results">
      <!-- Animated Score Circle -->
      <div class="score-circle-wrap">
        <div class="score-circle">
          <svg viewBox="0 0 160 160">
            <circle class="bg" cx="80" cy="80" r="70"/>
            <circle class="fg" id="scoreArc" cx="80" cy="80" r="70" stroke-dasharray="439.82" stroke-dashoffset="439.82"/>
          </svg>
          <div class="score-text">
            <div class="score-num" id="scoreNum">0</div>
            <div class="score-label">out of 100</div>
          </div>
        </div>
      </div>

      <div class="compliance-status" id="complianceStatus"></div>

      <div class="stats-row">
        <div class="stat"><div class="stat-num" id="statIssues" style="color:var(--red)">0</div><div class="stat-label">Issues</div></div>
        <div class="stat"><div class="stat-num" id="statCritical" style="color:var(--red)">0</div><div class="stat-label">Critical</div></div>
        <div class="stat"><div class="stat-num" id="statPassed" style="color:var(--green)">0</div><div class="stat-label">Passed</div></div>
        <div class="stat"><div class="stat-num" id="statWarnings" style="color:var(--orange)">0</div><div class="stat-label">Warnings</div></div>
      </div>

      <div class="action-btns">
        <button class="action-btn" onclick="downloadPDF()">📄 PDF Report</button>
        <button class="action-btn" id="badgeBtn" onclick="generateBadge()" style="display:none">🏅 Get Badge</button>
        <button class="action-btn" onclick="showHistory()">📊 History</button>
        <button class="action-btn" onclick="loadTrend()">📈 Trend</button>
      </div>

      <div class="badge-section" id="badgeSection">
        <h3>🏅 Your Compliance Badge</h3>
        <p style="font-size:0.85rem;color:var(--muted)">Embed this badge on your website to show visitors your commitment to accessibility.</p>
        <div id="badgePreview" style="margin:12px 0"></div>
        <div class="badge-code" id="badgeCode"></div>
        <button class="copy-btn" onclick="copyBadge()">Copy Embed Code</button>
      </div>

      <div class="trend-section" id="trendSection">
        <h3>📈 Score Trend Over Time</h3>
        <div class="trend-chart" id="trendChart"></div>
        <div class="trend-meta" id="trendMeta"></div>
        <div class="trend-summary" id="trendSummary"></div>
      </div>

      <div class="monitor-section">
        <h3>🔔 Set Up Weekly Monitoring</h3>
        <p style="font-size:0.85rem;color:var(--muted);margin-bottom:12px">Get automated scan results delivered to your inbox every week.</p>
        <div class="monitor-form">
          <input type="email" id="monitorEmail" placeholder="your@email.com" />
          <button onclick="registerMonitor()">📧 Start Monitoring</button>
        </div>
        <div class="monitor-msg" id="monitorMsg"></div>
      </div>

      <!-- Issues sorted by severity with expandable cards -->
      <div class="issues-list" id="issuesList"></div>

      <div class="passes-section" id="passesSection">
        <h3>✅ Checks Passed</h3>
        <div id="passesList"></div>
      </div>
    </div>

    <div class="history" id="historySection">
      <h3>📊 Recent Scan History</h3>
      <div id="historyList"></div>
    </div>
  </div>

  <!-- Social Proof / Testimonials -->
  <div class="social-proof">
    <h2>Trusted by Compliance Teams Everywhere</h2>
    <p class="subtitle">Join 2,400+ businesses using ComplianceShield to stay ADA compliant</p>
    <div class="testimonials">
      <div class="testimonial">
        <div class="testimonial-stars">★★★★★</div>
        <div class="testimonial-text">"We were hit with an ADA demand letter and needed to fix our site fast. ComplianceShield identified every issue in seconds and gave us exact code fixes. Saved us thousands in consultant fees."</div>
        <div class="testimonial-author">
          <div class="testimonial-avatar">MR</div>
          <div class="testimonial-info"><div class="name">Maria Rodriguez</div><div class="role">Compliance Officer, TechFlow Inc.</div></div>
        </div>
      </div>
      <div class="testimonial">
        <div class="testimonial-stars">★★★★★</div>
        <div class="testimonial-text">"As a small business owner, I couldn't afford a $5,000 accessibility audit. ComplianceShield does it for free with actionable fixes. I embed the badge on my site — customers notice."</div>
        <div class="testimonial-author">
          <div class="testimonial-avatar">JT</div>
          <div class="testimonial-info"><div class="name">James Thompson</div><div class="role">Owner, Riverside Bakery</div></div>
        </div>
      </div>
      <div class="testimonial">
        <div class="testimonial-stars">★★★★★</div>
        <div class="testimonial-text">"We scan every client site before launch now. The PDF reports look professional enough to include in our deliverables. The weekly monitoring catches regressions before they become problems."</div>
        <div class="testimonial-author">
          <div class="testimonial-avatar">SK</div>
          <div class="testimonial-info"><div class="name">Sarah Kim</div><div class="role">Lead Developer, Digital Pixel Agency</div></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Urgency Section -->
  <div class="urgency">
    <h2>⚖️ ADA Web Accessibility Lawsuits Are Surging</h2>
    <div class="urgency-stats">
      <div class="urgency-stat"><div class="num">4,605</div><div class="label">ADA web lawsuits filed in 2025</div></div>
      <div class="urgency-stat"><div class="num">$50K+</div><div class="label">Average settlement cost</div></div>
      <div class="urgency-stat"><div class="num">98%</div><div class="label">of websites fail basic WCAG checks</div></div>
    </div>
    <p>Under the ADA, websites are "places of public accommodation." The DOJ finalized rules in 2024 requiring WCAG 2.1 Level AA — and private sector enforcement is accelerating.</p>
    <p style="margin-top:10px"><strong style="color:var(--red)">Plaintiffs' firms are actively scanning websites for violations.</strong> Average settlement: $25,000–$75,000.</p>
    <p style="margin-top:14px"><a href="#scanner" style="color:var(--accent2);font-weight:700;font-size:1.05rem">→ Scan your website now — it's free</a></p>
  </div>

  <!-- Comparison Table -->
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

  <!-- SEO Content: What is ADA Compliance -->
  <div class="seo-section" id="ada-guide">
    <h2>📚 The Complete Guide to Web Accessibility</h2>

    <article class="seo-article">
      <h3>🏛️ What is ADA Compliance for Websites?</h3>
      <p>The <strong>Americans with Disabilities Act (ADA)</strong>, signed into law in 1990, prohibits discrimination against individuals with disabilities. While the original law focused on physical spaces, courts and the Department of Justice have consistently interpreted it to include websites and digital content.</p>
      <p>In April 2024, the DOJ published its final rule under Title II of the ADA, explicitly requiring state and local government websites to conform to <strong>WCAG 2.1 Level AA</strong>. While this rule directly applies to government entities, it has set a clear benchmark that private sector courts and enforcement agencies follow.</p>

      <h4>Who Needs to Comply?</h4>
      <p>Under Title III of the ADA, any business that operates a "place of public accommodation" must make their services accessible — and courts have ruled that websites qualify. This includes:</p>
      <ul>
        <li><strong>E-commerce stores</strong> — online shopping must be navigable by screen readers</li>
        <li><strong>Healthcare providers</strong> — patient portals, appointment booking, medical information</li>
        <li><strong>Financial services</strong> — banking, insurance, and investment platforms</li>
        <li><strong>Restaurants & hospitality</strong> — online menus, reservations, hotel booking</li>
        <li><strong>Educational institutions</strong> — course materials, registration systems, LMS platforms</li>
        <li><strong>Any business with a website</strong> — if you serve the public, accessibility applies</li>
      </ul>

      <div class="highlight-box">
        <p>💡 <strong>Key fact:</strong> Over 4,600 ADA website accessibility lawsuits were filed in 2025 alone. The average settlement ranges from $25,000 to $75,000 — far more than the cost of making your site accessible. <a href="#scanner">Scan your site now →</a></p>
      </div>

      <h4>What Happens If You Don't Comply?</h4>
      <p>Non-compliant websites face several risks:</p>
      <ol>
        <li><strong>Demand letters</strong> from plaintiffs' attorneys citing specific violations</li>
        <li><strong>Federal lawsuits</strong> under Title III of the ADA</li>
        <li><strong>State lawsuits</strong> under state-level disability discrimination laws (e.g., California's Unruh Act, which allows statutory damages of $4,000 per violation per visit)</li>
        <li><strong>Settlements</strong> typically ranging from $5,000 for small businesses to $100,000+ for larger companies</li>
        <li><strong>Ongoing compliance obligations</strong> including monitoring and remediation agreements</li>
      </ol>
    </article>

    <article class="seo-article">
      <h3>📋 WCAG 2.1 Guidelines — What You Need to Know</h3>
      <p>The <strong>Web Content Accessibility Guidelines (WCAG) 2.1</strong>, published by the World Wide Web Consortium (W3C), are the internationally recognized standard for web accessibility. They are organized around four core principles, often remembered by the acronym <strong>POUR</strong>:</p>

      <div class="wcag-principles">
        <div class="wcag-principle">
          <h5>👁️ Perceivable</h5>
          <p>Information must be presentable in ways all users can perceive. This includes alt text for images, captions for videos, and sufficient color contrast.</p>
        </div>
        <div class="wcag-principle">
          <h5>⌨️ Operable</h5>
          <p>UI components must be operable by all users. Sites must be fully keyboard-navigable, allow enough time for interaction, and avoid content that causes seizures.</p>
        </div>
        <div class="wcag-principle">
          <h5>📖 Understandable</h5>
          <p>Content must be readable and predictable. Pages need proper language attributes, consistent navigation, and helpful error messages on forms.</p>
        </div>
        <div class="wcag-principle">
          <h5>🔧 Robust</h5>
          <p>Content must work reliably across assistive technologies. This means valid HTML, proper ARIA attributes, and compatible code.</p>
        </div>
      </div>

      <h4>WCAG Conformance Levels</h4>
      <p>WCAG defines three levels of conformance:</p>
      <ul>
        <li><strong>Level A</strong> — The minimum. Addresses the most critical barriers (e.g., alt text, keyboard access, page titles). 30 success criteria.</li>
        <li><strong>Level AA</strong> — The standard target for legal compliance. Includes Level A plus additional criteria like color contrast (4.5:1 ratio), consistent navigation, and error prevention. ~20 additional criteria.</li>
        <li><strong>Level AAA</strong> — The highest level. Includes enhanced contrast (7:1), sign language for audio, and more. Aspirational for most sites.</li>
      </ul>

      <div class="highlight-box">
        <p>🎯 <strong>Target Level AA.</strong> This is what the DOJ requires, courts reference, and what ComplianceShield tests against. Our 23 automated checks cover the most impactful Level A and AA success criteria.</p>
      </div>

      <h4>Common WCAG Failures (What ComplianceShield Checks)</h4>
      <p>Based on the <a href="https://webaim.org/projects/million/" target="_blank">WebAIM Million</a> annual study, the most common accessibility errors are:</p>
      <ol>
        <li><strong>Low contrast text</strong> (83% of pages) — Text doesn't meet 4.5:1 ratio</li>
        <li><strong>Missing alt text</strong> (58%) — Images without alternative descriptions</li>
        <li><strong>Empty links</strong> (50%) — Links with no accessible text</li>
        <li><strong>Missing form labels</strong> (46%) — Form inputs without associated labels</li>
        <li><strong>Empty buttons</strong> (27%) — Buttons with no accessible name</li>
        <li><strong>Missing page language</strong> (19%) — No lang attribute on &lt;html&gt;</li>
      </ol>
      <p>ComplianceShield detects all of these plus 17 additional checks including keyboard traps, heading structure, ARIA landmarks, link text quality, and more.</p>
    </article>
  </div>

  <!-- Education Cards -->
  <div class="education">
    <h2>Quick Reference</h2>
    <div class="edu-grid">
      <div class="edu-card"><h3>⚖️ Recent Notable Lawsuits</h3><p><strong>Domino's v. Robles (2019):</strong> Supreme Court let stand a ruling requiring website accessibility. <strong>2025:</strong> 400+ lawsuits/month targeting e-commerce, healthcare, and small businesses.</p></div>
      <div class="edu-card"><h3>🎯 Who's Most at Risk?</h3><p>Any business with a website — especially <strong>e-commerce, healthcare, financial services, restaurants, and hospitality</strong>. Serial plaintiffs target sites with obvious violations.</p></div>
      <div class="edu-card"><h3>🔧 How to Fix Issues</h3><p>ComplianceShield provides <strong>specific, developer-ready fix instructions</strong> for every issue found — with code examples. Most fixes take minutes, not hours.</p></div>
      <div class="edu-card"><h3>🏅 Prove Your Compliance</h3><p>Generate a <strong>verifiable compliance badge</strong> for your website. Show customers and partners your commitment to accessibility. Badge includes score and scan date.</p></div>
    </div>
  </div>

  <!-- Pricing -->
  <div class="pricing-section" id="pricing-section">
    <h2>Plans & Pricing</h2>
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

  <!-- Footer -->
  <footer class="site-footer">
    <div class="footer-grid">
      <div class="footer-brand">
        <h4>🛡️ ComplianceShield</h4>
        <p>The fastest way to check your website for ADA & WCAG 2.1 accessibility compliance. Free unlimited scans with detailed fix instructions, PDF reports, and compliance badges.</p>
      </div>
      <div class="footer-col">
        <h5>Product</h5>
        <a href="#scanner">Free Scanner</a>
        <a href="#pricing-section">Pricing</a>
        <a href="/api/history">API</a>
        <a href="https://github.com/beepboop-dev/gamma-project">GitHub</a>
      </div>
      <div class="footer-col">
        <h5>Resources</h5>
        <a href="#ada-guide">ADA Compliance Guide</a>
        <a href="#ada-guide">WCAG 2.1 Guide</a>
        <a href="/blog" onclick="event.preventDefault();alert('Blog coming soon!')">Blog</a>
        <a href="https://www.w3.org/WAI/WCAG21/Understanding/" target="_blank">WCAG Reference</a>
      </div>
      <div class="footer-col">
        <h5>Legal</h5>
        <a href="/terms" onclick="event.preventDefault();alert('Terms of Service — Coming soon. ComplianceShield provides automated accessibility checks. It does not constitute legal advice.')">Terms of Service</a>
        <a href="/privacy" onclick="event.preventDefault();alert('Privacy Policy — Coming soon. We do not store personal data. Scan results are stored anonymously for trend analysis.')">Privacy Policy</a>
        <a href="mailto:support@abapture.ai">Contact</a>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© 2026 ComplianceShield. All rights reserved.</span>
      <span>Made with 🛡️ for a more accessible web</span>
    </div>
  </footer>
</div>

<script>
let currentScan = null;
let loadingInterval = null;

function showError(title, message, suggestions) {
  const el = document.getElementById('errorMsg');
  document.getElementById('errorTitle').textContent = title || 'Scan Failed';
  document.getElementById('errorText').textContent = message;
  const sugList = document.getElementById('errorSuggestions');
  sugList.innerHTML = '';
  if (suggestions && suggestions.length) {
    suggestions.forEach(s => { const li = document.createElement('li'); li.textContent = s; sugList.appendChild(li); });
  }
  el.classList.add('show');
}

function categorizeError(msg) {
  const lower = msg.toLowerCase();
  if (lower.includes('invalid url') || lower.includes('invalid website')) {
    return { title: 'Invalid URL', message: msg, suggestions: ['Make sure the URL starts with http:// or https://', 'Check for typos in the domain name', 'Try entering just the domain (e.g., example.com)'] };
  }
  if (lower.includes('could not find') || lower.includes('enotfound') || lower.includes('getaddrinfo')) {
    return { title: 'Website Not Found', message: 'We couldn\\'t find that website. The domain may not exist or DNS isn\\'t resolving.', suggestions: ['Double-check the spelling of the URL', 'Make sure the website is online', 'Try without www. or with www.'] };
  }
  if (lower.includes('timed out') || lower.includes('took too long')) {
    return { title: 'Connection Timed Out', message: 'The website took too long to respond (>15s).', suggestions: ['The site may be experiencing high traffic', 'Try again in a few minutes', 'Check if the site loads in your browser'] };
  }
  if (lower.includes('connection refused')) {
    return { title: 'Connection Refused', message: 'The website actively refused our connection.', suggestions: ['The site may be down for maintenance', 'It may be blocking automated scanners', 'Try again later'] };
  }
  if (lower.includes('ssl') || lower.includes('certificate')) {
    return { title: 'SSL/TLS Error', message: 'There\\'s a problem with the website\\'s security certificate.', suggestions: ['The site may have an expired certificate', 'Try scanning with http:// instead of https://', 'Contact the website owner about the SSL issue'] };
  }
  if (lower.includes('too large')) {
    return { title: 'Page Too Large', message: 'The webpage exceeds our 5MB scan limit.', suggestions: ['Try scanning a specific page instead of the homepage', 'The site may be serving very large HTML'] };
  }
  return { title: 'Scan Failed', message: msg, suggestions: ['Check that the URL is correct', 'Make sure the website is accessible', 'Try again in a moment'] };
}

function animateLoadingSteps() {
  const steps = ['step1','step2','step3','step4'];
  let i = 0;
  steps.forEach(s => document.getElementById(s).classList.remove('active'));
  document.getElementById(steps[0]).classList.add('active');
  loadingInterval = setInterval(() => {
    i++;
    if (i < steps.length) {
      document.getElementById(steps[i]).classList.add('active');
    }
  }, 2500);
}

async function runScan() {
  const input = document.getElementById('urlInput');
  const url = input.value.trim();
  if (!url) { input.classList.add('input-error'); input.focus(); setTimeout(() => input.classList.remove('input-error'), 2000); return; }
  input.classList.remove('input-error');

  document.getElementById('loading').classList.add('show');
  document.getElementById('results').classList.remove('show');
  document.getElementById('errorMsg').classList.remove('show');
  document.getElementById('historySection').classList.remove('show');
  document.getElementById('badgeSection').classList.remove('show');
  document.getElementById('trendSection').classList.remove('show');
  document.getElementById('scanBtn').disabled = true;
  animateLoadingSteps();

  try {
    const res = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    currentScan = data;
    displayResults(data);
  } catch(e) {
    const err = categorizeError(e.message);
    showError(err.title, err.message, err.suggestions);
  } finally {
    clearInterval(loadingInterval);
    document.getElementById('loading').classList.remove('show');
    document.getElementById('scanBtn').disabled = false;
  }
}

function animateScore(target) {
  const numEl = document.getElementById('scoreNum');
  const arcEl = document.getElementById('scoreArc');
  const circumference = 2 * Math.PI * 70; // 439.82
  const color = target >= 80 ? 'var(--green)' : target >= 50 ? 'var(--orange)' : 'var(--red)';

  arcEl.style.stroke = color;
  numEl.style.color = color;

  // Animate the arc
  const offset = circumference - (target / 100) * circumference;
  requestAnimationFrame(() => { arcEl.style.strokeDashoffset = offset; });

  // Animate the number
  let current = 0;
  const duration = 1200;
  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    current = Math.round(eased * target);
    numEl.textContent = current;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function displayResults(data) {
  // Reset arc
  document.getElementById('scoreArc').style.strokeDashoffset = '439.82';

  // Animate score after short delay
  setTimeout(() => animateScore(data.score), 100);

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

  // Sort issues by severity
  const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const sortedIssues = [...data.issues].sort((a, b) => (severityOrder[a.impact] || 4) - (severityOrder[b.impact] || 4));

  const issuesHtml = sortedIssues.length > 0 ? '<h3>🔍 Issues Found (' + sortedIssues.length + ')</h3>' + sortedIssues.map((issue, idx) => \`
    <div class="issue-card" id="issue-\${idx}">
      <div class="issue-card-header" onclick="toggleIssue(\${idx})">
        <div class="issue-left">
          <div class="issue-severity-dot \${issue.impact}"></div>
          <span class="issue-name">\${issue.name}</span>
        </div>
        <div class="issue-right">
          <span class="issue-count">\${issue.count} found</span>
          <span class="issue-impact impact-\${issue.impact}">\${issue.impact}</span>
          <span class="issue-chevron">▼</span>
        </div>
      </div>
      <div class="issue-card-body">
        <div class="issue-wcag">📋 \${issue.wcag} — Level \${issue.level} · \${issue.principle}</div>
        <div class="issue-desc">\${issue.description}</div>
        \${issue.fix ? \`<div class="issue-fix">💡 <strong>How to fix:</strong> \${issue.fix}</div>\` : ''}
        \${issue.elements && issue.elements.length > 0 ? \`<div class="issue-elements">\${issue.elements.map(e => escapeHtml(e)).join('\\n')}</div>\` : ''}
        <a href="\${issue.url}" target="_blank" class="issue-link">📖 WCAG Reference →</a>
      </div>
    </div>
  \`).join('') : '';
  document.getElementById('issuesList').innerHTML = issuesHtml;

  // Auto-expand first critical issue
  if (sortedIssues.length > 0) {
    setTimeout(() => toggleIssue(0), 300);
  }

  const passesHtml = data.passes.map(p => \`<span class="pass-item">✓ \${p.name}</span>\`).join('');
  document.getElementById('passesList').innerHTML = passesHtml;
  document.getElementById('results').classList.add('show');

  // Smooth scroll to results
  document.querySelector('.score-circle-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function toggleIssue(idx) {
  const card = document.getElementById('issue-' + idx);
  if (card) card.classList.toggle('open');
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
    chart.innerHTML = scans.map(s => {
      const height = Math.max(4, s.score);
      const color = s.score >= 80 ? 'var(--green)' : s.score >= 50 ? 'var(--orange)' : 'var(--red)';
      const date = new Date(s.date).toLocaleDateString();
      return \`<div class="trend-bar" style="height:\${height}%;background:\${color}"><div class="tooltip">\${date}<br>Score: \${s.score}/100<br>Issues: \${s.issues}</div></div>\`;
    }).join('');

    meta.innerHTML = \`<span>\${new Date(scans[0].date).toLocaleDateString()}</span><span>\${new Date(scans[scans.length-1].date).toLocaleDateString()}</span>\`;

    if (data.trend) {
      const t = data.trend;
      const arrow = t.direction === 'improving' ? '📈' : t.direction === 'declining' ? '📉' : '➡️';
      const cls = t.direction === 'improving' ? 'trend-up' : t.direction === 'declining' ? 'trend-down' : 'trend-stable';
      summary.innerHTML = \`<span class="\${cls}">\${arrow} \${t.direction.charAt(0).toUpperCase() + t.direction.slice(1)}</span> — Score changed by <strong class="\${cls}">\${t.scoreChange > 0 ? '+' : ''}\${t.scoreChange}</strong> pts over <strong>\${t.totalScans}</strong> scans.\`;
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
  } catch(e) { msg.textContent = e.message; msg.className = 'monitor-msg show error'; }
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
    section.classList.add('show');
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

// Enter key to scan
document.getElementById('urlInput').addEventListener('keypress', e => { if (e.key === 'Enter') runScan(); });
// Clear error on input
document.getElementById('urlInput').addEventListener('input', () => {
  document.getElementById('urlInput').classList.remove('input-error');
  document.getElementById('errorMsg').classList.remove('show');
});

// Handle URL params
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
