/**
 * A phone browser. Phones can't record a computer screen, so the website shows them a
 * lighter page instead: what Take1 is, a place to try the voice commands, and a way to
 * send the link to a computer. Never true in the desktop app, and never true for a
 * desktop browser (even a narrow window): those keep the full app.
 */
export const phone: boolean = (() => {
  if (typeof window === 'undefined' || (window as any).take1Native) return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod|Windows Phone|Android.+Mobile|Mobi/i.test(ua)) return true;
  // a touch-only screen that's phone-sized (some phones send a desktop user agent)
  try {
    return matchMedia('(pointer: coarse) and (hover: none) and (max-width: 820px)').matches;
  } catch {
    return false;
  }
})();

if (phone) document.documentElement.classList.add('is-phone');
