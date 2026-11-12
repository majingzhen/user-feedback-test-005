const paths = {
  brand: `
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M5.1 8.8c4.6 1.4 8.9 4.8 11.4 9.6"/>
    <path d="M18.9 15.2c-4.6-1.4-8.9-4.8-11.4-9.6"/>
    <circle cx="12" cy="12" r="2.4"/>`,
  save: `
    <path d="M5 4.5h11l3 3V19.5H5z"/>
    <path d="M8 4.5v5h7v-5"/>
    <path d="M8 13.5h8v6H8z"/>`,
  pause: `
    <path d="M8 6v12"/>
    <path d="M16 6v12"/>`,
  play: `
    <path d="M8 5.8l10 6.2-10 6.2z"/>`,
  refresh: `
    <path d="M20 12a8 8 0 1 1-2.3-5.6"/>
    <path d="M20 4.5V9h-4.5"/>`,
  archive: `
    <path d="M4.5 7.5h15"/>
    <path d="M6 7.5v11h12v-11"/>
    <path d="M9 4.5h6l1.5 3h-9z"/>
    <path d="M9.5 12h5"/>`,
  lock: `
    <rect x="5" y="10" width="14" height="10" rx="2"/>
    <path d="M8 10V8a4 4 0 0 1 8 0v2"/>
    <circle cx="12" cy="15" r="1.3"/>`,
  unlock: `
    <rect x="5" y="10" width="14" height="10" rx="2"/>
    <path d="M8 10V8a4 4 0 0 1 7.7-1.4"/>
    <circle cx="12" cy="15" r="1.3"/>`,
  sphere: `
    <circle cx="12" cy="12" r="7.5"/>
    <path d="M7.8 8.3c1.9-1.2 4.2-1.3 6.2-.2"/>
    <path d="M15.2 16.2a6 6 0 0 0 2.2-3.4"/>`,
  glass: `
    <circle cx="12" cy="12" r="7.5"/>
    <circle cx="12" cy="12" r="4.3"/>
    <path d="M8.5 7.5l1.5 2"/>
    <path d="M16.5 9.2l1.4-1.8"/>`,
  floor: `
    <path d="M4 15.5h16"/>
    <path d="M7 15.5l-2.5 4"/>
    <path d="M12 15.5v4"/>
    <path d="M17 15.5l2.5 4"/>
    <path d="M9 11.5h6"/>`,
  light: `
    <rect x="4" y="7" width="16" height="9" rx="1.5"/>
    <path d="M7 4.5v-2"/>
    <path d="M12 4.5v-2"/>
    <path d="M17 4.5v-2"/>
    <path d="M8 18.5l-1.5 2"/>
    <path d="M16 18.5l1.5 2"/>`,
  warning: `
    <path d="M12 3.8l8.5 15h-17z"/>
    <path d="M12 9.5v4.5"/>
    <circle cx="12" cy="16.6" r=".6"/>`,
  check: `
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M8.2 12.2l2.5 2.5 5-5.2"/>`,
  camera: `
    <path d="M4 8.5h4l1.5-2h5L16 8.5h4v10H4z"/>
    <circle cx="12" cy="13" r="3"/>`,
  layers: `
    <path d="M12 4l8 4.5-8 4.5-8-4.5z"/>
    <path d="M4 12.5l8 4.5 8-4.5"/>
    <path d="M4 16.5l8 4.5 8-4.5"/>`,
  info: `
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M12 10.5v5.5"/>
    <circle cx="12" cy="7.8" r=".7"/>`,
};

export const iconMarkup = (name) => {
  const body = paths[name] || paths.info;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
};

export const hydrateIcons = (root = document) => {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (el.querySelector("svg")) return;
    el.insertAdjacentHTML("afterbegin", iconMarkup(el.dataset.icon));
  });
};
