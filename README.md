# Pi Learn, in your browser

A friendly web interface for [Pi Learn](https://github.com/amosblomqvist/learn), Amos Blomqvist's AI tutoring system ([video](https://www.youtube.com/watch?v=kzcI5F4tGiU)).

The original runs inside the [pi](https://github.com/earendil-works/pi) coding agent in a terminal, with tmux and Obsidian open beside it. This app runs the same teaching method in one browser window:

- **Lessons that read well.** Math renders as proper LaTeX, and diagrams appear inline. No Obsidian needed.
- **Clickable quizzes.** Graded questions show up as cards with instant ✓/✗ feedback, the right answer, and an explanation. There's always an "I don't know" button and an optional note for your tutor.
- **Clickable questions.** When the tutor asks what you want, you tap an option or type your own.
- **All your lessons saved.** Pick up any past lesson from the sidebar, or download it as a Markdown file.
- **Any AI provider.** Sign in with a Claude Pro/Max or ChatGPT plan, or paste an API key (Anthropic, OpenAI, Google Gemini, OpenRouter and 30+ others).

## Getting started

You need **Node.js 22.19 or newer**. If you don't have it, download the **LTS** version from [nodejs.org](https://nodejs.org) and install it like any other app.

### The easy way

1. On this repository's GitHub page, click the green **Code** button, then **Download ZIP**. Unzip it somewhere you'll find again.
2. Open the folder and double-click:
   - **Mac:** `start.command`. If macOS says it can't be opened, right-click it, choose **Open**, then **Open** again.
   - **Windows:** `start.bat`. If Windows SmartScreen warns you, click **More info**, then **Run anyway**.
3. The first start installs everything, which takes a minute or two. Then your browser opens at <http://127.0.0.1:4747>.
4. Settings opens automatically the first time. Connect an AI provider, pick a model, close Settings, and type what you want to learn.

Leave the terminal window open while you use Pi Learn. Close it (or press <kbd>Ctrl</kbd>+<kbd>C</kbd> in it) to stop.

### From a terminal

```bash
git clone https://github.com/mryeburn/pi-learn-userfriendlyinterface.git
cd pi-learn-userfriendlyinterface
npm install
npm start
```

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
- On first start it downloads Amos's teaching method (`skills/teach/SKILL.md`) straight from [his repository](https://github.com/amosblomqvist/learn) and keeps it up to date. It's not copied into this repo.
- The method is always on: it's added to the tutor's instructions along with a short note about how this interface differs from the terminal setup.
- The terminal popups for `quiz` and `ask_user_question` are replaced by browser versions with the same names, inputs and results, so the method works unchanged. The correct answer never reaches the browser until you've answered.
- The tutor has no file or shell access. It can only talk to you and ask questions.
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

The teaching method, the `quiz` and `ask_user_question` tool designs and the whole idea are by [Amos Blomqvist](https://github.com/amosblomqvist/learn). This project only provides a different interface to them. Amos's repository doesn't currently include a license, so this app fetches his teaching skill from his repository at runtime rather than redistributing it.
