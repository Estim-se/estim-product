# estim Samtal: role-plays, fasit and the local test

| File | What |
|---|---|
| [rollspel.json](rollspel.json) | 15 role-play calls in Swedish with their fasit, the test employees and the customer register. All names are invented, and all numbers are in PTS's fictional series 070-174 06 05–99. |
| [manus.md](manus.md) | The scripts to read aloud, generated from `rollspel.json` with `bun scripts/samtal-manus.ts`. |
| [../../../scripts/samtal-local.ts](../../../scripts/samtal-local.ts) | Runs the whole chain on your recordings and compares each call with its fasit. |
| [../../../scripts/samtal-whisper.py](../../../scripts/samtal-whisper.py) | Local speech to text with KB-Whisper (faster-whisper). |

## What the 15 calls cover

| Calls | Content |
|---|---|
| 01, 09 | Outlets |
| 02, 07 | Charger (07: a housing association with a fixed visit time) |
| 03, 12 | Consumer unit (03: unclear address) |
| 04, 08, 10 | Fault finding (04: urgent, withheld number, number said aloud; 10: no address yet) |
| 05, 11 | Bathroom |
| 06 | Outdoor lighting, vague time and no street |
| 02, 05, 07 | Existing customers. 02 and 07 are found by phone; 05 calls from a new number and is found by name and address. |
| 09 | Same name as an existing customer at another address: a new customer, with the existing one listed as possible |
| 13, 14, 15 | Private calls, to be filtered out and deleted |

## The fasit, per call

**Classification:**
- jobb / privat.
- Private calls are checked for classification only.

**Fields:**
- Name, address and place match when the same whole words appear in both, ignoring case and punctuation: «Björkvägen 30» is not «Björkvägen 3».
- `null` means the call does not say it, so the field must stay empty (never guessed). `?` means the field is not checked.
- The phone number is checked when it is said aloud.
- Job type: one or several acceptable kinds.
- Urgency.

**Customer:** existing (id, and whether it was found by phone or by name and address), or new.

**Tasks:**
- The tasks that must be suggested.
- The visit time where one is agreed.

**Quote basis:** whether there is enough for a quote, and what must be listed as uncertain.

The tests check that every fasit value is said in its script, and that a perfect answer passes every check.

## Recording

1. Read [manus.md](manus.md) aloud, preferably with two people, on a phone or a computer.
2. Save each call as `rollspel-01.m4a` (or `.mp3` / `.wav`) in a folder **outside the repository**, for example `C:\Users\<you>\estim-samtal-lokal\inspelningar`.
3. Never put recordings in the repository.

## Running locally

**Once,** create the Python environment for KB-Whisper (outside the repository):

```
cd %USERPROFILE%\estim-samtal-lokal
python -m venv venv
venv\Scripts\python -m pip install faster-whisper==1.1.1 requests av==13.1.0
```

`av==13.1.0` is needed because newer PyAV releases do not work with faster-whisper 1.1.1. The first run downloads the model into `estim-samtal-lokal\modeller`: medium is about 1.5 GB, small about 0.5 GB.

**Each time** (from the repository; `ANTHROPIC_API_KEY` in `.env.local`):

```
bun scripts/samtal-local.ts --recordings %USERPROFILE%\estim-samtal-lokal\inspelningar --write-metadata --out %USERPROFILE%\estim-samtal-lokal\rapport.json
```

| Option | What it does |
|---|---|
| `--write-metadata` | Writes `rollspel-NN.json` next to each recording from the fasit: receiving number, caller, time. Needed once. |
| `--model small` | A faster, slightly less accurate speech-to-text model. The default is `medium`. |
| `--only rollspel-04,rollspel-13` | Runs only those calls. |
| `--stt berget` | Uses Berget instead of the local model, once `BERGET_API_KEY` is set. |
| `SAMTAL_AI_MODEL=…` | Tests another AI model. The default is the app's `ANTHROPIC_MODEL_MAIN`, else `claude-sonnet-5`. |

**The report shows, per call:**
- the classification and the word error rate against the script;
- every check that failed, with fasit and result;
- the request title and the tasks.

**At the end:**
- the number of calls entirely right;
- the AI cost per call;
- the total time.

**Word error rate:** numbers said as words but written as digits count as errors, so the rate is an upper bound.

## Model size on this PC

Measured on an Intel Core Ultra 5 125U, 15 GB, no Nvidia GPU, int8 on the CPU, with a 130-second clip:

| Model | Time | Speed | First load | WER (FLEURS, KBLab) |
|---|---|---|---|---|
| kb-whisper-small | 28 s | 4.6× real time | 2 s | 7.3 % |
| kb-whisper-medium (default) | 72 s | 1.8× real time | 111 s, including download | 6.6 % |

**Chosen: medium.**
- It is closest to the large model Berget runs in production, and it fits this PC: 15 one-minute calls take about 8 minutes.
- small takes about 3 minutes and suits quick rounds.

## Not covered locally

- **Speaker labels:** faster-whisper gives none. The interpretation does not need them; Berget gives them.
- **The database steps:** registration, `estim_receive`, tasks in `samtal_tasks` and RLS. They are covered by the tests (PGlite and fakes); this script runs the same code without a database.

## Smoke test

The chain was run end to end on two synthetic clips: Windows' English voice reading Swedish scripts, since the PC has no Swedish voice.

| Measure | Result |
|---|---|
| Word error rate | 80–90 % |
| Time | 25 s with small |
| AI cost | 0.020 USD for two calls, about 0.01 USD per call with claude-sonnet-5 |

The AI correctly answered *osäker* and left every field empty instead of guessing. Real recordings are needed for a real result.
