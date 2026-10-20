# Video plan: Round 1 (≤ 3:00)

Everything needed to record, edit and submit the ColdChain Round 1 video:
- the timed script, the shot list and the screen layout;
- the checklists;
- the backup plan;
- the rehearsal log.

**Hard limits:**
- total length ≤ **3:00** (target **2:50**);
- the system runs **live** (no mock-ups);
- every accelerated or simulated element is disclosed on screen or in the narration;
- submit by **5 November 2026**, recording finished by **1 November**.

Replace `[TEAM NAME]` before recording.

---

## 1. Demo settings for every take

Each scene is its own take from a fresh `make demo`, so each take uses only the settings it needs:

| Take | `DEMO_TIME_SCALE` (`.env`) | Start command | Why |
|---|---|---|---|
| Task 2 (heat budget) | `20` | `make demo` | A batch at 25 % reaches At Risk in about 5 s and Discard in about 23 s at 13 °C, slow enough to watch the bar fall. The purple DEMO banner shows "×20". |
| Task 5 (AI) | `1` | `make demo ARGS="--weak fridge-02=0.4"` (or `npm run demo -- --weak fridge-02=0.4`) | Fridge 2 gets a simulated weak compressor, in both the seeded history and the live node. Measured on 2026-10-18: health ≈ 36 ("Weakening"), fridge 2 drifts to ≈ 9 °C (BREACH), the forecast risk is HIGH, and a relocation plan to fridge 1 appears **1–2 min after start**, once fridge 1's own forecast settles to LOW. Keep the scale at 1: at ×20 the warm fridge burns its batches' budgets within minutes (BCG fell from 55 % to 5 % in about 3 min), and the planner never moves Discard batches. |
| All other scenes | `1` | `make demo` | Nothing needs acceleration. No DEMO banner to explain. |

Notes:
- **Efficiency 0.4 is the tested value.** At 0.5 the health score stays around 43, above the planner's trigger of 40, and no plan appears.
- **Wokwi nodes:** both running, with `MQTT_URL` set to the cloud broker. `make demo` sees them online and starts no virtual nodes. For the Task 5 take, type `set eff 0.4` in fridge 2's Wokwi serial console, so the live node matches the seeded history.
- **Pre-flight:** `make preflight` (add `ARGS="--expect-scale 20"` for the Task 2 take) must show no FAIL before each take (§4). A clock-skew WARN of a few seconds is harmless.

State after a fresh `make demo`. The checks below are what `make preflight` expects.

| Fridge | Batches | LED |
|---|---|---|
| Fridge 1 (`fridge-01`) | COVID-19 mRNA 100 %, Measles-Rubella 72 %, Rotavirus 25 % (Safe), Hepatitis B 12 % (**At Risk**) | green |
| Fridge 2 (`fridge-02`) | Polio 100 %, Pentavalent 91 %, BCG 55 %, Rabies 0 % (**Discard**) | **red** (latched by the Discard) |

**Reset with `make demo` before each scene.** The heat-budget scene discards every batch in fridge 1 and latches it. Record each scene from a fresh demo, as P21 advises; do not chain the scenes in one take.

---

## 2. Timed script

About 140 words a minute. The narration totals **≈ 360 words** in the order below. Captions are the burned-in subtitles; many judges watch muted.

### 0:00–0:15 — Hook and problem (≈ 34 words)

**Narration:** "Vaccines spoil outside two to eight degrees. ColdChain monitors every fridge, protects every batch, predicts trouble, and proves what happened. We are [TEAM NAME]. Five parts: fridge nodes, broker, backend, web app and AI."

**On screen:** title card (1 s) → live dashboard → the architecture strip from the README (3 s).

**Caption:** `ColdChain — monitor · protect · predict · prove`

### 0:15–0:45 — Task 1: fridge nodes (≈ 60 words)

**Narration:** "Two ESP32 fridge nodes, simulated in Wokwi. The OLED shows the temperature and Safe, Warning or Breach. The compressor switches on at seven degrees and off at three, then stays off for at least sixty seconds. Each node publishes over MQTT every five seconds, and instantly on a door change: I open the door, and the dashboard updates now."

**Captions:**
- `Compressor ON ≥ 7.0 °C · OFF ≤ 3.0 °C · 60 s minimum off`
- `MQTT every 5 s + on every door change`

### 0:45–1:10 — Task 2: heat budget (≈ 52 words)

**Narration:** "Every batch has a sixty-minute heat budget above eight degrees; above twelve it burns twice as fast. Demo mode speeds exposure up twenty times, as the banner shows. Below twenty percent a batch turns At Risk. At zero it is Discard, and the red LED stays on until an admin resets it."

**Captions:**
- `60 min budget above 8 °C · ×2 above 12 °C`
- `DEMO MODE: exposure ×20 (disclosed)`
- `Discard → red LED latched until Admin reset`

### 1:10–1:40 — Task 3: power and offline (≈ 58 words)

**Narration:** "Power failure: the node switches to battery, the compressor stops, and the dashboard shows it. Wi-Fi outage: readings go into a buffer that holds over thirty minutes. When the link returns they sync in order, with no duplicates. A door open longer than sixty seconds sounds the buzzer and sends a Telegram alert."

