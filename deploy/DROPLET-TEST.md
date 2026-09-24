# Droplet connectivity test — can a lab's H-360 reach the cloud directly?

Goal: prove an Erba H-360 inside a lab can send results over the internet to
one central gateway on the DigitalOcean droplet, so no lab needs a gateway PC.

This test **does not send anything to the LIMS**. Forwarding is disabled
(`deploy/instrument-gateway.env.example`); every message the analyzer sends is
ACKed and saved on the droplet in `spool/`. That is all we need to see.

It runs on the same droplet as the WhatsApp gateway, as a separate user,
service and port. The two do not touch each other.

---

## 1. Find the droplet's IP

DigitalOcean → Droplets → your WhatsApp gateway droplet → **ipv4**. The
analyzer's LIS screen only accepts a numeric IP, so this is what the lab enters.

The droplet's IPv4 stays the same for as long as the droplet exists. A Reserved
IP is only needed if you might ever rebuild/replace the droplet — optional for
the test.

## 2. Find the lab's public IP

On any PC **in the lab** (same internet connection the analyzer will use), open
<https://ifconfig.me>. Note the address. We only let that address in, so the
open port is not reachable from the rest of the internet.

> If the lab's internet has no fixed public IP it may change later — fine for a
> one-day test.

## 3. Install the gateway on the droplet (as root)

```bash
ssh root@<DROPLET_IP>

useradd --system --create-home --home-dir /opt/lims-instrument-gateway \
        --shell /usr/sbin/nologin instgateway

git clone --depth 1 https://github.com/AdityaKalmekh/lims-instrument-gateway.git /tmp/instgw
cp -r /tmp/instgw/. /opt/lims-instrument-gateway/
rm -rf /tmp/instgw

cd /opt/lims-instrument-gateway
npm ci --omit=dev
mkdir -p spool
chown -R instgateway:instgateway /opt/lims-instrument-gateway
```

> The repo is private? `git clone` will ask for credentials — use a GitHub
> personal access token (read-only, this repo only) as the password.

## 4. Config + service

```bash
cp /opt/lims-instrument-gateway/deploy/instrument-gateway.env.example /etc/lims-instrument-gateway.env
chown root:root /etc/lims-instrument-gateway.env
chmod 600 /etc/lims-instrument-gateway.env

cp /opt/lims-instrument-gateway/deploy/lims-instrument-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lims-instrument-gateway
systemctl status lims-instrument-gateway --no-pager
curl -s localhost:4002/health      # expect an OK response
```

## 5. Open port 5150 — for the lab only

```bash
ufw allow from <LAB_PUBLIC_IP> to any port 5150 proto tcp comment 'H-360 test'
ufw status
```

If the droplet also has a **DigitalOcean Cloud Firewall** (Networking →
Firewalls), add the same inbound rule there — it sits in front of ufw.

Check from **your own PC** that the port is closed to everyone else (expect a
timeout, since your IP is not the lab's):

```powershell
Test-NetConnection <DROPLET_IP> -Port 5150
```

## 6. Configure the analyzer (at the lab)

**Network screen** (Setup → Host Communication):
- Plug the H-360 into the lab's **router/switch** (not straight into a PC).
- Choose **Obtain an IP address automatically** (and DNS automatically).
  The analyzer only makes outgoing connections, so its own address may change.

**LIS Communication screen:**
- IP Address: `<DROPLET_IP>`
- Port: `5150`
- Auto-communication: ✅
- Communication Acknowledgement: ✅ (ACK timeout 15)
- Press **Apply**, then **OK**.

Write down the old values first (`100.168.0.199` / gateway `100.168.0.217`,
LIS `100.168.0.217:5150`) so the lab can go back to the local PC afterwards.

## 7. Run the test

On the droplet, watch live:

```bash
journalctl -u lims-instrument-gateway -f
```

At the lab, run **one QC or test sample**.

| You see in the log | Meaning |
|---|---|
| `Analyzer connected` → `Message received` → `Message spooled to disk` | ✅ **It works.** The analyzer reached the droplet and was ACKed. (`spooled` is expected — forwarding is off.) |
| `Analyzer connected` but no `Message received` | The connection works but the message didn't parse — send `raw-capture.log` to Claude. |
| Nothing at all | The analyzer can't reach the droplet. Go to troubleshooting. |

See exactly what arrived:

```bash
ls -l /opt/lims-instrument-gateway/spool/
tail -c 3000 /opt/lims-instrument-gateway/spool/raw-capture.log
```

On the analyzer, the result should show as **transmitted** (no LIS error),
because Communication Acknowledgement is now on and the gateway ACKs.

## 8. Test an internet outage

1. Unplug the lab router's **internet** cable (keep the analyzer ↔ router link).
2. Run another sample. Note what the analyzer shows (error? "not sent"?).
3. Plug the internet back in. Wait 2–3 minutes.
4. Does the droplet log a new `Message received` on its own (analyzer retried),
   or only after re-sending from the analyzer's result list?

This tells us whether an outage loses results or just delays them.

## 9. Undo after the test

At the lab: set the analyzer back to the old values from step 6.

On the droplet (keeps the install, just closes it):

```bash
systemctl disable --now lims-instrument-gateway
ufw delete allow from <LAB_PUBLIC_IP> to any port 5150 proto tcp
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing in the droplet log | Analyzer really on the router (not a direct cable)? Network set to automatic? Router gives it an address? |
| Still nothing | Lab public IP changed? Re-check <https://ifconfig.me> and the `ufw` rule. Cloud Firewall rule added? |
| Still nothing | Some ISPs/offices block unusual outgoing ports. Port 443 is taken by Caddy, so try `8443`: change `INSTRUMENT_TCP_PORT`, the ufw rule and the analyzer, then `systemctl restart lims-instrument-gateway`. |
| Analyzer shows an LIS/ACK error but the droplet logged `Message received` | Try turning Communication Acknowledgement off, re-run; tell Claude what the analyzer showed. |
| `systemctl status` shows restarting | `journalctl -u lims-instrument-gateway -n 100` — the error is above the restart. |
