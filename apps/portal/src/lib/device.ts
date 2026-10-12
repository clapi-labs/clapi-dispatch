/** Celular o tableta: ahí está la app de WhatsApp y se puede llamar. El iPad
 *  se presenta como Mac, por eso también se mira si la pantalla es táctil. */
export function isMobileDevice() {
  const ua = navigator.userAgent;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}