**Captions:**
- `Battery mode: compressor off, battery % reported`
- `Offline buffer → ordered sync, no duplicates`
- `jump cut: door held open 60 s`

### 1:40–2:10 — Task 4: web app and security (≈ 66 words)

**Narration:** "Roles are enforced on the server: an Inspector cannot move a batch. Anyone can scan a batch's QR code without logging in, and see Safe, At Risk or Discard with its expiry. Every device message is signed with HMAC-SHA256, a timestamp and a nonce. A replayed message is rejected and logged. I edit an audit record; Verify Integrity turns red at that record."

**Captions:**
- `Inspector → 403 (server-side RBAC)`
- `Public QR check: no login`
- `HMAC-SHA256 + timestamp + nonce: replay REJECTED`
- `Hash chain: Verify Integrity → broken at record #5`

### 2:10–2:45 — Task 5: AI (≈ 72 words)

**Narration:** "The AI forecasts each fridge thirty minutes ahead, with a range, and warns when it may pass eight degrees. Fridge two has a weakening compressor, simulated for the demo: its health score is thirty-six out of a hundred, and it can no longer hold the temperature. So the system proposes which batches to move, and where. The pharmacist confirms with one click, and the inventory updates. Our report documents the dataset, features and results. Training data is simulated."

Read the health number off the screen; it is about 36 with efficiency 0.4.

**Captions:**
- `30-min forecast with 80 % range`
- `Compressor health 0–100 (weak compressor simulated)`
- `One click: Confirm relocation`
- `Forecast MAE 0.66 °C vs 1.25 °C persistence baseline · trained on synthetic data`

### 2:45–2:58 — Close (≈ 18 words)

**Narration:** "Monitor, protect, predict, prove. Everything you saw ran live. That is ColdChain. Thank you."

**On screen:** dashboard overview, then the README / repo link for 3 s.

**Caption:** `github.com/odittodhrubo/ColdChain`

---

## 3. Shot list

Each row: what is on screen, what you do, what must happen, and what to do if it does not.

| # | Time | Window | Action | Expected result | Fallback |
|---|---|---|---|---|---|
| 1 | 0:00 | Title card, then browser (Pharmacist) | — | Dashboard: both fridges, live readings | Pre-recorded title clip |
| 2 | 0:15 | Wokwi fridge-01 (left half) | Point at the OLED | Temperature + `SAFE` readable | Zoom the Wokwi canvas |
| 3 | 0:22 | Wokwi fridge-01 serial | Type `set temp 7.2` | Relay LED on (`COMP_ON`); dashboard compressor ON | Virtual node: `t 7.2` |
| 4 | 0:30 | Wokwi fridge-01 serial | Type `set temp 2.9` | Relay LED off; dashboard: "Off · off-timer N s until restart allowed" | Virtual node: `t 2.9` |
| 5 | 0:38 | Wokwi + browser side by side | Slide **DOOR** right | Dashboard door OPEN within ~1 s | Virtual node: `d` |
| 6 | 0:45 | Wokwi fridge-01 | Slide **MODE** right (manual); click the DS18B20 probe, set **13 °C** | Status BREACH; Rotavirus bar falls, **At Risk** at ~5 s, **Discard** at ~23 s; red LED ON | Virtual node: `t 13` |
| 7 | 1:02 | Browser (Admin tab) | Fridge 1 → **Reset latch**, reason "batches disposed" | Red LED off; Discard batches stay Discard | Show the Reset button and its Admin-only tooltip |
| 8 | 1:10 | Wokwi fridge-02 | Press **POWER FAIL** | OLED + dashboard: BATTERY, compressor OFF, battery % | Virtual node: `p` |
| 9 | 1:18 | Wokwi fridge-02 | Press **WI-FI OUTAGE**, wait 10 s, press again | OLED `OFFLINE buf:N`; then the readings arrive in order | Virtual node: `w`, `w` |
| 10 | 1:28 | Wokwi fridge-01 + Telegram window | Slide **DOOR** right, hold 60 s (**jump cut**) | Buzzer; Telegram message "Door open" | In-app alert toast (say "in-app fallback") |
| 11 | 1:40 | Terminal (large font) | `python -m coldchain_tools.preflight --prove-rbac` | Prints `INSPECTOR ... -> 403` | Browser: Inspector tab has no Move button |
| 12 | 1:47 | Phone (or phone-sized window) | Scan a batch QR (from `make demo` output) | Public page: status + expiry, no login | Open the printed QR URL directly |
| 13 | 1:55 | Terminal | `python -m coldchain_tools.attack replay --own` | Security page: `REPLAY` row appears | `attack badsig` |
| 14 | 2:02 | Terminal, then browser (Audit Log) | `python -m coldchain_tools.tamper --audit-id 5 --field payload`, then **Verify Integrity** | Red, "first broken record #5" | Show `--restore`, then green |
| 15 | 2:10 | Browser: Fridge 2 detail (Task 5 take, started 2 min earlier) | — | Forecast band, HIGH risk badge, health gauge ≈ 36 | AI Report page |
| 16 | 2:25 | Browser: Relocations / Fridge 2 panel | Pharmacist clicks **Confirm** | Plan CONFIRMED; Inventory shows batches in Fridge 1 | If "plan changed", confirm the refreshed plan (one click) |
| 17 | 2:38 | Browser: AI Report | Scroll to results | Dataset, features, MAE table, "synthetic data" badge | `ml/reports/REPORT.md` on GitHub |
| 18 | 2:45 | Dashboard, then the README | — | Overview | — |

