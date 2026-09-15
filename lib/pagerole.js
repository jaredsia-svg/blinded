// Page-role classification from OCR layout (and optional text-layer items).
//
// Does not change how pages are read. OCR and the PDF text layer stay the
// primary pass. Roles are a map of regions used afterwards — mainly so
// detectors can ignore chart/logo-grid ink that only looks like PII.
//
// Roles: chart | body | contact | logo_grid | other
(function (root) {
  'use strict';

  const ROLES = ['chart', 'body', 'contact', 'logo_grid', 'other'];

  // Contact-block cues (same idea as detect.js labels, kept local so this
  // module does not depend on detector internals).
  const CONTACT_CUE = /^(?:T|M|E|D|F|P|Tel|Mob|Mobile|Cell|Email|E-?mail|Phone|Fax|Direct|DID|Office)\s*[:.]/i;
  const CONTACT_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+\d[\d\s().-]{7,}/;
  const ROLE_LINE = /\b(?:Director|Partner|Manager|Officer|President|Associate|Analyst|Counsel)\b/i;

  function pad(rect, amount, width, height) {
    const x = Math.max(0, Math.floor(rect.x - amount));
    const y = Math.max(0, Math.floor(rect.y - amount));
    const r = Math.min(width, Math.ceil(rect.x + rect.w + amount));
    const b = Math.min(height, Math.ceil(rect.y + rect.h + amount));
    return { x: x, y: y, w: Math.max(1, r - x), h: Math.max(1, b - y) };
  }

  function center(rect) {
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }

  function containsPoint(region, pt) {
    return pt.x >= region.x && pt.x <= region.x + region.w
      && pt.y >= region.y && pt.y <= region.y + region.h;
  }

  function overlapFraction(a, b) {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    const inter = (x1 - x0) * (y1 - y0);
    const area = Math.max(1, a.w * a.h);
    return inter / area;
  }

  function tokenKind(str) {
    const t = String(str || '').trim();
    if (!t) return 'empty';
    const compact = t.replace(/[,\s]/g, '');
    if (/^\d{1,6}([.]\d+)?%?$/.test(compact)) return 'digit';
    if (/^\d{1,3}([,]\d{3})+$/.test(t.replace(/\s/g, ''))) return 'digit';
    if (CONTACT_CUE.test(t) || CONTACT_VALUE.test(t)) return 'contact';
    if (ROLE_LINE.test(t)) return 'role';
    // Brand / badge fragments on logo collages are often 4–6 letters.
    if (t.length <= 6 && /[A-Za-z]/.test(t) && !/\s/.test(t)) return 'short';
    if (t.split(/\s+/).length >= 4 || t.length >= 24) return 'long';
    return 'word';
  }

  // Cluster placed words into spatial groups by proximity, then label each.
  function clusterItems(items, pageW, pageH) {
    const boxes = [];
    for (const item of items) {
      const rect = item.rect || { x: item.x, y: item.y - (item.h || 10), w: item.w, h: item.h || 10 };
      if (!rect || !(rect.w > 0) || !(rect.h > 0)) continue;
      const str = item.str != null ? item.str : (item.text || '');
      boxes.push({
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
        str: str,
        kind: tokenKind(str),
      });
    }
    if (!boxes.length) return [];

    const gapX = Math.max(24, pageW * 0.04);
    const gapY = Math.max(18, pageH * 0.03);
    const parent = boxes.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const unite = (a, b) => {
      a = find(a);
      b = find(b);
      if (a !== b) parent[a] = b;
    };

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].rect;
        const b = boxes[j].rect;
        const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
        const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
        if (dx <= gapX && dy <= gapY) unite(i, j);
      }
    }

    const groups = new Map();
    for (let i = 0; i < boxes.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(boxes[i]);
    }
    return Array.from(groups.values());
  }

  function labelCluster(cluster, pageW, pageH) {
    const n = cluster.length;
    let digits = 0;
    let contact = 0;
    let roles = 0;
    let shorts = 0;
    let longs = 0;
    let words = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    for (const box of cluster) {
      const r = box.rect;
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.w > maxX) maxX = r.x + r.w;
      if (r.y + r.h > maxY) maxY = r.y + r.h;
      if (box.kind === 'digit') digits++;
      else if (box.kind === 'contact') contact++;
      else if (box.kind === 'role') roles++;
      else if (box.kind === 'short') shorts++;
      else if (box.kind === 'long') longs++;
      else words++;
    }
    const rect = {
      x: minX, y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
    };
    const digitShare = digits / n;
    const shortShare = (shorts + digits) / n;
    const areaShare = (rect.w * rect.h) / Math.max(1, pageW * pageH);

    // Contact: explicit phone/email/tel labels, or role lines with few digits.
    if (contact >= 1 || (roles >= 1 && digitShare < 0.35 && n <= 12)) {
      return { role: 'contact', score: 0.85 + Math.min(0.1, contact * 0.05), rect: rect, n: n };
    }

    // Chart: digit-heavy cluster (axis labels, bar values). Need enough tokens
    // so a single year in body text is not a chart.
    if (n >= 4 && digitShare >= 0.55) {
      return { role: 'chart', score: 0.7 + Math.min(0.25, digitShare), rect: rect, n: n };
    }
    if (n >= 6 && digitShare >= 0.4 && areaShare >= 0.08) {
      return { role: 'chart', score: 0.65, rect: rect, n: n };
    }

    // Logo grid: many tiny fragments, little continuous prose.
    if (n >= 8 && shortShare >= 0.5 && longs === 0 && digitShare < 0.45) {
      return { role: 'logo_grid', score: 0.7, rect: rect, n: n };
    }

    // Body: longer runs of words.
    if (longs >= 1 || (words >= 3 && digitShare < 0.3 && shortShare < 0.5)) {
      return { role: 'body', score: 0.7, rect: rect, n: n };
    }

    return { role: 'other', score: 0.4, rect: rect, n: n };
  }

  function pageHintFrom(regions) {
    if (!regions.length) return 'other';
    const weight = { contact: 0, chart: 0, body: 0, logo_grid: 0, other: 0 };
    for (const r of regions) {
      const area = r.rect.w * r.rect.h;
      weight[r.role] = (weight[r.role] || 0) + area * (r.score || 1);
    }
    let best = 'other';
    let bestW = -1;
    for (const role of ROLES) {
      if ((weight[role] || 0) > bestW) {
        bestW = weight[role] || 0;
        best = role;
      }
    }
    return best;
  }

  // items: OCR placed words ({str, rect|x,y,w,h}) or similar text-layer boxes.
  function classify(items, pageW, pageH) {
    const width = Math.max(1, pageW | 0);
    const height = Math.max(1, pageH | 0);
    const clusters = clusterItems(items || [], width, height);
    const regions = clusters.map(c => labelCluster(c, width, height))
      .filter(r => r.n >= 2 || r.role === 'contact');
    // Pad a little so a detector box on the edge of a chart still counts.
    for (const r of regions) {
      r.rect = pad(r.rect, 8, width, height);
    }
    return {
      regions: regions,
      pageHint: pageHintFrom(regions),
      width: width,
      height: height,
    };
  }

  // Kinds that are unsafe inside chart / logo-grid ink (shape-lookalikes).
  // Emails and URLs stay — an @ in a chart legend is still an email.
  const SUPPRESS_IN = {
    chart: { phone: true, address: true },
    logo_grid: { phone: true, person: true },
  };

  function roleAt(roles, rect) {
    if (!roles || !roles.regions || !roles.regions.length || !rect) return null;
    const pt = center(rect);
    let best = null;
    let bestOverlap = 0;
    for (const region of roles.regions) {
      if (containsPoint(region.rect, pt)) {
        if (!best || region.score > best.score) best = region;
      }
      const o = overlapFraction(rect, region.rect);
      if (o > bestOverlap) {
        bestOverlap = o;
        if (o >= 0.5) best = region;
      }
    }
    return best;
  }

  // Drop detector proposals that sit in regions where that kind is unreliable.
  // Never suppresses typed terms. Never changes OCR.
  function allowDetector(roles, kind, rect) {
    if (!kind || kind === 'term' || kind === 'email' || kind === 'url') return true;
    const hit = roleAt(roles, rect);
    if (!hit) return true;
    const ban = SUPPRESS_IN[hit.role];
    if (ban && ban[kind]) return false;
    return true;
  }

  // Union of rects for a multi-word detector hit.
  function unionRects(rects) {
    if (!rects || !rects.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    for (const r of rects) {
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.w > maxX) maxX = r.x + r.w;
      if (r.y + r.h > maxY) maxY = r.y + r.h;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  root.BlindedPageRole = {
    ROLES,
    classify,
    roleAt,
    allowDetector,
    unionRects,
    tokenKind,
  };
})(typeof window !== 'undefined' ? window : globalThis);
