# OpenCode: explicit Windows Tripo login adapter

Entrypoint: `node adapter/main.mjs` (Node **24+**, Windows, installed Microsoft Edge).
Upstream is pinned to `tripo-studio-plugin@0.3.13`; browser control uses `playwright-core@1.58.2`. No browser download is required. This is a local wrapper, not an edit of npm package files.

## User flow

1. Check `tripo_auth_status` (read-only).
2. Explain the dedicated browser/manual sign-in and obtain user agreement.
3. Call `tripo_auth_login` with `{}`. Only that explicit tool call opens a browser. Do not call it with `headless_only`.
4. The user signs in manually at **https://studio.tripo3d.ai/** in the new Edge window. No password, verification code, token or cookie should ever be pasted into chat.
5. The window closes after the session is accepted, cancellation, manual window closure, or ten-minute timeout. Launch/navigation errors also clean up the context.

No model generation or paid calls are made by this adapter. Upstream import verifies the session using its read-only payment/profile endpoint and optional auth whoami endpoint.

## Security and storage

- Dedicated persistent profile: `%LOCALAPPDATA%/TripoStudioPlugin/opencode-browser`.
- Isolated upstream data: `%LOCALAPPDATA%/TripoStudioPlugin/opencode-session`. Existing upstream user data is neither copied nor overwritten.
- Directory inheritance is disabled and full control granted to the current Windows SID, SYSTEM and Administrators, inherited by new children. Existing explicit ACL grants are not removed; if reusing a manually shared integration directory, review its ACL first. NTFS local storage is not encryption against the logged-in Windows user or administrators.
- Only secure `ory_kratos_session` cookies for exactly `tripo3d.ai`, `studio.tripo3d.ai`, or `auth.tripo3d.ai` are eligible. Cookies are obtained through Playwright's API for the dedicated context, never by opening browser cookie databases, decrypting protected cookies, or attaching to a normal browser.
- The cookie goes only to an internal correlated `tripo_auth_import` request over child-process stdin. Internal replies are consumed, and the client receives only a fixed success/failure message. Browser/upstream error details are not relayed; upstream stderr is discarded. No storageState dump, screenshot, trace, cookie file or credential logging is used.
- Browser `DEBUG`/`PWDEBUG` are disabled. The adapter does not provide a remote debugging TCP endpoint or connect to an existing browser.
- Upstream 0.3.13 silently scans normal browser stores on recovery. `upstream.mjs` uses a Node module-load hook to make `sessionCandidates()` return `[]` **before any store access**, for every code path. Version and exact marker checks fail closed. The npm bundle is untouched; review this guard and tests before upgrading.
- Browser profile persists sign-in by design. Only a subsequent explicit login opens it; status and remote-call recovery never open a browser or adopt cookies. `tripo_auth_logout` clears the plugin session, not Edge's dedicated sign-in. To switch accounts, explicitly log in and sign out in that dedicated window. To remove the profile, close its window and remove only `opencode-browser` after confirming with the user; never remove other browser data.
- Direct upstream tools, including auth import, retain their protocol behavior. Agents must not request secrets or call auth import manually. The adapter does not change existing OpenCode app-only tool deny rules.

## MCP behavior

Classic MCP newline-delimited JSON stdio. Initialize, request metadata, client/server notifications, server-to-client requests and their responses are preserved. Client request IDs are mapped into a private random namespace, with original ID type restored on replies. Cancellation IDs are translated. Internal import responses, including late responses after cancellation, are never sent to the client. One login per process is permitted; profile locking prevents concurrent Edge use from another process. Adapter stdin EOF, SIGINT/SIGTERM and upstream exit abort active login and terminate the child. Forced process termination or power loss cannot guarantee browser cleanup.

The initial Windows manual acceptance test passed: dedicated Edge sign-in, session validation, account balance and model listing. Generation, paid operations and export/download are not yet verified end-to-end. Google sign-in/SSO may restrict automated browsers; the adapter does not bypass such restrictions. Diagnostics intentionally omit upstream exception text to protect credentials.

## Tests / maintenance

```powershell
npm.cmd ci
node --test adapter/adapter.test.mjs
```

Tests cover ID correlation and initialization, notifications and reverse requests, internal secret suppression, explicit-only login, headless/concurrent rejection, cancellation mapping, domain/value restrictions, fake-browser success/error/cancellation/timeout/delayed-launch cleanup, and real guarded upstream initialization/status (no browser or paid calls).

OpenCode global config changes only the Tripo command entrypoint to `adapter/main.mjs`. It reloads MCP configuration automatically; use `/mcps` or `/reload` if necessary. Rollback is replacing that path with `node_modules/tripo-studio-plugin/mcp/bootstrap.mjs`, but this **reenables upstream browser-store scanning** and does not use the isolated adapter session.
