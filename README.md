# Prompt Splitter

A Chrome side-panel extension that helps you manage **large batches of video prompts** on an AI video generation website: split a bulk text into individual prompts, organise them by project and category, fill the generation form for you, and download finished videos into tidy, serial-numbered folders.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by any website it works with. It was written against the site's current page layout, which can change at any time and break features. Use it at your own risk and follow the site's terms of service.

## What it does

- **Bulk import and split.** Paste 100 prompts at once (or import a `.txt`/`.md` file) and get 100 separate prompts. Auto mode understands `####` boxes, `---` separators and `Prompt N` headings. You can also split by blank line, by a custom line prefix, or keep the whole text as one prompt.
- **Projects and categories.** Every bulk import becomes a category inside the active project. Add more prompts to an existing category later with the **＋** button.
- **Progress marks.** Copied, Assigned, Downloaded and Failed marks per prompt, with clear and bulk-clear.
- **Edit and delete prompts.** Editing resets that prompt's marks so it can be generated again.
- **Auto setup.** One click sets model, duration, resolution, aspect ratio, *Generate Audio* and Image-to-Video mode on the page.
  - **Global setup** (Setup tab) or a **specific setup per category**.
  - Optionally saves reference image ids and sends them with your Generate request in Image-to-Video mode.
- **Assign prompt / Assign + setup.** Pastes the prompt into the site's textarea (optionally after applying the setup). **You press Generate yourself.** The extension never clicks it.
- **Job tracking.** Passively reads the site's own `/api/generate` and `/api/jobs*` responses so each prompt gets a **View video** button that opens the result page for that job.
- **History page helpers.** Cards on the History page get a `Project › Category › serial` label, failed generations are marked red, and each card gets a **＋ Download list** button.
- **Download list and runner.** Download everything in project → category → serial order, with retries, per-row retry, cancel pending, and waiting for the site's own "Downloading…" to finish.
- **File naming.** Files are renamed to `Project/Category/NN - Episode N.mp4` inside Chrome's Downloads folder.
- **Light and dark theme** toggle.

## What it does not do

- It does **not** send generation requests on its own, run a queue, or click Generate.
- It does **not** solve, bypass or fake captchas (for example Cloudflare Turnstile).
- It does **not** send your prompts, cookies or tokens anywhere. All data stays in `chrome.storage.local` in your browser.
- It cannot save outside Chrome's Downloads folder (extensions are limited to it). Change Chrome's default download location, or use the **Base subfolder** option.

## Install (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Pin the extension and click its icon. The side panel opens.
5. Log in to the video site and open the Text-to-Video or Image-to-Video page.

After editing any file, click the reload icon on the extension card, then reload the site tab.

## Quick start

1. **Prompts tab → + Bulk import.** Name the category, paste your text, check the "Will create N prompt(s)" count, then **Split & add to project**.
2. **Setup tab.** Choose your usual model, duration, resolution, ratio and audio, then **Save**.
3. On the site, click **Assign + setup** next to a prompt. The form is configured and the prompt is pasted.
4. Press **Generate** on the site yourself.
5. When the job id is picked up, a **View video** button appears on the prompt.
6. Open the **History** page, press **＋ Download list** on the cards you want, then in the **Download tab** press **Download all**.

## Project layout

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 definition, permissions, content scripts |
| `background.js` | Service worker: job tracking, download renaming, download list |
| `hook.js` | Runs in the page (MAIN world); observes `fetch`/XHR and injects reference ids |
| `relay.js` | Content script that forwards page messages to the background |
| `history.js` | Content script for the History page (labels, buttons, failure marks) |
| `sidepanel.html/css/js` | The side-panel UI |
| `parser.js` | Splits bulk text into prompts |
| `theme.js` | Light/dark toggle |

The UI follows the [shadcn/ui](https://ui.shadcn.com) design tokens, reimplemented in plain CSS so there is no build step.

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | Show the UI in the side panel |
| `storage` | Save prompts and settings locally |
| `clipboardWrite` | Copy prompt buttons |
| `scripting` | Fill the form and read the result page on the target site |
| `tabs` | Find the site tab, open result pages |
| `downloads` | Rename and place downloaded videos |
| Host permission (see `manifest.json`) | The only site the extension runs on |

## Known limitations

- Selectors and text matching (model picker, library modal, download button, "Downloading…" status) depend on the site's current HTML and may need updating when it changes.
- The experimental reference-image picker in the site's library modal may not work on every layout.
- Not published on the Chrome Web Store; installation is via developer mode.

## Contributing

Issues and pull requests are welcome. When the site's layout changes, the most useful report includes the relevant HTML snippet (remove any personal data first).

## License

Add a `LICENSE` file before publishing (MIT is a common choice).
