# Retold

The original, retold in your language — laid right over it. Built on the same base as
[Cue](https://github.com/wenjun78/meeting_copilot) (Electron, any
OpenAI-compatible API, OCR on your own machine), for everything that is not a
live call:

| | |
|---|---|
| **Pictures** | Manga pages, scans, screenshots. Speech bubbles are found, the lettering is read and lifted out, and the translation is set in its place in the size, weight, colour and outline of the original — Chinese and Japanese top to bottom in columns read right to left, English left to right. The translated page sits over the original as a layer: slide the overlay to compare, edit any box or any line of text. |
| **Video** | The translation is prepared a minute ahead of where you are, so it keeps up. Subtitles burned into the picture are covered with a black or white box and the translation set on top; otherwise the speech is transcribed and translated. A subtitle track or an `.srt` next to the file is used when there is one. For a video playing in another app, a see-through layer over that app shows the translation. |
| **Web** | A browser tab whose pages are translated in place, keeping links, bold runs and layout. Hover a passage for the original; flip the whole page back with one click; pages keep being translated as they change. |
| **Documents** | Word, PowerPoint and Excel files come back as the same file with the words translated and everything else untouched. PDFs open as pages in the Pictures tab and are saved as a new PDF. Text, Markdown and subtitle files keep their structure and timing. |

## Install it (Windows)

Download **Retold-Setup** from the Releases page and run it. It installs for
your user only (no admin rights). The **portable** file runs without
installing. The build is not code-signed, so Windows SmartScreen asks once:
"More info", then "Run anyway".

## Run from source

Needs Node.js 20 or newer.

```
npm install
npm start
```

`npm test` runs the unit tests. `npm run smoke` starts the real app against a
mock API, has it translate a drawn comic page, a web page and a clip, and
checks what came out (on Linux without a display it uses `xvfb-run`).
`npm run dist` builds the installer into `dist/` (on Windows). Building the
Windows installer from Linux or macOS works too — `npx electron-builder --win
--x64` — but needs the Windows ffmpeg first
(`cd node_modules/ffmpeg-static && npm_config_platform=win32 npm_config_arch=x64 node install.js`)
and wine for the NSIS uninstaller step; the GitHub workflow does all of this
on a real Windows runner for every push to `main`.

## First run

1. **Settings**: choose the service (OpenAI by default; Groq and a local
   Ollama are one click away; any OpenAI-compatible service works) and paste
   its API key. Three models are used: the chat model translates, the image
   model reads lettering off manga pages (blank = the chat model, which is
   fine on OpenAI), and the speech model transcribes video. For video the
   speech model must return timestamps (`whisper-1` on OpenAI,
   `whisper-large-v3` on Groq).
2. Pick the language pair in the title bar. "Detect" lets the model work the
   source out; naming it helps OCR pick the right data.
3. Drop something on the window.

## Pictures

What happens to a page:

1. **Bubbles.** Light, closed shapes that enclose dark lettering are traced at
   full size — the paper of a bubble and everything it encloses. The page's
   own background, gutters and empty panels do not qualify. With "Find speech
   bubbles" off, text anywhere on the page is boxed from OCR instead, and you
   can always draw a box by hand (turn on *Edit boxes* and drag).
2. **Reading.** Each bubble goes to the image model, which reads the text in
   its original script and says which way it runs (vertical Japanese is the
   usual case). Or, with "Tesseract on this computer" chosen, OCR runs here:
   for Chinese and Japanese both the top-to-bottom and the left-to-right models
   are tried and the better reading kept. Language data is downloaded once
   (from jsDelivr, or from the npm registry where the CDN is blocked).
3. **Translation.** All bubbles of the page go to the chat model together, in
   reading order (right to left, top to bottom for manga), with the previous
   page's last lines as context, so pronouns and running jokes come out right.
   Everything translated is kept in a translation memory, so a chapter's
   recurring sound effect or a re-opened page costs nothing the second time.
4. **Lifting the lettering.** Inside a bubble the ink is replaced by the paper
   colour. On art (a sound effect over a drawing) the letters are told from the
   drawing by colour — lettering is one colour, or two with its outline, while
   the picture behind it is many — and the hole is filled from its
   surroundings.
5. **Setting the translation.** The original's size, weight, colour and
   outline are measured and matched. Left-to-right text is wrapped into
   balanced centred lines; top-to-bottom text goes into columns read right to
   left, with punctuation in its vertical forms and Latin words turned on
   their side. "Set" in the toolbar overrides the direction; *CAPS* letters
   English the way most English manga is set. Fonts: a comic lettering font
   is used for Latin text when one is installed (CC Wild Words, Anime Ace,
   Komika Axis, Bangers, else Comic Sans), a CJK sans for Chinese and
   Japanese; both can be named in Settings.

