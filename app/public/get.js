// Download feedback. Android browsers give almost none for an APK download —
// a quiet entry in the notification shade at best — so the page itself must
// say what's happening: the real size up front, and the moment the button is
// tapped, where the download went and what to do when it finishes.
// The saved file is named flock-<build>.apk (the `download` attribute, fed by
// /version.json) so a phone full of old downloads shows which is which; the
// URL itself stays stable at downloads/flock.apk.
// (External file, not inline: the site CSP is script-src 'self'.)
const link = document.querySelector('a[href$="downloads/flock.apk"]')
if (link) {
  let name = 'flock.apk'
  const status = document.createElement('p')
  status.setAttribute('aria-live', 'polite')
  status.style.cssText = 'display:none;margin-top:10px;padding:12px 14px;border:1px solid #3a4a5a;border-radius:10px'
  link.insertAdjacentElement('afterend', status)

  fetch('./version.json')
    .then((r) => r.json())
    .then((v) => {
      if (v.build) {
        name = `flock-${v.build}.apk`
        link.setAttribute('download', name)
      }
    })
    .catch(() => {})

  fetch('./downloads/flock.apk', { method: 'HEAD' })
    .then((r) => {
      const mb = Number(r.headers.get('content-length')) / 1048576
      if (mb) link.textContent = `⬇  Download flock for Android · ${mb.toFixed(0)} MB`
    })
    .catch(() => {})

  link.addEventListener('click', () => {
    status.style.display = 'block'
    status.innerHTML =
      '<strong>Your download has started</strong> — the browser shows it in the ' +
      'notification bar (pull down from the top), not on this page. It takes a ' +
      `minute on slow connections. When <strong>${name}</strong> appears there ` +
      'as finished, tap it to install. Already have flock? Installing over the ' +
      'top keeps everything.'
  })
}
