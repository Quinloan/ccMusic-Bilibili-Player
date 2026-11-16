// An expanded view of the existing player: same audio element, clock and controls.
let nowPlayingOpen = false;
const nowDefaults = { lyrics: true, spectrum: false, cover: true, blur: true, lyricsColor: '#ffffff', spectrumColor: '#ffffff', fontSize: 28 };
function cleanNowPreferences(value) {
  const result = { ...nowDefaults };
  for (const key of ['lyrics', 'spectrum', 'cover', 'blur']) if (typeof value?.[key] === 'boolean') result[key] = value[key];
  for (const key of ['lyricsColor', 'spectrumColor']) if (/^#[\da-f]{6}$/i.test(value?.[key] || '')) result[key] = value[key];
  if (Number.isFinite(value?.fontSize)) result.fontSize = Math.max(20, Math.min(40, value.fontSize));
  return result;
}
let nowPreferences;
try { nowPreferences = cleanNowPreferences(JSON.parse(localStorage.nowPlayingPreferencesV1 || 'null')); }
catch (_) { nowPreferences = { ...nowDefaults }; }
let nowLyricSignature = '', nowLyricActive = -2, nowManualScrollUntil = 0, nowScrollTimer = null;
let nowSpectrumFrame = null, nowSpectrumReader = null, nowSpectrumLastTime = 0;

function nowCurrentItem() { return playback.current?.item || playback.requested?.item; }
function nowLyricsWanted() { return nowPlayingOpen && nowPreferences.lyrics; }
function openNowPlaying() {
  if (miniModeState.mini) return;
  if (!nowCurrentItem()) return toast('请先选择一首歌曲');
  nowPlayingOpen = true;
  document.body.classList.add('now-playing'); $('#nowPlaying').hidden = false;
  $('#queuePanel').hidden = true; $('#tasksPanel').hidden = true; closeCtx(); closeVolume();
  syncNowPlaying(); applyNowPreferences();
  if (nowPreferences.lyrics) void loadSongLyrics();
  $('#nowCollapse').focus({ preventScroll: true });
}
function closeNowPlaying(restoreFocus = true) {
  if (!nowPlayingOpen) return;
  nowPlayingOpen = false;
  document.body.classList.remove('now-playing'); $('#nowPlaying').hidden = true;
  $('#nowSettings').hidden = true; $('#nowOptions').setAttribute('aria-expanded', 'false');
  clearTimeout(nowScrollTimer); stopNowSpectrum(); closeVolume();
  if (restoreFocus) $('#bCover').focus({ preventScroll: true });
}
function syncNowPlaying() {
  if (!nowPlayingOpen) return;
  const item = nowCurrentItem();
  if (!item) { closeNowPlaying(); return; }
  $('#nowHeading').textContent = item.title; $('#nowHeading').title = item.vtitle || item.title;
  $('#nowTitle').textContent = item.title; $('#nowArtist').textContent = songArtist(item);
  $('#nowTextOnly h2').textContent = item.title; $('#nowTextOnly p').textContent = songArtist(item);
  const source = $('#bCover').getAttribute('src') || itemCover(item) || LOGO_SRC;
  for (const id of ['#nowCover', '#nowBackdrop']) if ($(id).getAttribute('src') !== source) { $(id).hidden = false; $(id).src = source; }
  const liked = $('#likeButton').getAttribute('aria-pressed') === 'true';
  $('#nowLike').textContent = liked ? '♥' : '♡'; $('#nowLike').setAttribute('aria-pressed', String(liked));
  $('#nowLike').setAttribute('aria-label', liked ? '取消喜欢' : '加入我喜欢');
  if (nowPreferences.lyrics) void loadSongLyrics();
}
function applyNowPreferences() {
  const page = $('#nowPlaying');
  page.classList.toggle('without-lyrics', !nowPreferences.lyrics);
  page.classList.toggle('without-cover', !nowPreferences.cover);
  page.classList.toggle('without-spectrum', !nowPreferences.spectrum);
  page.classList.toggle('without-blur', !nowPreferences.blur);
  page.style.setProperty('--now-lyrics-color', nowPreferences.lyricsColor);
  page.style.setProperty('--now-font-size', nowPreferences.fontSize + 'px');
  $('#nowArtwork').hidden = !nowPreferences.cover; $('#nowLyricsPane').hidden = !nowPreferences.lyrics;
  $('#nowTextOnly').hidden = nowPreferences.cover || nowPreferences.lyrics;
  $('#nowSpectrum').hidden = !nowPreferences.spectrum;
  for (const [id, key] of [['nowShowLyrics','lyrics'],['nowShowSpectrum','spectrum'],['nowShowCover','cover'],['nowShowBlur','blur']]) $('#' + id).checked = nowPreferences[key];
  $('#nowLyricsColor').value = nowPreferences.lyricsColor; $('#nowSpectrumColor').value = nowPreferences.spectrumColor;
  $('#nowFontSize').value = nowPreferences.fontSize; $('#nowFontValue').textContent = nowPreferences.fontSize;
  $('#nowOffsetLabel').textContent = '歌词偏移 ' + lyricsOffset.toFixed(1) + ' 秒';
  if (nowPlayingOpen && nowPreferences.lyrics) { void loadSongLyrics(); centreNowLyric(false); }
  refreshNowSpectrum();
}
function saveNowPreference(key, value) {
  const previous = nowPreferences;
  nowPreferences = cleanNowPreferences({ ...nowPreferences, [key]: value });
  try { localStorage.nowPlayingPreferencesV1 = JSON.stringify(nowPreferences); }
  catch (_) { nowPreferences = previous; toast('暂时无法保存播放界面设置'); }
  applyNowPreferences();
}
function renderNowLyrics() {
  if (!nowPlayingOpen) return;
  const list = $('#nowLyrics');
  const signature = lyricsTicket + '|' + lyricsRows.length + '|' + lyricsMessage + '|' + lyricsPlainText;
  if (signature !== nowLyricSignature) {
    nowLyricSignature = signature; nowLyricActive = -2;
    const fragment = document.createDocumentFragment();
    if (lyricsRows.length) {
      lyricsRows.forEach((line, index) => {
        const button = document.createElement('button'); button.className = 'now-lyric-line'; button.dataset.line = index; button.textContent = line.text;
        button.onclick = () => {
          const item = playback.current?.item;
          if (!item || !lyricsItem || itemKey(item) !== itemKey(lyricsItem)) return;
          nowManualScrollUntil = 0;
          seekPlayback((item.split ? item.startSec : 0) + line.time + lyricsOffset + .01);
          refreshLyricsLine();
        };
        fragment.appendChild(button);
      });
    } else {
      const status = document.createElement('div'); status.className = 'now-lyric-message';
      status.textContent = lyricsPlainText || lyricsMessage || '正在查找歌词…'; fragment.appendChild(status);
    }
    list.replaceChildren(fragment); list.scrollTop = 0;
  }
  $('#nowLyricsSource').textContent = lyricsSource ? '歌词来源：' + lyricsSource : '';
  $('#nowRetryLyrics').hidden = !!lyricsRows.length || lyricsMessage === '正在查找歌词…';
  $('#nowOffsetLabel').textContent = '歌词偏移 ' + lyricsOffset.toFixed(1) + ' 秒';
  updateNowLyricIndex();
}
function centreNowLyric(smooth = true) {
  const list = $('#nowLyrics'), line = list.querySelector('.current');
  if (!line || Date.now() < nowManualScrollUntil) return;
  list.scrollTo({ top: line.offsetTop - list.clientHeight * .45 + line.offsetHeight / 2,
    behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
}
function updateNowLyricIndex() {
  if (!nowPlayingOpen || !nowPreferences.lyrics || nowLyricActive === lyricsRow) return;
  const list = $('#nowLyrics');
  list.querySelector('.current')?.classList.remove('current');
  list.querySelector('[aria-current]')?.removeAttribute('aria-current');
  const current = list.querySelector('[data-line="' + lyricsRow + '"]');
  if (current) { current.classList.add('current'); current.setAttribute('aria-current','true'); }
  const first = nowLyricActive === -2; nowLyricActive = lyricsRow; centreNowLyric(!first);
}
function stopNowSpectrum() {
  if (nowSpectrumFrame !== null) cancelAnimationFrame(nowSpectrumFrame);
  nowSpectrumFrame = null;
  if (nowSpectrumReader) {
    try { srcNode.disconnect(nowSpectrumReader.analyser); } catch (_) {}
    nowSpectrumReader.analyser.disconnect(); nowSpectrumReader.sink.disconnect(); nowSpectrumReader = null;
  }
}
function drawNowSpectrum() {
  const canvas = $('#nowSpectrum'), box = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
  if (!box.width || !box.height) return;
  const width = Math.round(box.width * ratio), height = Math.round(box.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d'); if (!context) return;
  context.clearRect(0,0,width,height); context.fillStyle = nowPreferences.spectrumColor;
  const reader = nowSpectrumReader;
  if (reader && !audio.paused) reader.analyser.getByteFrequencyData(reader.data);
  const columns = Math.min(72, Math.floor(box.width / 9)), gap = 3 * ratio, step = width / Math.max(1,columns);
  for (let i = 0; i < columns; i++) {
    let value = 0;
    if (reader && !audio.paused) {
      const from = Math.floor(30 * (16000 / 30) ** (i / columns) / (ac.sampleRate / reader.analyser.fftSize));
      const to = Math.max(from + 1, Math.floor(30 * (16000 / 30) ** ((i + 1) / columns) / (ac.sampleRate / reader.analyser.fftSize)));
      for (let j = from; j < Math.min(to,reader.data.length); j++) value = Math.max(value,reader.data[j] / 255);
    }
    const bar = Math.max(2 * ratio, value * height), x = i * step;
    context.beginPath();
    if (context.roundRect) context.roundRect(x,height - bar,Math.max(ratio,step - gap),bar,2 * ratio);
    else context.rect(x,height - bar,Math.max(ratio,step - gap),bar);
    context.fill();
  }
}
function refreshNowSpectrum() {
  stopNowSpectrum();
  if (!nowPlayingOpen || !nowPreferences.spectrum || document.hidden) return;
  // A silent tap on the existing source: never create a second player or audible route.
  if (!audio.paused && ac && srcNode) try {
    const analyser = ac.createAnalyser(), sink = ac.createGain();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = .8; analyser.minDecibels = -90; analyser.maxDecibels = -20;
    sink.gain.value = 0; srcNode.connect(analyser); analyser.connect(sink); sink.connect(ac.destination);
    nowSpectrumReader = { analyser, sink, data: new Uint8Array(analyser.frequencyBinCount) };
  } catch (_) { nowSpectrumReader = null; }
  drawNowSpectrum();
  if (audio.paused) return;
  const animate = time => {
    if (!nowPlayingOpen || !nowPreferences.spectrum || document.hidden || audio.paused) { refreshNowSpectrum(); return; }
    if (time - nowSpectrumLastTime >= 33) { nowSpectrumLastTime = time; drawNowSpectrum(); }
    nowSpectrumFrame = requestAnimationFrame(animate);
  };
  nowSpectrumFrame = requestAnimationFrame(animate);
}
function initNowPlaying() {
  $('#bCover').addEventListener('click', openNowPlaying);
  $('#bCover').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openNowPlaying(); } });
  $('#nowCollapse').onclick = () => closeNowPlaying();
  $('#nowOptions').onclick = () => { $('#nowSettings').hidden = !$('#nowSettings').hidden; $('#nowOptions').setAttribute('aria-expanded', String(!$('#nowSettings').hidden)); };
  for (const [id,target] of [['nowMini','wMini'],['nowMin','wMin'],['nowMax','wMax'],['nowClose','wClose'],['nowLike','likeButton']]) $('#' + id).onclick = () => $('#' + target).click();
  for (const [id,target] of [['nowMini','wMini'],['nowMin','wMin'],['nowMax','wMax'],['nowClose','wClose']]) $('#' + id).innerHTML = $('#' + target).innerHTML;
  for (const [id,key] of [['nowShowLyrics','lyrics'],['nowShowSpectrum','spectrum'],['nowShowCover','cover'],['nowShowBlur','blur']]) $('#' + id).onchange = event => saveNowPreference(key,event.target.checked);
  for (const [id,key] of [['nowLyricsColor','lyricsColor'],['nowSpectrumColor','spectrumColor'],['nowFontSize','fontSize']]) $('#' + id).oninput = event => saveNowPreference(key,key === 'fontSize' ? Number(event.target.value) : event.target.value);
  $('#nowOffsetMinus').onclick = () => adjustSongLyricsOffset(-.5);
  $('#nowOffsetPlus').onclick = () => adjustSongLyricsOffset(.5);
  $('#nowRetryLyrics').onclick = () => void loadSongLyrics(true);
  $('#nowCover').onerror = () => { if ($('#nowCover').getAttribute('src') !== LOGO_SRC) $('#nowCover').src = LOGO_SRC; };
  $('#nowBackdrop').onerror = () => { $('#nowBackdrop').hidden = true; };
  new MutationObserver(syncNowPlaying).observe($('#bTitle'),{childList:true});
  new MutationObserver(syncNowPlaying).observe($('#bUp'),{childList:true});
  new MutationObserver(syncNowPlaying).observe($('#bCover'),{attributes:true,attributeFilter:['src']});
  new MutationObserver(syncNowPlaying).observe($('#likeButton'),{attributes:true,attributeFilter:['aria-pressed']});
  for (const event of ['play','pause','playing','emptied']) audio.addEventListener(event,refreshNowSpectrum);
  document.addEventListener('visibilitychange',refreshNowSpectrum);
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.now-options-wrap')) { $('#nowSettings').hidden = true; $('#nowOptions').setAttribute('aria-expanded','false'); } });
  $('#nowPlaying').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (!$('#nowSettings').hidden) { $('#nowSettings').hidden = true; $('#nowOptions').setAttribute('aria-expanded','false'); $('#nowOptions').focus(); }
    else closeNowPlaying();
  });
  const manualScroll = () => { nowManualScrollUntil = Date.now() + 3000; clearTimeout(nowScrollTimer); nowScrollTimer = setTimeout(() => centreNowLyric(),3100); };
  for (const event of ['wheel','touchstart','pointerdown']) $('#nowLyrics').addEventListener(event,manualScroll,{passive:true});
  new ResizeObserver(() => { if (nowPlayingOpen) { drawNowSpectrum(); centreNowLyric(false); } }).observe($('#nowPlaying'));
  applyNowPreferences();
}
