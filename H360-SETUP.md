# Erba H-360 — Setup & Testing Guide

End-to-end guide for connecting a physical **Erba H-360** hematology analyzer to
the LIMS through this gateway. Follow the phases in order — each one proves the
previous one, so if something breaks you know exactly where.

> **Do the first real run in foreground mode** (`npm start`, watching the logs).
> Only install the Windows service (Phase 5) once real results flow correctly.

---

## How it fits together

```
   LAB'S LOCAL NETWORK                              INTERNET
 ┌─────────────────────────────┐
 │  Erba H-360  ──HL7/MLLP/TCP─▶│  lab PC                ┌──────────────────────┐
 │  (LAN only)                 │  instrument-gateway ───┼─HTTPS (outbound)─────▶│  LIMS app (Vercel)   │
 │                             │  e.g. 192.168.1.10:5150│  /api/instruments/…  │  + Supabase          │
 └─────────────────────────────┘                        └──────────────────────┘
```

- The **gateway runs on a PC inside the lab**, on the same network as the analyzer.
  It cannot run in the cloud — the analyzer connects *to it* over the LAN.
- The **app stays on Vercel**. The gateway only makes outbound HTTPS calls to it.
- One gateway per physical lab site. The app resolves which lab a result belongs
  to from the **sample barcode**, so every install is identical — only `.env` differs.

---

## Phase 0 — Cloud prerequisites (once, before the lab)

1. **Apply the instrument migration to the production Supabase.** From the app
   repo: `npm run supabase:push` (or apply `143_add_instrument_interfacing.sql`
   from the Supabase dashboard). Without it, the production tables don't exist.
2. **Set Vercel environment variables** (Project → Settings → Environment Variables):
   - `INSTRUMENT_GATEWAY_SECRET` — a long random string (generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   - `SUPABASE_SERVICE_ROLE_KEY` — already present for the app.
   Redeploy so they take effect.
3. **Confirm the ingest route is live** — it should reject an unauthenticated call:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<your-app>.vercel.app/api/instruments/results
   ```
   Expect `401`. A `404` means that deploy doesn't have the route yet.

---

## Phase 1 — Install the gateway on the lab PC

Requirements: **Node.js 18+**, the PC on the analyzer's LAN, with internet access.

1. Copy/clone this `lims-instrument-gateway` folder to the PC, then:
   ```bash
   npm install
   ```
2. Create the config file: `copy .env.example .env`, and edit `.env`:
   ```
   APP_INGEST_URL=https://<your-app>.vercel.app/api/instruments/results
   INSTRUMENT_GATEWAY_SECRET=<same value you set in Vercel>
   INSTRUMENT_TCP_PORT=5150
   INSTRUMENT_ID=erba-h360
   HL7_BARCODE_LOCATION=OBR-3
   ```
   > Use `https://` for the Vercel app. Only use `http://` if you ever point it at
   > a local dev server (which runs plain HTTP).
3. **Find the PC's LAN IP:** run `ipconfig`, note the IPv4 address (e.g. `192.168.1.10`).
   The analyzer will transmit to this address.
4. **Allow the gateway's port through Windows Firewall** (the analyzer connects
   *inbound* to it). In an Administrator command prompt:
   ```bat
   netsh advfirewall firewall add rule name="LIMS Instrument Gateway" dir=in action=allow protocol=TCP localport=5150
   ```

---

## Phase 2 — Dry run WITHOUT the analyzer (prove the plumbing)

Do this before touching the H-360. It confirms gateway → Vercel → database → UI
works, so any later problem is the analyzer/config, not the pipeline.

1. In the app, create a bill/report for a **CBC panel** and note the **sample
   barcode** it prints (e.g. `2407263`).
2. Add at least one mapping so a result can match — app → **Reports → Instrument
   Mappings** → add e.g. `WBC` → the CBC panel's WBC field (see the Mappings
   section below).
3. Start the gateway in the foreground so you can watch it:
   ```bash
   npm start
   ```
4. From the same PC, send a simulated CBC message for that barcode:
   ```bash
   npm run simulate -- 2407263
   ```
5. Confirm the chain:
   - Simulator prints `✓ Accepted (MSA|AA)`.
   - Gateway logs `Message received … Results forwarded to app` (**not** "spooled").
   - App → **Reports → Instrument Results**: the report appears with the mapped
     result pending. Unmapped codes show as an amber "unmatched" banner — expected.
6. Select the result → **Accept** → confirm the value lands on the report.

If this works, the pipeline is solid. Now bring in the analyzer.

---

## Phase 3 — Connect the H-360

1. In the analyzer's **LIS / Host Communication** menu, set:
   - **Host IP** = the lab PC's LAN IP (from Phase 1.3)
   - **Port** = `5150` (your `INSTRUMENT_TCP_PORT`)
   - **Protocol** = HL7, **mode** = unidirectional / host upload, transmission **enabled**
2. **Critical — enter the barcode on the analyzer.** In unidirectional mode the
   analyzer only sends what it knows, so for each sample the technician must
   **enter or scan the LIMS barcode as the Sample ID on the H-360**. If the LIMS
   barcode isn't on the machine, the result can't be matched to a report.

---

## Phase 4 — First real sample + reconciliation

The real H-360's exact codes, units, and message layout may differ from the
simulator's. The first message often won't match perfectly — that's expected.
Reconcile it once:

1. **Run one real sample** (or a QC first, just to capture the format).
2. **Read what actually arrived.** Every message is stored raw. In the Supabase
   SQL editor:
   ```sql
   select received_at, status, barcode, message_type, raw
   from instrument_messages order by received_at desc limit 5;
   ```
