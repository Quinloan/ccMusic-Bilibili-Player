let style = { fontSize: 29, twoLines: true };
window.desktopLyrics.onControls(visible => {
  document.body.classList.toggle('controls-visible', visible);
});
window.desktopLyrics.onLine(line => {
  document.querySelector('#current').textContent = line.current;
  document.querySelector('#next').textContent = line.next;
  document.querySelector('#offset').textContent = (Number(line.offset) || 0).toFixed(1) + 's';
});
window.desktopLyrics.onStyle(value => {
  style = value;
  document.body.style.setProperty('--lyric-size', value.fontSize + 'px');
  document.body.style.setProperty('--lyric-color', value.color);
  document.body.classList.toggle('single-line', !value.twoLines);
  document.querySelector('#fontSize').textContent = value.fontSize;
  document.querySelector('#lines').textContent = value.twoLines ? '双行' : '单行';
  document.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === value.color)));
});
document.querySelector('#smaller').onclick = () => window.desktopLyrics.configure({ fontSize: style.fontSize - 2 });
document.querySelector('#larger').onclick = () => window.desktopLyrics.configure({ fontSize: style.fontSize + 2 });
document.querySelector('#lines').onclick = () => window.desktopLyrics.configure({ twoLines: !style.twoLines });
document.querySelectorAll('[data-color]').forEach(button => {
  button.onclick = () => window.desktopLyrics.configure({ color: button.dataset.color });
});
document.querySelector('#earlier').onclick = () => window.desktopLyrics.offset(-.5);
document.querySelector('#later').onclick = () => window.desktopLyrics.offset(.5);
document.querySelector('#close').onclick = () => window.desktopLyrics.close();
document.addEventListener('contextmenu', event => event.preventDefault());
