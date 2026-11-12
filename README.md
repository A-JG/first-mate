# First Mate

Yer crew of Claude agents, at the captain's word.

First Mate lets you run Claude Code agents by voice through your earbuds while you are out walking. You speak an order and finish it with **"fire the cannons"**. A small model works out which project it is for and reads it back to you. On **"aye aye"**, an agent sets to work in that project folder, on your own computer, using your Claude subscription.

Finished work waits in a queue, first come first served. Nothing is ever announced while you are talking. When you are ready, say **"parley"** to hear the next report.

```
 phone (First Mate app)                 your computer (dispatcher)
 ───────────────────────                ─────────────────────────────────────
 earbud mic ──audio──────── Tailscale ──▶ speech recognition (local Whisper)
 earbud ear ◀──speech──────            │        │
 screen: ship's log, karaoke           │        ▼
                                       └──── the radio net ──▶ claude -p agents
                                                                in ~/Projects/*
```

Your voice never leaves your own devices. The phone streams the mic to your computer over your private Tailscale network, and the computer transcribes it locally. Only the agents' normal Claude requests go out.

## Setting sail (one-time setup)

### On the computer

```bash
npm install
```

```bash
npm run setup:speech
```

That second command installs local speech recognition and downloads the Whisper `small.en` model, about 480 MB. Then start the dispatcher:

```bash
npm start
```

To keep it running in the background and start it at login:

```bash
npm run service:install
```

The project folders it can work in are the subfolders of `~/Projects`. To change that, edit `projectRoots` in `config.json`.

### On the phone (Android)

1. Install **Tailscale** from the Play Store and sign in to the same account as the computer.
2. Install First Mate. Either:
   - **Over Tailscale:** in Chrome on the phone, open `http://<computer's Tailscale IP>:7373/firstmate.apk` (the dispatcher prints the exact link when it starts). Allow Chrome to install unknown apps when Android asks, then install.
   - **Over USB:** turn on Developer options and USB debugging, plug in, and run `adb install android/build/FirstMate.apk`.
