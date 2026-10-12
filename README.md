# ChoiBuddy

**English** · [한국어](README.ko.md)

ChoiBuddy shows what Claude Code is doing on your PC, live, with a little buddy, and lets you answer its permission requests, questions and plan approvals from a Windows widget or your Android phone. The app speaks English, 한국어, 日本語 and Français.

![Watch Claude write code, live](promo/en/01-live.png)

**[Download the latest release](https://github.com/choidevhi/choibuddy/releases/latest)**: `ChoiBuddy_<version>_x64-setup.exe` for Windows 10/11, `ChoiBuddy-<version>.apk` for Android 8.0 and later.

```
Claude Code ──hooks (HTTP)──────▶ bridge (Node, on the PC) ──SSE──▶ Windows widget + floating buddy (Tauri)
            ──mod (usage, prompts)─┘          └──Tailscale──▶ Android app (WebView + notifications)
```

## What you get

![Approve from anywhere](promo/en/04-approval.png)

- **Approvals from anywhere.** Permission requests (allow, deny, always allow), Claude's questions (pick an answer) and plans (approve or ask for changes). They show up at the same time as the terminal dialog; whichever answers first wins. If nobody answers within 590 seconds, only the terminal dialog stays.
- **What it is doing right now.** Files it reads, lines it changes (red and green), commands and their output, searches and the todo list.
- **Code as it is written.** The code and the reply appear word by word while Claude types them (LIVE).
- **A buddy with a pose for every state.** Thinking, reading, editing, running a command, waiting for you, done, error and more. Subagents get their own small, coloured buddies.
- **Usage.** The 5-hour and weekly limits, context, tokens and cache hit rate, plus the model and effort in use. Change the model or effort right from the home screen.

![PC by PC, side by side](promo/en/02-split.png)

- **PC by PC, everywhere.** Home, chat and images all start the same way. Your PCs sit on the left as buddies of their own colour (hover for the name). Next come the chosen PC's sessions: open ones, ended ones under a divider, and the archive. The view comes last.
- **Panes like tmux.** On a PC, split home or chat into up to 6 panes, left/right or top/bottom, and split a half again. Drag the lines to resize; the layout is remembered. A home pane follows whichever session is busy until you pick one for it.
- **Chat.** Whole conversations come from the session transcripts, with the pictures Claude opened and the ones you sent shown where they happened, live. Send prompts and attach files (from the home screen too): pictures show as thumbnails in the prompt box and inside your bubble once sent, never as a list of paths. A prompt you send stays one bubble, dimmed while it waits in the queue, until the transcript has it, so nothing blinks. Each session keeps its own unsent draft and attachments, so you can switch sessions and come back to it.
- **Session menu.** Right-click a session (long-press on the phone) to rename it, end it (Claude Code gets `/exit`), reload its plugins (`/reload-plugins`), open a terminal in its folder, archive it or delete it. Ended sessions can be folded away, or archived or deleted all at once.
- **Older mod, one tap.** A session started before the companion mod was updated says so in the chat, with a button that runs `/reload-plugins` there as soon as the session is idle (× hides the note for that session on this device). A session whose mod is too old to take commands from the app never answers; after a while the chat says so and asks you to type `/reload-plugins` in its terminal once.
- **Terminal, inside the app.** The terminal tab opens a shell (PowerShell on Windows, your login shell on a Mac) on any of your PCs right in the app: what you type goes straight to the PC, output streams back live, and a screen that joins later (or another device) sees what came before. The phone gets Esc, Tab, Ctrl+C and arrow keys. The terminal button above the session list opens one in that session's folder.
- **Steering.** A prompt sent while Claude works can go **now** (the work stops right away, the running tool too, and Claude reads it next, like Claude Code's "send now") or wait until **after this task**. **Ctrl+Enter** always sends now.
- **Stop.** While Claude works, **Stop** next to Send ends the work right away, the running tool too, like Esc in the terminal; what was done stays, and messages already sent go in next. It needs the companion mod 0.5.3 or later in that session.
- **Slash commands.** Type `/` for the session's commands. They run as commands and their output shows in the chat.
- **Codex too (beta).** Press "Connect Codex" in the ＋ tab on a Windows PC and restart Codex. Without the `codex` command, ChoiBuddy installs OpenAI's Codex CLI first (winget). Then it adds its hooks and has Codex trust them, the same way Codex's own `/hooks` screen does. If that does not go through, a popup shows how to allow the hooks once in Codex, with a button that opens Codex in the app's terminal. Start Codex sessions from "New session" too. Codex sessions then show up with a tag: their steps (commands, patches), the conversation from Codex's own files, and its approval requests, which you can allow or deny from anywhere. Codex opened from "New session" in the app's terminal shows in the chat right away, before its first message, and takes prompts (and its own slash commands) from any device: ChoiBuddy types them into that terminal, and Stop presses Esc there. Codex started elsewhere takes no prompts from outside, and Codex reports no usage.
- **Auto language.** Turn it on in settings and, when Claude answers in a language other than the app's, ChoiBuddy asks the session once to restate the answer in yours (never a restatement again). It applies to every connected PC.
- **New sessions.** Pick a PC, Claude Code or Codex, a folder and a first prompt. It opens in the app's terminal, so you can type into it right away, or in a new window on the PC if you ask for that (or if this device may not use the PC's terminals). Codex runs with `--no-daemon` when it has that option: since 0.161 its shared background server fails to start for the winget and Codex app builds.

![A browser beside the session. Claude sees it too](promo/en/03-browser.png)

- **Built-in browser (Windows).** Pick an element on a page and drop it into your prompt. Claude looks at the same page with the `browser_view` tool. Open it in its own tab or as a pane right of the session you are working on (the globe button on a pane). A session on another PC works too: when Claude there calls `browser_view`, the ChoiBuddy app with its browser open answers, whichever PC it runs on.

![Every image Claude saw, by PC and session](promo/en/05-gallery.png)

- **Images.** Every picture and screenshot Claude opened, PC by PC and session by session. GIFs play. Save them to your device, remove them or clear a PC's list.
- **Keyboard.** Ctrl+PageUp and Ctrl+PageDown move between the tabs.
- **Updates.** The apps ask GitHub for a newer release at every start, every 6 hours, when you come back to the app after half an hour, and whenever you press "Check for updates" in settings. A newer one shows in the top bar.
  - Windows downloads and installs it, then starts again. The bridge, hooks and mod follow by themselves once no approval is waiting, and Auto Accept stays on.
  - The phone downloads the APK for you to install.

![Edit CLAUDE.md and AGENTS.md in place](promo/en/06-docs.png)

- **Docs.** View, edit and create `CLAUDE.md`, `AGENTS.md` and subagent definitions, PC by PC (buddies on the left) and project by project, with conflict checks and backups.

![Right there on your phone](promo/en/07-phone.png)

- **Android app.** The same screens over Tailscale, wherever you are. Approval notifications with Allow and Deny buttons, a notification when a session finishes, and the back button closes what is open before it leaves the app.

![Your buddy on the home screen](promo/en/09-widget.png)

- **Home-screen widget (Android).** The buddy in its current pose, the session, what it is doing, the elapsed time and your 5-hour and weekly usage. A session waiting for approval comes first. Make it bigger to see two more sessions, or smaller for just the buddy and the state.

![A tiny buddy in the corner](promo/en/08-float.png)

- **Floating buddy (Windows).** Approvals, progress and results in speech bubbles. Drag it wherever you like. Right-click it to open ChoiBuddy, turn the sound on or off, reset its position, hide it or quit.
- **Several PCs.** Watch the bridges on all your PCs together. Turn on **Connect my Tailscale devices automatically** in a PC's danger zone and your other devices on the same Tailscale account connect to it without a code (a phone needs one PC paired by QR first).
- **Auto Accept.** Allow permission requests automatically for a set time.

## Getting started

You need:

- Claude Code
- [Tailscale](https://tailscale.com) on the PC and the phone, for the phone or other PCs. The apps put it there for you: **Install** in the **＋** tab runs winget on Windows and opens the Play Store on the phone. You only sign in.

Nothing else: the Windows app brings its own Node.js 24 for the bridge and Claude Code's hooks, so no Node install is needed.

Steps:

1. **Windows app.** Install `ChoiBuddy_<version>_x64-setup.exe` and press **Connect to Claude Code**.
   - It copies the bridge and the app's Node.js to `~/.choibuddy/app` and adds hooks to `~/.claude/settings.json`. The original file is backed up first as `settings.json.choibuddy-backup-<time>`.
   - It also installs the companion mod. Sessions that were already open show a "Reload plugins" button in the chat (or run `/reload-plugins` in them).
   - The installer is not code-signed. If SmartScreen warns, choose **More info → Run anyway**.
   - **macOS** (no release yet): build it from this repository (see [Building](#building)), open the `.dmg` and drag ChoiBuddy to Applications. The app is not signed, so open it the first time with right-click → **Open**. The Mac app brings its own Node.js 24 too. **Install** for Tailscale opens its download page. The in-app browser and in-app updates are Windows only. The first time you open a new session, macOS asks to let ChoiBuddy control Terminal.
2. **Phone.**
   - Install `ChoiBuddy-<version>.apk`; Android asks you to allow installs from your browser or file app.
   - In the Windows app, open the **＋** tab, press **Create a pairing code** and scan the QR with the phone app.
   - The PC and the phone must both be signed in to Tailscale.
3. **Other PCs.** Install ChoiBuddy there as well, create a pairing code on that PC, and paste its link into **Other PCs** on this one. A phone scans one QR per PC.

Without the Windows app, from a clone of this repository (needs Node.js 24 or later; the bridge keeps a copy of the Node that installed it):

```
corepack pnpm install
corepack pnpm install-bridge     # bridge, hooks and mod
corepack pnpm uninstall-bridge   # removes the hooks and stops the bridge
```

## Security

- **Hooks.** Only Claude Code on this PC can send hooks (`/hook`): the bridge takes them from 127.0.0.1 only and refuses requests that carry a browser `Origin` header.
- **The bridge is not on your LAN.** It listens only on 127.0.0.1 and your Tailscale address (100.64.0.0/10).
- **Access codes.**
  - Every screen API needs a code. The PC app's own code is in `~/.choibuddy/config.json`.
  - Phones and other PCs each get their own code, and only its hash is stored. You can cut devices off one by one, or replace every code at once.
  - On the phone, a `choibuddy://` link always asks before it adds a PC, so a web page can't pair it quietly.
- **Remote prompts.** Only a device with a code can send prompts. In bypass mode, a prompt runs on the PC, so treat a code like access to the PC.
- **Files.**
  - **Uploads** go to `~/.choibuddy/uploads`, with path characters stripped from their names.
  - **Images** are limited to files Claude actually opened and screenshots tools returned; no other path can be requested. SVGs are sent isolated so their scripts can't run.
  - **Deleting** a conversation moves only a finished session's transcript to `~/.choibuddy/trash`. Removing an image only changes the list; just the screenshots the bridge saved are deleted.
- **Docs tab.** It only reads and writes instruction files with known names, by their id from the list, up to 1 MB. Each file is backed up to `~/.choibuddy/doc-backups` before it is saved. Instruction files change how Claude behaves, so a device with a code has that much power too.
- **Auto Accept.** It lives in memory only, so it turns off when the bridge restarts. It allows ordinary permission requests only; questions and plans always need a person.
- **Connecting Tailscale devices automatically.** Off unless you turn it on for this PC. A device then gets a code of its own only over Tailscale, and only when Tailscale says it is signed in to the same account as this PC. Devices shared with you and tagged devices are left out. Each one shows in the device list and can be cut off, and turning the option off cuts all of them. Anyone who can sign in to your Tailscale account could connect, so keep that account safe.
- **Ending a session** and **reloading its plugins** send `/exit` and `/reload-plugins` through the companion mod, the same as typing them in the terminal. **Stop** asks the mod to end the running turn, the same as Esc. Any device with a code can do these.
- **Demo bridges.** A bridge started with `CHOIBUDDY_HOME` (a demo, screenshots) stays off the tailnet: it does not listen there and does not look for your other PCs, so a test screen never pairs with a real bridge.
- **Codex.** ChoiBuddy writes its hooks to `~/.codex/hooks.json` only when you press "Connect Codex" on this PC (not from a phone), keeps your own hooks there, and saves the file before to `hooks.json.bak`. Codex runs only hooks it trusts: pressing the button also asks Codex's own app-server (`codex app-server`, `hooks/list` then `config/batchWrite`) to trust ChoiBuddy's hooks, as `/hooks` would, and nothing else. When an update changes the hooks, the bridge writes and trusts them again, only while connected. An approval answer to Codex is only allow or deny.
- **Auto language** reads only the reply text Claude Code hands to its Stop hook, decides the language on the bridge (code, paths and links left out), and sends one prompt through the companion mod. Any connected device may turn it on or off. Names and the archive live in `~/.choibuddy/sessions.json`; Claude Code's transcripts are not changed.
- **Terminals.** A terminal in the app runs whatever is typed into it, as you on that PC. A prompt for Codex opened in the app's terminal is typed into that terminal as text, control characters left out, so a message can't turn into key presses.
  - The PC's own app can always use them. Phones and other PCs can only after you turn on **Terminals from other devices** in that PC's danger zone (off by default, PC app only). Turning it off, cutting a device off or replacing the codes closes their open terminal screens at once.
  - A first prompt for Codex reaches it as one plain string: quotes (also typographic ones) and control characters can't break out into the shell.
  - A new window on the PC opens only when the folder exists, and starts without going through a shell (the program and its arguments are passed separately). Codex gets no first prompt there.
- **Built-in browser.** Pages get no access to the app's IPC; a page can only send the app the element you picked and its address. Claude's `browser_view` calls are answered by a connected ChoiBuddy app with its browser open (this PC's, or another PC's that has this one connected); the first answer counts. A device that may send prompts may show Claude a page too. An app whose browser is closed waits 3 seconds before saying so, so an open one answers first.

## Good to know

- With `bypassPermissions` as the default mode, ordinary permission requests never come up. Questions (AskUserQuestion) and plan approvals still do.
- If the bridge is down, a hook can leave a failure message. The bridge starts again by itself when a session starts or a prompt is sent.
- Live code, usage and remote prompts need the companion mod. After installing or updating it, sessions that were already open need `/reload-plugins` once: the chat offers a button for it, or type it in the terminal.

## Project layout

| Folder | What is in it |
| --- | --- |
| `bridge/` | Node 24 server. It turns hooks into state and holds approval requests until someone answers. Its one dependency, node-pty, is only for the in-app terminal |
| `shared/protocol.ts` | The data types the bridge and the screens share |
| `ui/` | The screens (React). The Windows and Android apps use the same build |
| `windows/src-tauri/` | The Windows widget (Tauri 2): frameless window, tray, always on top, start with Windows |
| `android/` | The Android app: the screens in a WebView, approval notifications and the home-screen widget |
| `mod/` | The companion mod that runs inside Claude Code: usage, model and effort, remote prompts and slash commands, the live stream, the `browser_view` tool |
| `scripts/demo.ts` | Feeds made-up work to a bridge, for checking the screens |

## Building

```
corepack pnpm test         # bridge tests
corepack pnpm typecheck    # bridge and screens
corepack pnpm build        # screens (ui/dist)
corepack pnpm tauri build  # Windows installer, or on macOS the .app and .dmg (first fetches that OS's Node.js into windows/src-tauri/runtime, checked against a pinned SHA-256, and copies node-pty beside it)
cd windows/src-tauri; cargo test
cd mod; claude plugin validate .; claude plugin test .
cd android; .\gradlew.bat --no-daemon testReleaseUnitTest assembleRelease lintRelease   # JDK 21 in JAVA_HOME
```

To look at the screens without real work, start a bridge on a spare port with `CLAUDE_CONFIG_DIR` set to `<temp>/choibuddy-demo/claude`, run `node scripts/demo.ts --port <port> --scene read|edit|bash|done|pending|question|plan|multi|agents|images|live|reply|command`, and open `http://localhost:1430/#choibuddy://pair?u=...&t=...` in a browser. See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## License

The code is under the [MIT License](LICENSE). The Windows app ships Node.js, which has its own license (installed next to it as `runtime/LICENSE`). The ChoiBuddy character artwork (the buddy drawings, app icons and promo images) is not covered by it; see [ARTWORK.md](ARTWORK.md).
