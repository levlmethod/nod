# Browser profiles belong to one agent and one client, and the browser is real Chrome on x64

Doug's agents need to stay signed in to each client's ad accounts and dashboards, and websites flag Chromium as a bot. Upstream already keeps signed-in browser profiles as saved browser sessions (`browser_connections`, one profile folder each). The fork keeps that model and adds a fork-only `agent_browser_profiles` side table that records which agent and client made each profile. A card's `browser_session` calls go through a guard that refuses any profile its agent didn't make for its client, and its `sign_in` calls run only inside one of its own profiles, with no saved login, authenticator code or email code from the owner's shared Vault and mailbox.

The browser image installs Google Chrome stable from Google's signed apt repository on amd64 and Chromium elsewhere, since Google ships no Linux arm64 Chrome. The container worker picks Chrome when it is installed on x64 and logs which browser runs and why.

## Upstream files touched

- `src/server/composition.ts`: wraps the `browserConnection` dependency with the card guard, calls the sign-in guard at the top of `requestCredential`, and for a card skips the authenticator code, the automatic saved login and a login picked in the private form. It passes the card's own profiles to the agent binding.
- `Dockerfile.browser`: installs Google Chrome on amd64 instead of Chromium, and installs the `chrome.sh` wrapper.
- `src/providers/container-browser/config.ts`: takes the browser executable from `chrome.ts`.
- `src/providers/container-browser/worker.ts`: logs the browser product and fallback reason at startup.
- `desktop/scripts/runtime-inputs.mjs`: lists `chrome.sh` as a browser image input, which the desktop runtime check requires.
- `docs/src/content/docs/how-it-works/sandbox-and-browser.md`: which browser runs and the per-agent profiles.

## Considered options

One profile folder per agent and client holding every site was rejected: upstream ties each saved session to one origin and one profile folder, and deletes the folder when the owner removes the session. Keeping upstream's one-profile-per-site model and keying each by agent and client needs no change to the browser provider.

Refusing at the runtime wall alone was rejected, because a card can make a profile and save it in the same turn, after its context was built. The server guard reads the side table on every call.

Giving browser agents Pi's web search was rejected for Phase 1: the browser already reaches public pages, and card sessions stay restricted.

The desktop app builds the same browser image, so x64 desktop runtimes now also get Chrome. That is fine for the fork, and noted here for upstream merges.
