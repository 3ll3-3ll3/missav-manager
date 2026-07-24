const fs = require('fs');
const path = require('path');

const CURRENT_DIRECTORY_NAME = 'TG_Content_Toolbox';
const LEGACY_DIRECTORY_NAMES = Object.freeze([
  'MissAV_Manager',
  'missav-manager',
]);

function hasApplicationData(directory) {
  const root = path.resolve(String(directory || ''));
  return [
    path.join(root, 'data', 'missav_data.db'),
    path.join(root, 'secure'),
    path.join(root, 'logs'),
  ].some(target => fs.existsSync(target));
}

function selectUserDataPath(options = {}) {
  const explicit = String(options.explicit || '').trim();
  if (explicit) return {
    path: path.resolve(explicit),
    source: 'environment',
    legacy: false,
  };

  const appData = path.resolve(String(options.appData || ''));
  const current = path.resolve(String(options.current || path.join(appData, CURRENT_DIRECTORY_NAME)));
  if (hasApplicationData(current)) return { path: current, source: 'current', legacy: false };

  for (const name of LEGACY_DIRECTORY_NAMES) {
    const candidate = path.join(appData, name);
    if (hasApplicationData(candidate)) {
      return {
        path: candidate,
        source: `legacy:${name}`,
        legacy: true,
      };
    }
  }
  return { path: current, source: 'current-new', legacy: false };
}

module.exports = {
  CURRENT_DIRECTORY_NAME,
  LEGACY_DIRECTORY_NAMES,
  hasApplicationData,
  selectUserDataPath,
};
