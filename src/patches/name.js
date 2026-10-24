'use strict';

const fs = require('fs');
const { MAIN_JS, NAME_MARK, PET_NAME, syntaxOk } = require('./shared');

function patchPetName() {
  if (!fs.existsSync(MAIN_JS)) {
    console.error(`helper file not found: ${MAIN_JS}`);
    return false;
  }
  const original = fs.readFileSync(MAIN_JS, 'utf8');
  if (original.includes(NAME_MARK)) {
    console.log('main.js name patch already applied');
    return true;
  }
  const anchor = "    tray.setToolTip('dsh-pet 桌面宠物');";
  if (!original.includes(anchor)) {
    console.error('main.js: tray tooltip anchor not found (dsh-pet changed?)');
    return false;
  }
  const updated = original.replace(
    anchor,
    `    tray.setToolTip('${PET_NAME}'); // patched: 程序名随宠物名`,
  );
  const backup = `${MAIN_JS}.dsh-pet-pre-name`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
  fs.writeFileSync(MAIN_JS, `${updated}\n${NAME_MARK}\n`);
  if (!syntaxOk(MAIN_JS)) {
    fs.writeFileSync(MAIN_JS, original);
    console.error('main.js: name patch failed syntax check, restored');
    return false;
  }
  console.log(`patched main.js (tray tooltip → ${PET_NAME})`);
  return true;
}

/**
 * preload.js — expose `openLocalFile` for the diary menu entry.
 *
 * `pet:open-site` only forwards http(s) URLs (that guard is deliberate), so a
 * file:// URL is silently dropped. Local files go through their own channel.
 */

module.exports = { patchPetName };
