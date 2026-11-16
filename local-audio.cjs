'use strict';
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
function audioKey(item) {
  return JSON.stringify([item?.bvid, Number(item?.page || 1), item?.split ? [item.startSec, item.endSec] : null]);
}
function createLocalAudioStore(indexFile) {
  let files;
  function load() {
    if (files) return;
    try { files = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { files = {}; }
  }
  return {
    remember(item, file) {
      load();
      const next = { ...files, [audioKey(item)]: file };
      fs.mkdirSync(path.dirname(indexFile), { recursive: true });
      fs.writeFileSync(indexFile + '.tmp', JSON.stringify(next));
      fs.renameSync(indexFile + '.tmp', indexFile);
      files = next;
    },
    async find(item) {
      load();
      const file = files[audioKey(item)];
      if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
      try {
        const stat = await fs.promises.stat(file);
        if (stat.isFile() && stat.size > 0) return { url: pathToFileURL(file).href, local: true, codecs: path.extname(file).slice(1).toUpperCase() };
      } catch {}
      return null;
    },
  };
}
module.exports = { createLocalAudioStore, audioKey };
