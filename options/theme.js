// Applies the Settings page theme before the first paint, from a local copy of the saved choice,
// so a dark page never flashes white. options.js keeps the copy in sync with appSettings.
(function () {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  let choice = 'light';
  let painted = false;

  function apply(next) {
    choice = ['light', 'dark', 'system'].includes(next) ? next : 'light';
    const theme = choice === 'dark' || (choice === 'system' && media.matches) ? 'dark' : 'light';
    if (root.dataset.theme !== theme) {
      // After the first paint, switch every colour at once instead of letting transitions lag.
      if (painted) {
        root.classList.add('theme-switching');
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
      }
      root.dataset.theme = theme;
    }
    try { if (localStorage.getItem('optionsTheme') !== choice) localStorage.setItem('optionsTheme', choice); } catch (error) {}
  }

  try { apply(localStorage.getItem('optionsTheme')); } catch (error) { apply('light'); }
  media.addEventListener('change', () => apply(choice));
  document.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => { painted = true; });
  });
  window.leakHaloTheme = { apply };
})();
