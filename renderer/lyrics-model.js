(function(root) {
  function parseLrc(text) {
    const rows = [];
    const offset = Number(String(text).match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
    for (const line of String(text || '').split(/\r?\n/)) {
      const times = [...line.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g)];
      const words = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const time of times) if (words) rows.push({ time: Math.max(0, Number(time[1]) * 60 + Number(time[2]) - offset), text: words });
    }
    return rows.sort((a,b) => a.time - b.time);
  }
  const api = { parseLrc };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LyricsModel = api;
})(globalThis);
