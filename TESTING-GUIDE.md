# Testing guide

A step-by-step plan for testing the claim processor. Parts 1 to 3 take about 15 minutes. Part 4 needs a working Jev API key, and Part 5 also needs a Claude or OpenAI key.

## Before you start

```bash
npm run install-all   # once
npm run dev           # keep this running
```

Open http://localhost:3000. If the Overview page isn't empty, click **Clear data** in the top bar.

## Part 1: Automated tests (1 minute)

In a second terminal, from the project root:

```bash
npm test
```

**Expected:** `tests 57`, `pass 57`, `fail 0`. You don't need the app running or a Jev key for this.

## Part 2: Test datasets (3 minutes)

Each dataset claim records the outcome it should get, so the app can check the results for you.

1. Go to **New claim** → **Load test dataset**. You should see three cards: Quick Test (3), Comprehensive Test (32) and Fraud and Billing Checks (11).
2. Click **Load 3 claims** on Quick Test. A progress bar runs, then the app returns to Overview with a green banner: **3 of 3 got the expected outcome**.
3. Load the other two datasets the same way. Expect **32 of 32** and **11 of 11**.
4. On **Overview**, check the **Decision engine** panel:
   - **Test claims with the expected outcome** is **46 of 46**.
   - **Sent to review by a policy rule** is **1**. This is claim FRD-POL-001, a $55,000 hip replacement.

You can also run the datasets from a terminal while the app is running. Each run exits with code 0 when every claim matches:

```bash
node load-samples.js quick_test
node load-samples.js comprehensive
node load-samples.js fraud_checks
```

## Part 3: Manual checks in the app (10 minutes)

### Submitting claims

On **New claim** → **Single claim**:

| # | Enter | Expected result |
| --- | --- | --- |
| 1 | Click **Submit claim** with the form empty | Nothing is submitted; the browser highlights the required fields |
| 2 | Amount `250`, diagnosis `Annual Checkup`, procedure `Office Visit` | Green banner "processed: Approved"; the app opens **Claims** with your claim at the top |
| 3 | Amount `5000`, diagnosis `Cosmetic procedure` | **Denied** |
| 4 | Amount `8500`, diagnosis `Lab Test` | **Needs review**, **Critical** alert (price is more than twice the typical maximum for lab work) |
| 5 | Amount `3500`, diagnosis `Emergency Room Visit`, provider **Out-of-network** | **Needs review**, **High** alert |
| 6 | Amount `55000`, diagnosis `Hip replacement surgery`, procedure `Surgery` | **Needs review**. The details show "Policy rule: Claims of $50,000 or more always need an adjuster's sign-off" |
| 7 | Amount `150`, diagnosis `Office Visit`, claims this month `6` | **Approved** (6 claims alone is not a red flag) |
| 8 | Amount `150`, diagnosis `Office Visit`, claims this month `10`, frequency **Suspicious** | **Needs review**, **Critical** alert |
| 9 | Diagnosis `Complex multi-organ surgery`, amount `20000` | **Approved**, care type **Surgical**, not Emergency |

### Claims page

1. Type `FRD-POL` in the search box. One row remains.
2. Click the row. The details show the claim, the assessment, the decision, **Test expected: Needs review, matches**, the policy rule, the engine, and the reasons.
3. Search for `no-such-claim`. You should see "No matching claims".
4. Clear the search and click **Denied**. Only denied claims are listed.
5. Click **Approved**, then press the browser's **Back** button. You return to the previous page.

### Engine status

The chip in the top bar should say **Jev unavailable · using fallback rules** while the key is rejected, and the Overview page shows an amber banner explaining why. In a claim's details, **Why not Jev** shows the reason, for example "Jev rejected the API key (HTTP 401)".

To check the other states, change `backend/.env` and save it. The backend reloads it within a second; submit a claim to see the new state:

