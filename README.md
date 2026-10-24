# Pi Learn, in your browser

A friendly web interface for [Pi Learn](https://github.com/amosblomqvist/learn), Amos Blomqvist's AI tutoring system ([video](https://www.youtube.com/watch?v=kzcI5F4tGiU)).

The original runs inside the [pi](https://github.com/earendil-works/pi) coding agent in a terminal, with tmux and Obsidian open beside it. This app runs the same teaching method in one browser window:

- **Lessons that read well.** Math renders as proper LaTeX, and diagrams appear inline. No Obsidian needed.
- **Clickable quizzes.** Graded questions show up as cards with instant ✓/✗ feedback, the right answer, and an explanation. There's always an "I don't know" button and an optional note for your tutor.
- **Clickable questions.** When the tutor asks what you want, you tap an option or type your own.
- **Learn from your own materials.** Use the 📎 button to add PDFs, Word documents, text files or web links. The tutor asks whether to teach only from them or from them plus what it knows.
- **Time to ask questions.** After each quiz answer the lesson waits for you to click **Next question**, and the tutor checks for questions before each new section.
- **All your lessons saved.** Pick up any past lesson from the sidebar, or download it as a Markdown file.
- **Any AI provider.** Sign in with a Claude Pro/Max or ChatGPT plan, or paste an API key (Anthropic, OpenAI, Google Gemini, OpenRouter and 30+ others).

## Getting started

Each installer sets up everything Pi Learn needs (including its own copy of Node.js) and adds a **Pi Learn** icon. No other software is needed. Run it again any time to update to the latest version; your lessons and sign-ins are kept.

### Windows

1. Press the <kbd>Windows</kbd> key, type `PowerShell`, and press <kbd>Enter</kbd>.
2. Copy this line, paste it into the PowerShell window (right-click pastes), and press <kbd>Enter</kbd>:
   ```powershell
   irm https://raw.githubusercontent.com/mryeburn/pi-learn-userfriendlyinterface/main/scripts/install-windows.ps1 | iex
   ```
3. When it says **Done!**, close the window and double-click **Pi Learn** on your desktop (it's in the Start menu too).

### Mac

1. Press <kbd>⌘ Command</kbd>+<kbd>Space</kbd>, type `Terminal`, and press <kbd>Enter</kbd>.
2. Copy this line, paste it into the Terminal window, and press <kbd>Enter</kbd>:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/mryeburn/pi-learn-userfriendlyinterface/main/scripts/install.sh | bash
   ```
3. When it says **Done!**, close the window and click **Pi Learn** in your Dock.

### Chromebook

1. Turn on Linux, once: open **Settings**, go to **About ChromeOS** › **Developers** (on older Chromebooks, **Advanced** › **Developers**), and next to **Linux development environment** click **Set up**. Follow the steps; it takes a few minutes.
2. Open the **Terminal** app, then click **penguin**.
3. Copy this line, paste it into the Terminal (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>), and press <kbd>Enter</kbd>:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/mryeburn/pi-learn-userfriendlyinterface/main/scripts/install.sh | bash
   ```
4. When it says **Done!**, close the Terminal. Open the launcher, go into the **Linux apps** folder, and click **Pi Learn**. Right-click it and choose **Pin to shelf** to keep it handy.

The same command works on other Linux computers (Debian or Ubuntu based).

### First start

Pi Learn opens in your browser at <http://127.0.0.1:4747>, and Settings opens automatically the first time. Connect an AI provider, pick a model, close Settings, and type what you want to learn.

To update to the newest version, open **Settings** and click **Update now** when an update is available (or run the install command again).

Pi Learn keeps running quietly in the background after you close the browser tab, so the icon opens it instantly next time. Restarting the computer stops it.

### Without the installer

You need **Node.js 22.19 or newer** from [nodejs.org](https://nodejs.org) (the **LTS** version). Then either:

- Download this repository (green **Code** button › **Download ZIP**), unzip it, and double-click `start.command` (Mac) or `start.bat` (Windows). Leave the window that opens running while you use Pi Learn.
- Or, in a terminal:
  ```bash
  git clone https://github.com/mryeburn/pi-learn-userfriendlyinterface.git
  cd pi-learn-userfriendlyinterface
  npm install
  npm start
  ```

### Where things are

| | Mac and Linux | Windows |
|---|---|---|
| The app | `~/pi-learn` | `%USERPROFILE%\pi-learn` |
| Lessons, settings, Node.js and the log (`app.log`) | `~/.pi-learn-web` | `%USERPROFILE%\.pi-learn-web` |
| AI sign-ins | `~/.pi/agent/auth.json` | `%USERPROFILE%\.pi\agent\auth.json` |

To uninstall, delete the `pi-learn` and `.pi-learn-web` folders and the Pi Learn icon.

## Which AI should I connect?

The tutor is only as good as the model behind it. A strong model (such as Claude Sonnet or Opus, or a recent GPT or Gemini Pro model) teaches much better than a small, cheap one.

- **Already pay for Claude Pro/Max or ChatGPT Plus/Pro?** Click **Sign in** next to Anthropic or OpenAI. A sign-in page opens in a new tab; once you approve, you're connected.
- **Want to pay as you go?** Create an API key with the provider (for example at [console.anthropic.com](https://console.anthropic.com)) and click **API key**.
- **Want to try it free?** Google offers a free Gemini API key at [aistudio.google.com](https://aistudio.google.com).

Sign-ins are stored only on your computer, in pi's usual place (`~/.pi/agent/auth.json`), so if you already use pi in the terminal you're signed in here too.

## How it works

```
Browser (React)  ⇄  WebSocket  ⇄  Local Node server  ⇄  pi SDK  ⇄  your AI provider
```

- The server embeds pi through its SDK and runs one lesson at a time.
- The tutor follows LILA's own teaching method in [`teaching-instructions.md`](teaching-instructions.md). Edit that file to change how it teaches.
- The method is always on: it's added to the tutor's instructions along with a short note about how this interface differs from the terminal setup.
- The terminal popups for `quiz` and `ask_user_question` are replaced by browser versions with the same names, inputs and results, so the method works unchanged. The correct answer never reaches the browser until you've answered.
- The tutor has no file or shell access. It can only talk to you and ask questions.
- Pictures: besides the diagrams the tutor draws, the app makes sure the lesson stays visual. A long explanation, or every other answered quiz, that comes without a picture gets one from separate small AI requests. Real images come first: when a lesson starts, the app gathers a library of real images for its topic (the pictures in the main Wikipedia article and a few related ones, plus Wikimedia Commons and the NLM's Open-i), and each picture is chosen from that library plus one search aimed at that part of the lesson. The AI draws a diagram or chart only when nothing relates, and never twice in a row while real images remain. Under each tutor message there's a 🖼 **Show me a picture** button. Pictures are saved next to the lesson file (`*.pictures.json`, `*.library.json`), and how each was chosen is written to `~/.pi-learn-web/pictures.log` (Settings › Picture log shows it, ready to copy).
- Updates: Pi Learn checks for a new version when it starts and every few hours. When there is one, a banner at the top offers **Update now**; there's also a **Check for updates** button in the sidebar.
- Questions: after every quiz answer and every teaching section, the page invites the learner to ask questions, with a button to carry on. When a section runs straight into a quiz, the lesson pauses before the question.
- Lessons are saved as pi session files in `~/.pi-learn-web/lessons`. App settings live in `~/.pi-learn-web/settings.json`.
- The server only listens on your own computer (`127.0.0.1`), so nobody else on your network can use your AI account through it.

### Differences from the terminal version

- **No subagents.** The original can hand fact-checking to a `researcher` subagent and diagrams to `mermaid-maker` / `svg-maker` subagents (which needs tmux). Here the tutor draws Mermaid and SVG diagrams itself, which the page renders, and is told to flag anything it isn't sure of instead of verifying it.
- **No Obsidian or md-log.** The page is the reading view. Use the download button (⤓) to save a lesson as Markdown.

### Options

| Environment variable | What it does |
|---|---|
| `PORT` | Port to serve on (default `4747`). |
| `PI_LEARN_DATA_DIR` | Where lessons and settings are stored (default `~/.pi-learn-web`). |
| `PI_LEARN_NO_OPEN=1` | Don't open the browser on start. |
| `PI_LEARN_MODELS_PATH` | Use a different pi `models.json`, for custom or local model endpoints. |

## Developing

```bash
npm install
npm run dev        # server with auto-restart + Vite dev server on http://localhost:5173
npm run typecheck
```

- `server/` is the Node side: `index.ts` (HTTP, WebSocket and sign-in), `tutor.ts` (the pi session), `tools.ts` (browser `quiz` and `ask_user_question`), `prompt.ts` (tutor instructions) and `protocol.ts` (message types shared with the page).
- `web/` is the React page.

## Credits

Inspired by [Amos Blomqvist's Learn](https://github.com/amosblomqvist/learn). The `quiz` and `ask_user_question` tool designs still follow his, and will be rewritten. The teaching method in `teaching-instructions.md` is LILA's own.
