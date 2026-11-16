'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const extensions = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus']);

function createMusicLibrary(directory) {
  const indexFile = path.join(directory, 'music-library.json');
  const coverDirectory = path.join(directory, 'local-covers');
  let state;
  let scanning = null;
  function load() {
    if (state) return;
    try { state = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (_) {}
    if (!state || !state.files || !Array.isArray(state.roots)) state = { roots: [], files: {} };
  }
  function persist(next) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(indexFile + '.tmp', JSON.stringify(next));
    fs.renameSync(indexFile + '.tmp', indexFile);
    state = next;
  }
  function list() {
    load();
    return Object.values(state.files).map(entry => entry.item).sort((a, b) =>
      (a.artist || '').localeCompare(b.artist || '', 'zh-CN') ||
      (a.album || '').localeCompare(b.album || '', 'zh-CN') ||
      (a.trackNumber || 0) - (b.trackNumber || 0) || a.title.localeCompare(b.title, 'zh-CN'));
  }
  async function scan(root, onProgress) {
    load();
    if (scanning) return scanning;
    scanning = (async () => {
      const { parseFile } = await import('music-metadata');
      const paths = [], warnings = [];
      async function collect(folder) {
        const entries = await fs.promises.readdir(folder, { withFileTypes: true });
        for (const entry of entries) {
          const file = path.join(folder, entry.name);
          if (entry.isDirectory()) {
            try { await collect(file); } catch (_) { warnings.push('无法读取文件夹 ' + file); }
          } else if (entry.isFile() && extensions.has(path.extname(file).toLowerCase())) paths.push(file);
        }
      }
      await collect(root);
      const files = { ...state.files }, found = new Set();
      fs.mkdirSync(coverDirectory, { recursive: true });
      for (const [i, file] of paths.entries()) {
        const id = createHash('sha256').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 32);
        found.add(id);
        try {
          const stat = await fs.promises.stat(file);
          if (files[id]?.mtime !== stat.mtimeMs || files[id]?.size !== stat.size) {
            const metadata = await parseFile(file, { duration: true });
            if (!metadata.format.container || metadata.format.hasAudio === false) throw new Error('无法识别音频格式');
            const tags = metadata.common;
            const item = { localId: id, title: tags.title || path.basename(file, path.extname(file)),
              artist: tags.artist || '', album: tags.album || '', trackNumber: tags.track?.no || 0,
              duration: metadata.format.duration || 0, identifySource: 'local', page: 1, partsCount: 1 };
            const picture = tags.picture?.find(p => /image\/(?:jpeg|png)/i.test(p.format));
            if (picture) {
              const image = path.join(coverDirectory, id + (picture.format.toLowerCase().includes('png') ? '.png' : '.jpg'));
              await fs.promises.writeFile(image, picture.data);
              item.cover = pathToFileURL(image).href;
            }
            files[id] = { path: file, item, mtime: stat.mtimeMs, size: stat.size };
          }
        } catch (_) { warnings.push(path.basename(file)); }
        onProgress?.({ done: i + 1, total: paths.length, title: path.basename(file) });
      }
      const prefix = path.resolve(root).toLowerCase() + path.sep;
      for (const [id, entry] of Object.entries(files)) {
        if (entry.path.toLowerCase().startsWith(prefix) && !found.has(id)) {
          try { await fs.promises.access(entry.path); } catch (_) { delete files[id]; }
        }
      }
      persist({ roots: [...new Set([...state.roots, root])], files });
      return { items: list(), warnings };
    })();
    try { return await scanning; } finally { scanning = null; }
  }
  async function find(item) {
    load();
    const file = state.files[item?.localId]?.path;
    if (!file) return null;
    try {
      const stat = await fs.promises.stat(file);
      if (stat.isFile() && stat.size) return { url: pathToFileURL(file).href, local: true, codecs: path.extname(file).slice(1).toUpperCase() };
    } catch (_) {}
    return null;
  }
  return { list, scan, find, file: item => { load(); return state.files[item?.localId]?.path; } };
}
module.exports = { createMusicLibrary };
