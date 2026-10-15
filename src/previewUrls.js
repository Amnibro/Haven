'use strict';

// A page decides what its og:image, twitter:image or oEmbed thumbnail says,
// so each one is resolved against the page it came from and kept only when it
// is http(s). Clients never see a javascript:, data: or relative URL.

function absoluteHttpUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let resolved;
  try { resolved = new URL(value.trim(), base); } catch { return null; } // unparseable: dropped like any other bad URL
  return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
}

function cleanPreviewUrls(data, base) {
  if (!data) return data;
  for (const key of ['image', 'avatar', 'video']) {
    if (data[key] !== undefined && data[key] !== null) data[key] = absoluteHttpUrl(data[key], base);
  }
  if (Array.isArray(data.images)) {
    const images = data.images.map(img => absoluteHttpUrl(img, base)).filter(Boolean);
    data.images = images.length >= 2 ? images : undefined;
  }
  data.url = absoluteHttpUrl(data.url, base) || base;
  return data;
}

module.exports = { absoluteHttpUrl, cleanPreviewUrls };
