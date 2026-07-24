# LIMS Instrument Gateway

Standalone on-premise Node service that receives HL7 result messages from lab
analyzers over **MLLP/TCP** and forwards normalized results to the LIMS app over
HTTP. Built first for the **Erba H-360** hematology analyzer (HL7 v2.3.1,
results-only / unidirectional).

It runs on a PC inside the lab network; the analyzer is configured to transmit
to that PC's IP address and the gateway's TCP port. The gateway never talks to
browsers and never queries the analyzer — it only receives, ACKs, and forwards.

```
 analyzer ──(MLLP/TCP ORU^R01)──▶ gateway ──(HTTPS POST)──▶ app /api/instruments/results
 analyzer ◀──────(MLLP ACK)────── gateway
```

> **Standalone repo.** This gateway is maintained separately from the LIMS app so
> lab PCs only need this small service, not the application code. The one shared
> contract is the JSON payload it POSTs to `/api/instruments/results`, which the
> app validates against `lib/validations/instruments.ts`
> (`instrumentResultsPayloadSchema`). If that payload shape changes, update it in
> both repos.

> 📋 **Setting up a physical Erba H-360?** Follow the full, phase-by-phase guide in
> **[H360-SETUP.md](./H360-SETUP.md)** — cloud prerequisites, installing on the lab
> PC, connecting the analyzer, code mapping, and running as a service.

## Run

```bash
cd instrument-gateway
npm install
npm start                     # listens for HL7/MLLP on :5150, health on :4002
```

Test the whole pipeline without hardware using the built-in simulator (in a
second terminal, with the gateway running):

```bash
npm run simulate -- 250723001      # sends one CBC ORU^R01 for that barcode
```

You should see the simulator print `✓ Accepted (MSA|AA)` and the gateway log a
`Message received` line. Until the app's ingest route exists, the forward step
returns 404 and the message is spooled to `./spool/` (see below) — that is
expected at this stage.

## Configuration

Copy `.env.example` and adjust. Key variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `INSTRUMENT_TCP_PORT` | `5150` | Port the analyzer transmits to. Set the same in the H-360 LIS menu. |
| `INSTRUMENT_HTTP_PORT` | `4002` | Health-check HTTP port (`GET /health`). |
| `APP_INGEST_URL` | `http://localhost:3000/api/instruments/results` | LIMS app ingest endpoint. |
| `INSTRUMENT_GATEWAY_SECRET` | `dev-secret` | Bearer token; must match `INSTRUMENT_GATEWAY_SECRET` in the app. **Change in production.** |
| `INSTRUMENT_ID` | `erba-h360` | Label stored with forwarded results. |
| `HL7_BARCODE_LOCATION` | `OBR-3` | Where the sample barcode sits in the HL7 message. |
| `FORWARD_ATTEMPTS` | `3` | POST retries before spooling to disk. |

The gateway reads these from a `.env` file next to `index.js` (copy `.env.example`
→ `.env` and edit). Real environment variables, if set, take precedence over the
file — so the same build works whether launched from a terminal or the service.

## Deploying to a lab (run as a Windows service)

**Where it runs:** on a PC **inside the lab's local network** — the analyzer
connects to it over the LAN, so it cannot live in the cloud (Render/Vercel). It
can share the reception/billing PC that already runs the LIMS; it only makes
**outbound** HTTPS calls to the app. One gateway per physical site with
analyzers; the app resolves which lab a result belongs to from the sample
barcode, so the install is identical everywhere — only `.env` differs.

**One-time setup per lab PC:**

1. Install [Node.js 18+](https://nodejs.org).
2. Copy the `instrument-gateway/` folder to the PC and run `npm install`.
3. `copy .env.example .env` and edit it:
   - `APP_INGEST_URL` → the deployed app, e.g. `https://your-app.com/api/instruments/results`
   - `INSTRUMENT_GATEWAY_SECRET` → a strong secret, **matching** the app's env var
   - `INSTRUMENT_TCP_PORT` (e.g. `5150`) and `INSTRUMENT_ID`
4. Open a Command Prompt **as Administrator** in the folder and run:

   ```bat
   npm run service:install
   ```

That registers a Windows service named **LIMS Instrument Gateway** that starts
automatically on every boot, runs in the background, and restarts itself if it
crashes. **Nobody has to start it daily** — it's one-time. Verify or manage it in
`services.msc`.

Then, in the **analyzer's** LIS/host menu, set the host IP to this PC's LAN
address and the port to `INSTRUMENT_TCP_PORT`.

**Changing config later:** edit `.env`, then restart the service in `services.msc`
(no reinstall needed). **To remove it:** run `npm run service:uninstall` as
Administrator. On the **app** deployment, set `INSTRUMENT_GATEWAY_SECRET` to the
same value the gateways use.

## How a message is handled

1. **Receive** — MLLP framing (`lib/mllp.js`) reassembles complete HL7 messages
   from the TCP stream.
2. **Parse** — `lib/hl7.js` reads the `MSH`/`PID`/`OBR`/`OBX` segments. The
   sample **barcode** is pulled from `HL7_BARCODE_LOCATION` (default `OBR-3`),
   with `OBR-2`/`PID-3` fallbacks; each `OBX` becomes one result
   (`code`, `value`, `unit`, `flag`, `status`).
3. **ACK** — an HL7 `MSA|AA` acknowledgement is framed and written straight back
   so the analyzer doesn't stall. Unparseable messages get `MSA|AE`.
4. **Forward** — the normalized payload is POSTed to `APP_INGEST_URL` with the
   bearer secret. Transient failures retry; a final failure **spools** the raw
   HL7 + JSON to `./spool/` so nothing is ever lost.

The gateway is deliberately thin: barcode→patient matching and analyzer-code→
report-field mapping live in the app, which owns the data and the review step
(instrument results land as **unverified** for a tech to validate before
release).

## Connecting the real Erba H-360

Everything above is built against the published HL7 spec and the simulator, so
no hardware is needed to develop. When the analyzer is available:

1. In its **LIS / host communication** menu, set the host IP to this PC and the
   port to `INSTRUMENT_TCP_PORT`; confirm protocol is **HL7** (TCP/IP).
2. Run one sample. The gateway logs it and, if the app ingest route isn't ready,
   drops the raw message in `./spool/`.
3. **Diff** that raw message against what the simulator sends:
   - Confirm which field holds the barcode; if not `OBR-3`, set
     `HL7_BARCODE_LOCATION` accordingly.
   - Confirm the exact `OBX-3` analyte codes and unit strings; maintain the
     code→field mapping in the app.

No parser code change is expected — the machine-specific bits are configuration.

## Files

- `index.js` — TCP/MLLP server, ACK, forward-with-retry, disk spool, health endpoint.
- `lib/mllp.js` — MLLP framing/deframing.
- `lib/hl7.js` — minimal HL7 v2 parser + ACK builder.
- `simulator.js` — stands in for the H-360; sends a realistic CBC `ORU^R01`.
- `spool/` — undelivered messages (git-ignored), for replay/inspection.