3. **Fix the barcode field if needed.** If `status = 'unmatched'` and `barcode` is
   empty/wrong, look at the `raw` HL7 to see which field carries the sample ID.
   If it isn't `OBR-3`, set `HL7_BARCODE_LOCATION` in `.env` (e.g. `OBR-2` or
   `PID-3`) and restart the gateway.
4. **Map the real analyte codes.** Read the `OBX` lines in `raw` to see the exact
   codes the H-360 emits (e.g. `WBC`, `RBC`, `HGB`, `PLT`…, and how it names the
   differential and RDW). Add a mapping for each — see below.
5. **Re-run the sample.** The barcode now resolves and mapped codes appear as
   **pending** in Instrument Results → **Accept** → values land on the report.

---

## Understanding mappings (Instrument Mappings page)

A mapping links **one analyzer code → one report field**. A staged result becomes
**pending** (acceptable) only when **both** are true:

1. The mapping's **analyzer code exactly equals** the code the analyzer sent
   (`WBC` ≠ `WBC%`; `RDW` ≠ `RDW-CV`). Case and punctuation must match.
2. The mapping's **field belongs to a test that was billed** on this report. If
   you bill a **CBC panel**, map every analyte to that **panel's** fields — not to
   the standalone single-tests (a standalone "Hemoglobin" field won't match a CBC
   panel report).

Otherwise the result is staged as **unmatched** and only shows in the banner count.

### Scale factor

A multiplier applied to the incoming numeric value before it's written:

```
stored value = incoming value × scale factor        (default 1 = unchanged)
```

Use it when the analyzer's **unit differs from your field's unit** by a constant.
Example: the analyzer sends WBC as `7.2` in **10³/µL**, but your field is in
**/Cumm** where that's **7,200** → set scale factor **1000**. If the units already
match (e.g. HGB in g/dL both sides), leave it `1`.

> Get this right per field — a wrong factor silently writes a value off by 1000×.

### One mapping per analyte

A full CBC is roughly one mapping each for: `WBC, RBC, HGB, HCT/PCV, MCV, MCH,
MCHC, RDW, PLT` plus the differential (`NEU, LYM, MON, EOS, BAS`, as % and/or
absolute). Use the **exact codes and units the real H-360 emits** — the values in
the simulator are only placeholders.

---

## Phase 5 — Install as a Windows service (go live)

Once a real sample flows cleanly end to end, stop the foreground gateway and
install it permanently. In an **Administrator** command prompt:

```bat
npm run service:install
```

This registers a service named **LIMS Instrument Gateway** that starts
automatically on every boot, runs in the background, and restarts itself if it
crashes. **Nobody has to start it daily.** Manage it in `services.msc`.

- **Change config later:** edit `.env`, then restart the service in `services.msc`
  (no reinstall).
- **Remove it:** `npm run service:uninstall` (as Administrator).

---

## Configuration reference (`.env`)

| Variable | Example | Purpose |
| --- | --- | --- |
| `APP_INGEST_URL` | `https://your-app.vercel.app/api/instruments/results` | Where results are POSTed (the deployed app). |
| `INSTRUMENT_GATEWAY_SECRET` | `<64-hex>` | Bearer token; **must match** the app's env var. |
| `INSTRUMENT_TCP_PORT` | `5150` | Port the analyzer transmits to (set the same in the LIS menu). |
| `INSTRUMENT_ID` | `erba-h360` | Label stored with results; also the `instrument_id` in mappings. |
| `HL7_BARCODE_LOCATION` | `OBR-3` | HL7 field holding the sample barcode (fallbacks: `OBR-2`, `PID-3`). |
| `INSTRUMENT_HTTP_PORT` | `4002` | Health check: `GET http://localhost:4002/health`. |
| `FORWARD_ATTEMPTS` | `3` | POST retries before a message is spooled to `./spool/`. |

---

## Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| Analyzer can't connect / times out | Wrong IP/port on the analyzer; Windows Firewall blocking inbound `5150` (Phase 1.4); gateway not running. |
| Gateway logs nothing when a sample runs | Analyzer not transmitting or pointed at the wrong IP. Check the gateway is up: `GET http://<pc>:4002/health`. |
| Gateway logs `Message spooled to disk` | Couldn't reach the app. Check `APP_INGEST_URL` (use `https://` for Vercel), internet, and that `INSTRUMENT_GATEWAY_SECRET` **matches** the app. |
| App returns `500 "Ingest not configured"` | `INSTRUMENT_GATEWAY_SECRET` isn't set on the app deployment. Set it and redeploy/restart. |
| App returns `401` | The gateway's secret doesn't match the app's. Make them identical. |
| Message arrives, `status = unmatched`, no barcode | Barcode not entered on the analyzer (Phase 3.2), or wrong `HL7_BARCODE_LOCATION` (Phase 4.3). |
| Matched, but results show as "unmatched" / only the banner | Analyzer codes not mapped, mapped code doesn't match exactly, or the mapping points at a test that wasn't billed (map to the CBC **panel** for CBC bills). |
| Value written but off by ~1000× | Wrong `scale factor` on that mapping (unit mismatch). |

---

## The mental model

**Phase 2 proves the plumbing. Phase 4 is a one-time reconciliation** of the
barcode field + analyte codes/units to your specific machine. After that it just
runs — the technician scans the barcode into the analyzer, runs the sample, and
reviews/accepts the results in the app.
