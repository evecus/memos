(async function() {
  async function loadB64(prefix, n) {
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push(await fetch('/' + prefix + '.' + i + '.b64').then(r => r.text()));
    }
    return atob(parts.join(''));
  }
  const css = await loadB64('css', 4);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const js = await loadB64('js', 7);
  (0, eval)(js);
})().catch(e => {
  document.getElementById('app').innerHTML = '<div class="empty error">' + e + '</div>';
  console.error(e);
});
