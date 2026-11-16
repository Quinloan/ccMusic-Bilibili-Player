// Main-window appearance. Root tokens stay separate from the mini player's body tokens.
(function (root) {
  // A shared neutral charcoal foundation keeps the large surfaces free of hue
  // casts. Colour choices affect accents/selection, rather than tinting black.
  const darkSurfaces = ['#17181a', '#1c1d1f', '#17181a'];
  const palettes = {
    pink: { name: '经典粉', light: ['#f5f5f7', '#ffffff', '#fbfbfc', '#ce286f', '#fff0f6'], dark: [...darkSurfaces, '#ff80b4', '#35212d'] },
    blue: { name: '雾蓝', light: ['#f1f5fa', '#ffffff', '#f7f9fc', '#2366c7', '#e8f0fd'], dark: [...darkSurfaces, '#85b7ff', '#20344e'] },
    green: { name: '森林绿', light: ['#f1f5f2', '#fcfefc', '#f7faf8', '#16785b', '#e4f2eb'], dark: [...darkSurfaces, '#72d4aa', '#203c2f'] },
    purple: { name: '薰衣草紫', light: ['#f5f2f9', '#fefcff', '#faf7fd', '#764bb5', '#eee6f8'], dark: [...darkSurfaces, '#c6a4ff', '#3b2c50'] },
    cream: { name: '奶油暖橙', light: ['#f7f2e9', '#fffdf7', '#fbf6ed', '#9b5b22', '#f5e8d5'], dark: [...darkSurfaces, '#edbb86', '#463322'] },
  };
  const modes = ['light', 'dark', 'system'];
  function clean(value) { return { mode: modes.includes(value?.mode) ? value.mode : 'light', color: Object.hasOwn(palettes, value?.color) ? value.color : 'pink' }; }
  function tokens(choice, systemDark) {
    const state = clean(choice), dark = state.mode === 'dark' || state.mode === 'system' && systemDark;
    const p = palettes[state.color][dark ? 'dark' : 'light'];
    return { appearance: dark ? 'dark' : 'light', values: {
      '--bg': p[0], '--panel': p[1], '--bar': p[2], '--accent': p[3], '--accent-soft': p[4],
      '--text': dark ? '#f3f3f3' : '#22242a', '--muted': dark ? '#a6a6ae' : '#666974',
      '--line': dark ? '#2d2e31' : '#dfe2e8', '--on-accent': dark ? '#18191b' : '#ffffff',
      '--hover': dark ? '#252628' : '#fafafb', '--placeholder': dark ? '#96969f' : '#777b85',
      '--switch-off': dark ? '#4b4c50' : '#cfcfd6', '--switch-knob': '#ffffff',
      '--danger': dark ? '#ff9ba9' : '#b7334b', '--danger-soft': dark ? '#48242d' : '#fdeeee',
      '--success': dark ? '#72d4aa' : '#277448', '--shade-hover': dark ? '#ffffff14' : '#00000012',
      '--overlay': dark ? '#00000099' : '#14141861',
      '--toast-bg': dark ? '#ededee' : '#2d2530', '--toast-text': dark ? '#202123' : '#ffffff',
      '--toast-action': dark ? '#8b2250' : '#ffc6e0',
    } };
  }
  const api = { palettes, clean, tokens };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.AppTheme = api;
  const storageKey = 'appearanceV1', media = root.matchMedia('(prefers-color-scheme: dark)');
  let state;
  try { state = clean(JSON.parse(localStorage.getItem(storageKey))); } catch (_) { state = clean(null); }
  function apply() {
    const theme = tokens(state, media.matches), html = document.documentElement;
    for (const [name, value] of Object.entries(theme.values)) html.style.setProperty(name, value);
    html.dataset.appearance = theme.appearance; html.dataset.themeColor = state.color;
    html.style.colorScheme = theme.appearance;
    const mode = document.getElementById('themeMode'), color = document.getElementById('themeColor');
    if (mode) mode.value = state.mode;
    if (color) color.value = state.color;
  }
  api.state = () => ({ ...state });
  api.configure = value => {
    const next = clean(value);
    // Persist first, so a storage failure leaves both UI and saved selection unchanged.
    localStorage.setItem(storageKey, JSON.stringify(next)); state = next; apply();
  };
  media.addEventListener('change', () => { if (state.mode === 'system') apply(); });
  apply(); // Runs in <head>, before the first paint, without waiting for network/IPC.
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    for (const id of ['themeMode', 'themeColor']) document.getElementById(id).onchange = () => {
      try { api.configure({ mode: document.getElementById('themeMode').value, color: document.getElementById('themeColor').value }); }
      catch (_) { apply(); document.getElementById('themeStatus').textContent = '暂时无法保存外观设置，请重试'; return; }
      document.getElementById('themeStatus').textContent = '';
    };
  });
})(globalThis);