The result is two layers: the original underneath, the translated copy on
top. The **Overlay** slider sets the top layer's transparency, so the
original shows through as much as you like; *Original / Translated* flips
between them. The panel on the right lists every bubble: correct a misread
original and it is translated again; edit a translation and the page redraws
as you type. **Save…** writes the page as shown (PNG), side by side with the
original, every page next to its original, or all pages as one PDF.

Open a folder to translate a chapter in order; *Translate all pages* works
through it.

## Video

Open a file (or drop it on the window). The player starts; translation runs
ahead of the playhead and stays about a minute in front (Settings > Video sets
how far). A seek moves the front; what was done stays done. The pill in the
toolbar shows how far ahead the translation is ready.

Where the words come from, in order of preference:

- a subtitle file next to the video (`name.srt`, `name.en.srt`, `.vtt`) or a
  text subtitle track inside it (MKV, MP4) — translated as text, no
  transcription;
- subtitles **burned into the picture**: the bottom band of the frame is
  sampled once a second and read with OCR (bright letters with a dark edge
  are kept, the picture behind them dropped). Frames showing the same line
  become one cue with the time it was on screen and the box it covered. The
  player paints a black or white box over that place and sets the
  translation in it, so the original line is hidden;
- the **speech**: the sound is transcribed in 20-second pieces (two at a
  time) and the fragments joined into readable lines, shown at the bottom (or
  top) with a translucent background.

Burned-in subtitles and speech are read side by side; where a burned-in line
is on screen, it is the better source (nothing misheard) and the speech under
it is dropped. "Words from" in the toolbar forces one or the other.

**Save subtitles (.srt)** writes everything translated so far with its timing.

### A video playing somewhere else

*Watching in another app?* lists your screens and windows. Pick the one the
video plays in and press Start: a see-through, click-through layer appears over
that screen. Burned-in subtitles are read off the captured picture and covered
with their translation; speech is transcribed after each pause (nothing can be
read a minute ahead of a live picture, so this runs a sentence behind). Pick a
whole screen for the box to land exactly over the original line; for a single
window the translation sits at the bottom of the screen instead. The panel
shows the lines as they come.

## Web

Type an address. **Translate page** cuts the page into runs of text (a
paragraph, a list item, a button label), keeps inline formatting as markers so
links and bold runs come back where they were, and swaps each run for its
translation in a layout-neutral wrapper. The top of the page changes first.
Alt text, tooltips and placeholders are translated too; code, forms and
anything marked `translate="no"` are left alone. Hover a passage to see the
original; *Original / Translated* flips the whole page. With "Keep translating
as the page changes" on, text the page loads later (comments, menus) is
translated as it appears, and so is the next page you open in the tab.

## Documents

Drop a file or press *Open a document…*. For `.docx`, `.pptx` and `.xlsx`
the file is opened as the zipped XML it is: each paragraph's runs are gathered
into one string with markers (so a bold word stays bold), translated, and
written back into the same runs; styles, pictures, tables, headers, footers,
notes and page layout are untouched. You are asked where to save; the default
is next to the original with the language added to the name.

PDFs open as pages in the Pictures tab, with their text and positions already
known (no OCR): the translation is set over the original text and *Save all
pages as one PDF* binds the pages back at their original sizes. Text search
is lost; appearance is kept.

`.txt` is translated a paragraph at a time (wrapped lines joined), short
lines (verse, lists) one per line. `.md` keeps headings, bullets, quotes and
code fences. `.srt` and `.vtt` keep their timing and get their lines
translated with context.

## Settings worth knowing

- **Glossary**: one `term = translation` per line, applied everywhere.
- **Register**: natural, formal or casual.
- **Translation memory**: how many entries it holds, and a button to clear it.
- **Extra request parameters**: JSON merged into every chat request
  (`{"reasoning_effort":"low"}` by default); parameters a service rejects are
  dropped automatically.
- Keys are encrypted by the operating system where that is available.

## How it is put together

```
main.js            Electron main: windows, the app:// scheme, IPC
preload.js         the bridge the window talks through
src/llm.js         OpenAI-compatible client: chat (JSON), images, speech with timestamps
src/translate.js   batching, markers, context, the translation memory
src/ocr.js         Tesseract with line and word boxes, vertical CJK data, data download
src/languages.js   languages, OCR data, writing direction
src/image/         bubbles, text mask, inpainting, style, layout (shared with the window), the page pipeline
src/video/         ffmpeg, the lookahead scheduler, cues (SRT/VTT, shared), burned-in subtitles, file and live sessions
src/web/           the script run inside web pages
src/docs/          Office XML, text/markdown/subtitle files, PDF binding
renderer/          the window: pictures viewer, canvas lettering, video player and overlay, web tab, documents, settings
test/              unit tests, the mock API, a drawn comic page, the smoke test
```

Everything runs on your machine except the model calls. Pixel work is plain
JavaScript on typed arrays (no native modules); ffmpeg ships with the app.
