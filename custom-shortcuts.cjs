'use strict';
const actions = ['playPause', 'prev', 'next', 'like', 'desktopLyrics'];
function createShortcuts({ shortcut, send, read, write }) {
  let bindings = {}, error = '';
  function normalize(value) {
    const text = String(value || '').trim().replace(/Ctrl/g, 'Control');
    if (!text) return '';
    if (!/^(?:(?:Control|Alt|Shift)\+)*(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Left|Right|Up|Down)$/.test(text) ||
        (!/Control|Alt|(?:^|\+)F\d+$/.test(text))) throw new Error('请使用 Ctrl、Alt 组合键或 F1—F24');
    const parts = text.split('+'), key = parts.pop();
    return ['Control', 'Alt', 'Shift'].filter(mod => parts.includes(mod)).concat(key).join('+');
  }
  function release(map) {
    for (const accelerator of Object.values(map)) if (accelerator) shortcut.unregister(accelerator);
  }
  function install(map, acquired = {}) {
    for (const [action, accelerator] of Object.entries(map)) {
      if (accelerator && !shortcut.register(accelerator, () => send(action))) throw new Error('快捷键 ' + accelerator + ' 已被占用或不可用');
      if (accelerator) acquired[action] = accelerator;
    }
  }
  function configure(input, persist = true) {
    const next = Object.fromEntries(actions.map(action => [action, normalize(input?.[action])]));
    const used = Object.values(next).filter(Boolean);
    if (new Set(used).size !== used.length) throw new Error('不同操作不能使用相同快捷键');
    const previous = bindings;
    const acquired = {};
    release(previous);
    try {
      install(next, acquired);
      if (persist) write(next);
      bindings = next; error = '';
    } catch (failure) {
      release(acquired);
      try { install(previous); } catch (_) {}
      error = failure.message;
      throw failure;
    }
    return { bindings, error };
  }
  function start() {
    try { configure(read(), false); } catch (_) {}
  }
  return { start, configure, state: () => ({ bindings: read() || {}, error }), dispose: () => release(bindings) };
}
module.exports = { createShortcuts };
