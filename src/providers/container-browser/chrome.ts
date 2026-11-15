import { existsSync } from 'node:fs';

export const googleChrome = '/usr/bin/google-chrome-stable';
const wrappers = '/app/src/providers/container-browser';

export function containerBrowserProduct(
  architecture: NodeJS.Architecture = process.arch,
  installed: (path: string) => boolean = existsSync,
): { product: 'Google Chrome' | 'Chromium'; executable: string; reason?: string } {
  if (architecture === 'x64' && installed(googleChrome))
    return { product: 'Google Chrome', executable: `${wrappers}/chrome.sh` };
  return {
    product: 'Chromium',
    executable: `${wrappers}/chromium.sh`,
    reason:
      architecture === 'x64'
        ? `Google Chrome is not installed at ${googleChrome} in this browser image, so it uses Chromium. Rebuild the image from Dockerfile.browser to get Chrome.`
        : `Google Chrome has no Linux ${architecture} build, so the browser uses Chromium. Run Nod on a Linux x64 server for Chrome.`,
  };
}