| `.env` change | Chip | Overview banner |
| --- | --- | --- |
| `USE_MOCK_JEV=true` | Jev off · using fallback rules | none |
| `JEV_API_KEY=` (empty) | Jev not configured · using fallback rules | "No Jev API key is set…" |
| A rejected key | **Jev ready**, then **Jev unavailable** after the first claim | "Jev rejected the API key…" |
| A working key | **Jev ready**, then **Jev connected** after the first claim | none |

### Other checks

- **Clear data** asks for confirmation, then empties every page.
- Narrow the browser window to phone width. The side bar becomes a strip across the top and nothing scrolls sideways.
- Stop the backend while the app is open. A red banner says the API server can't be reached. Start it again and the banner goes away within 2 seconds.

## Part 4: With a working Jev key

1. Get a key, and set `JEV_API_URL` and `JEV_API_PATH` in `backend/.env` to match where it came from (see "Which Jev endpoint to use" in the README). A `jv_live_` key from jevtypesafeai.com uses `https://jevtypesafeai.com/api/v1` and `/decide`.
2. In `backend/.env`, set `JEV_API_KEY=` to your key. Keep everything on one line with no spaces or quotes.
3. Save the file. The backend reloads it automatically; the terminal prints "backend/.env changed; settings reloaded".
4. Submit one claim. The chip changes to **Jev connected**, and the claim's details show **Decided by: Jev API**, the model version, the input tokens, and a probability bar for each outcome.
5. Clear the data and load all three datasets again. Jev is a model, not fixed rules, so it may not match every expected outcome. In our run it matched 43 of 46. Use the **Unexpected** filter on the Claims page to review the claims it decided differently.

To test the key and endpoint in `backend/.env` without the app, run this in Git Bash from the project root. `HTTP 200` means they work. `HTTP 401` means the key was rejected, often because it belongs to the other endpoint.

```bash
setting() { grep "^$1=" backend/.env | cut -d= -f2- | tr -d '\r\n '; }
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$(setting JEV_API_URL)$(setting JEV_API_PATH)" \
  -H "Authorization: Bearer $(setting JEV_API_KEY)" -H "Content-Type: application/json" \
  -d '{"model":"jev-latest","state":"test","questions":{"q":{"type":"choice","instructions":"Is this a test?","criteria":{"yes":"yes","no":"no"}}}}'
```

## Part 5: Jev vs LLM comparison

This part makes paid calls: with Claude Opus 5, the Quick Test costs about 3 cents and all 46 claims about $0.45.

1. Add your LLM key to `backend/.env` and save: `ANTHROPIC_API_KEY` for Claude, or set `LLM_PROVIDER=openai` and add `OPENAI_API_KEY`.
2. Open **Jev vs LLM**. Under **Connections**, both cards should say **Connected** or **Ready**. If a card shows another status, follow its **What to do** steps, save `backend/.env`, and click **Check again**.
3. Check the connection states. Change `backend/.env`, save, click **Check again**, and put it back afterwards:

   | Change | Expected LLM status |
   | --- | --- |
   | Remove the LLM key | **Not configured**, with where to get a key |
   | Change one character of the key | **Key rejected** |
   | Set `ANTHROPIC_MODEL=claude-opus-9` | **Model not available**, with models the key can use |
   | A Claude key that isn't tied to a workspace, with `ANTHROPIC_WORKSPACE_ID` empty | **Workspace ID needed** |

   While the LLM isn't connected, the **Run** buttons are disabled and a message says why.
4. Click **Run 3 claims** on Quick Test. The results show averages per claim for both engines, the cost per 1 million claims, agreement, and a claim-by-claim table. Every column header lines up with its numbers.
5. Run the same dataset again. The averages still count each claim once ("latest result for each").
6. From a terminal, `node compare-llm.js quick_test` prints the same comparison and exits with code 0.

## Reporting a problem

Note the claim ID, what you entered, what you expected and what you got. The claim's expanded details and the backend terminal output (lines starting with `[jev]`) usually show the cause.