After shot 14, run `python -m coldchain_tools.tamper --restore`, so the next take starts with a valid chain. `make demo` also resets it.

---

## 4. Pre-recording checklist (every take)

1. Set `DEMO_TIME_SCALE` for this take (§1), then `make demo` (Task 5 take: `make demo ARGS="--weak fridge-02=0.4"`) from a stopped system. Wait for "ColdChain demo is running".
2. `make preflight`: no FAIL line (clock, broker, backend, ML, nodes online, fridge-02 latched, expected batch states).
3. Both Wokwi simulations running. In fridge 2's serial console: `set eff 0.4`. Both OLEDs readable.
4. The Telegram chat is visible on the phone or a desktop window. `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are set in `.env`.
5. Browser tabs are pre-logged-in: **Pharmacist** (dashboard), **Admin** (fridge 1 detail, for the reset), **Inspector** (inventory). Log in fresh *after* `make demo`: a tab left from an earlier run shows stale state, and a session expires after `JWT_EXPIRES_IN` (default **1 h**), so sign in less than an hour before the take.
6. A terminal with a large font (≥ 20 pt), in `tools/` with the venv active, and the three commands staged: `preflight --prove-rbac`, `attack replay --own`, `tamper --audit-id 5 --field payload`.
7. Task 2 take only: the DEMO banner shows `×20`.
8. Clock check: `make preflight` reports a skew under 2 s. A skew over 30 s causes `STALE_TS`.
9. Screen: 1920×1080, 30 fps, browser zoom 110–125 %, bookmarks bar hidden, notifications off, cursor highlight on, one consistent theme.

---

## 5. Screen layout

- **Left half:** Wokwi, fridge-01 on top and fridge-02 below (or one at a time, zoomed so the OLED is readable).
- **Right half:** browser, Pharmacist dashboard.
- **Second browser window:** Admin and Inspector tabs, the Security page and the Audit Log.
- **Phone, or a window sized 390×844:** the public QR page and Telegram.
- **Terminal:** bottom right, large font, shown only for the attack, tamper and RBAC shots.

---

## 6. Recording tips

- Record **one segment per scene** (§2), each from a fresh `make demo`. Edit them together afterwards.
- Use OBS (Display Capture, 1920×1080, 30 fps, CQP 18–20) or the Windows recorder (Win+Alt+R).
- Record the narration separately after the screen takes if live narration stumbles. Read it at the script's pace.
- **Captions:** burn them in (many judges watch muted). The captions in §2 are the minimum.
- Export MP4 H.264, AAC 48 kHz, ≤ 3:00. Check the audio levels (peaks around −6 dB). Play the file on another device and on a phone, muted.
- Jump cuts are fine for waiting time (door held 60 s). Show the `jump cut` caption.

---

## 7. Backup plan

| If | Then |
|---|---|
| Wokwi lags or drops MQTT | Stop that simulation and run `make demo` without it: virtual nodes start automatically. For keyboard control, run `npm run demo -- --no-nodes --weak fridge-02=0.4`, then `python -m coldchain_tools.virtual_node --fridge fridge-01 --interactive` (and `e 0.4` for fridge-02). Say "virtual node" in the narration. |
| Telegram does not arrive | Show the in-app alert, and say "in-app fallback; Telegram is configured in production". |
| The relocation plan is missing | Wait 2 min: fridge 1 (the destination) must be SAFE with a LOW forecast first. Check that `--weak fridge-02=0.4` was used and `DEMO_TIME_SCALE=1`. Otherwise re-run `make demo`. |
| `STALE_TS` on the Security page | Resync the clock (Windows: Settings → Time → Sync now), restart the Wokwi node. |
| Any scene fails twice | Use that scene's 30-second pre-recorded fallback clip (record one per scene during rehearsal). |

---

## 8. Submission checklist

- [ ] Length ≤ 3:00, checked in the file properties, not in the editor timeline.
- [ ] File named `TeamName_ColdChain_Round1.mp4` (with the real team name).
- [ ] Plays on another machine and on a phone; captions readable at 720p.
- [ ] Disclosures present: `DEMO_TIME_SCALE ×20`, seeded history, Wokwi simulation, simulated weak compressor, synthetic training data.
- [ ] Uploaded per the organisers' instructions at least **24 h before 5 November 2026**.
- [ ] Submission confirmation saved (screenshot + email).
- [ ] Repo link and README ready if requested.

---

## 9. Rehearsal log

Fill in one row per rehearsal (P21 asks for three timed runs). Fix every hiccup before the next run.

| # | Date | Total time | Slowest segment | Hiccups | Fixed by |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