3. On the computer, open <http://localhost:7373/pair> for a six-digit code. You can also print one with `npm run pair`.
4. Open First Mate on the phone, check the server address (already filled in with this computer's Tailscale address), type the code, and tap **Come aboard**.
5. Allow the microphone and notifications. First Mate stays **on air** in the notification until you stop it, with the screen off and the phone in your pocket.

## A fleet: projects on other computers

First Mate can send work to projects on your other computers too, such as a laptop. Each computer runs its own First Mate dispatcher next to its own projects. The phone talks to one of them, the **hub**. The hub lists the other computers' projects beside its own. Work in a laptop project runs on the laptop, and its reports, approvals and crew activity come back to the hub as if they were local.

```
 phone ── hub dispatcher (this PC) ───── Tailscale ─────▶ laptop dispatcher
          radio, backlog, voice                           its projects, claude -p,
          its own projects                                its own Claude login
```

### Linking a laptop

1. On the laptop: install First Mate (`npm install`), and give it a name in its `config.json`, for example `"name": "laptop"`. It needs no speech or voice setup, so you can also set `"speech": false`. Start it with `npm start` or `npm run service:install`, and make sure Claude Code is logged in there.
2. On the laptop, get a pairing code: open <http://localhost:7373/pair>, or run `npm run pair`.
3. On the hub, run this with the laptop's Tailscale name and the code:

   ```bash
   npm run peer -- add "laptop" laptop 123456
   ```

   The key is kept in `data/peers.json` on the hub. `npm run peer -- list` shows each computer and whether it is answering. `npm run peer -- remove "laptop"` unlinks it.

You can also list peers in `config.json` by hand: `"peers": [{ "name": "laptop", "url": "http://laptop:7373", "token": "<the laptop's data/token>" }]`.

### Talking to it

A laptop project is read back with where it runs: "Aye. Release notes on laptop, Cookie takes it." If the laptop is asleep or off the tailnet, First Mate says so in the read-back, and the order comes back as an error if you send it anyway.

**Picking up an existing Claude Code session.** First Mate also knows the recent Claude Code sessions in each project, on every linked computer, by the names you see in Claude Code. Say "In release notes, continue the release notes session: add a skills table, over and out." The read-back names the session, and the agent carries on with that session's whole conversation behind it.

If that session is **open right now** somewhere, for example in a terminal or under Remote Control, First Mate warns you and works on a **copy** of it instead (Claude Code's `--fork-session`). Two programs writing into one session at once would tangle its transcript, and the open window would not see First Mate's turns anyway. The copy has the full history up to that point. Pick it up in Claude Code later with `claude --resume`.

### How the link works

This is a design note for anyone changing it.

- **Why a dispatcher on each computer.** Claude Code has no supported way to list or message a session on another machine. There is no CLI, SDK or API for Remote Control sessions, and `claude --resume` only sees the transcripts on its own disk. So each computer runs `claude -p` itself, with its own login, its own permission settings and its own files. The hub only routes orders and collects the results.
- **Pairing** uses the same six-digit code flow as a phone (`POST /pair`). The hub ends up with the laptop's key and sends it as `x-firstmate-token`. Over Tailscale the peer API refuses any request without that key. Only the hub's own machine can add or remove peers (`/peers` is loopback only).
- **Peer API** (`src/peers.js`):
  - `GET /peer/info` returns the computer's name, its projects and its recent sessions. These are its own only, never its peers', so links cannot loop.
  - `POST /peer/turn` runs one agent turn and streams it back as lines of JSON: trimmed tool activity for the crew display, approval requests, keep-alive pings, and the final result.
  - If the connection drops mid-turn, for example a laptop on flaky wifi, the hub reattaches with `GET /peer/turn?id=…&after=…`. The laptop keeps each turn's events for an hour, so nothing is repeated or lost. The hub keeps trying for 15 minutes before it reports the turn as lost.
  - `POST /peer/approve` carries your answer to an approval back to the laptop.
- **Where it plugs in.** The radio procedure (`src/radio.js`) is unchanged, apart from passing the session list to the router and reading back the warnings. The seam is the `runTurn` function in `src/server.js`. A thread with a `host` runs through `Peers.runTurn`, and every other thread runs through the local `claude -p`. The laptop's approval bridge recognises turns it runs for a hub (`peer:<turn>`) and asks the hub's operator instead of its own.
- **What the laptop decides.** It only runs in folders inside its own project roots. It uses its own `permissionMode` and `allowedTools`. The hub sends the instruction, the model, the effort and the crew member's voice.
- **Sessions** (`src/sessions.js`) are read from `~/.claude/projects/<folder>/<id>.jsonl`. The title comes from the session's display name, or else its custom title, or else its first prompt. Worktree sessions count under their project. A session is "open right now" when a live Claude Code process lists it in `~/.claude/sessions/<pid>.json`. These files are not a documented interface, so they are read defensively.
- **Not covered yet:** starting a brand-new project ("maiden voyage") on another computer, since new projects are made on the hub. The hub also does not relay one laptop's peers to another.

## The ship's articles (what you can say)

| Say | It does |
|---|---|
| **fire the cannons** (or **over and out**) | Ends your order and sends it. Nothing is sent until you say it, so you can pause and speak in pieces. A plain "over" inside your order is just a word. |
| **aye aye** | Yes: confirm a read-back, approve a request, acknowledge a report. |
| **walk the plank** / **belay that** | No: scrap a read-back or what you are dictating, or deny a request. "Belay that, use yarn instead, fire the cannons" denies and says why. |
| **parley** | Hear the next waiting report. |
| **more grog** | One more detail from the report on the air. |
| **parrot** | Say that again. |
| **stow it** | Put this report at the back of the line. |
| **Davy Jones** | This crew member's work is finished; free its name. |
| **drop anchor** / **weigh anchor** | Hold all announcements / carry on. |
| **crow's nest** | Who is working and what is waiting. |
| **ahoy** | Connection check. |
| **maiden voyage …** | Start a brand-new project: "Maiden voyage, call it bird log, list sightings by day, fire the cannons." |
| **set sail …** | Start a new thread in a project you name. |
| **Kraken, …** | Start with a crew name to speak to that thread directly. |
| **avast** | Interrupt First Mate mid-sentence (see below). |
| **steady as she goes** | Carry on with the report you interrupted. |

### Interrupting

While First Mate is speaking, it only listens for **avast**. Anything else you say is shown greyed out in the ship's log and ignored, and so is its own voice if the mic picks it up. Saying "avast" stops it at once and notes exactly where you cut in. Then say what you need:

- **A clarification or question about that work** goes to that agent, along with what you had heard and what you had not heard yet.
- **A new idea** becomes a new thread, in the same project unless you name another. Once it is confirmed or scrapped, First Mate goes back to the report from the sentence you interrupted.
- **"Never mind", or "go on"** carries on the report.

You can also say it in one breath: "Avast, use the other library, fire the cannons." The **Avast** button on screen and in the notification does the same thing. A press of the earbud button should too, but that is not tested on real earbuds yet.

### Reports and approvals

Agents report in a short spoken block: a headline first, details on **more grog**, and at most one question. Facts stay in plain English; the pirate is only in the trimmings. Technical names show highlighted on screen.

Agents may edit files in their project freely. Running commands, or anything outside the project, comes to you as a spoken approval: "Kraken asks leave to run a command. Run the test suite. Aye aye, or walk the plank?"

## On the screen

- **The ship:** the crew at work, in 3D. Each pirate walks to wherever their kind of work happens: the chart table for reading, the carpenter's bench for editing, the cannons for running commands, the crow's nest for the web, the rigging when directing helpers, the helm when thinking. One knocking at the cabin door has a report or asks leave; one under a rain cloud at the bow hit trouble; one dozing is off duty. Tap a pirate for plain words on what they are doing. It is night at sea in dark mode and a daylight chart in light mode, holds still if your device asks for reduced motion, and stops drawing when scrolled out of view. Where 3D is not available the flat ship is shown instead. (`public/ship3d.js`, with three.js kept in `public/vendor` so it needs no internet.)
- **Ship's log:** the live transcript. Each line lights up word by word as it is spoken, so you can read along. Command words are underlined in brass; tap one to see what it means.
- **Ship's articles:** the word guide above. Fold it away when you know the words.
- **Awaiting the captain:** the queue of reports and approvals.
- **The crew:** each agent thread and whether it is working.
- **Rigging** (phone only): choose the voice, turn the earbud microphone on or off, stop the radio, or unpair.

The same page works at <http://localhost:7373> on the computer, where you can type instead of speaking.

## Settings (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `pack` | `pirate` | Language pack in `packs/`: the words, the crew names and how First Mate talks. `orchestra` is the other one. |
| `projectRoots` | `["~/Projects"]` | Every folder inside these is a project. |
| `allow` | `tailscale` | Who may connect: this computer and your tailnet. `lan` also allows the home network. |
| `port` | `7373` | |
| `routerModel` | `haiku` | Model that routes orders and sorts interruptions. |
| `agentModel` | (Claude Code default) | Model for the agents themselves. |
| `sttModel` | `small.en` | Whisper model. `base.en` is faster but less accurate; `medium.en` is slower but more accurate. |
| `permissionMode` | `acceptEdits` | Claude Code permission mode for agents. |
| `allowedTools` | `[]` | Commands agents may run without asking, for example `["Bash(npm test:*)"]`. |
| `name` | the computer's hostname | What this computer is called when another dispatcher links to it. |
| `peers` | `[]` | Other computers' dispatchers, by hand. Most people use `npm run peer -- add` instead. |
| `speech` | `true` | `false` skips speech recognition and the voice, for a computer that only runs work for a hub. |

## When the seas get rough

- **"No sight of the ship" in the app:** check that Tailscale is on, on both devices, and that the dispatcher is running (`npm start`, or `systemctl --user status firstmate`).
- **"Key refused":** pair again with a fresh code from <http://localhost:7373/pair>.
- **It mishears a word:** add the misheard spelling under `mishearings` in `packs/pirate.json`.
- **The voice:** pick another under Rigging. British voices that work offline are tried first.
- **Logs:** `journalctl --user -u firstmate -f` when running as a service.

## Building the app yourself

```bash
npm run build:apk
```

This uses the Android SDK's own tools, with no Gradle and no libraries, and writes `android/build/FirstMate.apk`. The signing key is created once in `android/firstmate.keystore`; keep it, so later builds install over the old one.

```bash
npm test
```
