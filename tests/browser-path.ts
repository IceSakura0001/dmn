import {existsSync} from 'node:fs';

/** Use an installed browser; never download one as a side effect of acceptance. */
export function browserPath(){
 const candidates=[process.env.CHROMIUM_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
 const path=candidates.find((p):p is string=>!!p&&existsSync(p));
 if(!path)throw Error('Set CHROMIUM_PATH to an installed Chromium browser');
 return path;
}
