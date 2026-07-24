/**
 * Install the instrument gateway as an auto-starting Windows service.
 *
 * Run ONCE per lab PC, from an **Administrator** command prompt, after
 * configuring instrument-gateway/.env (copy .env.example → .env and edit):
 *
 *   npm run service:install
 *
 * This registers a service named "LIMS Instrument Gateway" that:
 *   - starts automatically on boot (no daily/manual start),
 *   - runs in the background with no window,
 *   - restarts automatically if it crashes.
 *
 * Configuration is read from instrument-gateway/.env at startup, so to change
 * settings later: edit .env, then restart the service (services.msc) — no need
 * to reinstall.
 *
 * To remove it: npm run service:uninstall (also as Administrator).
 */

const path = require('path')
const { Service } = require('node-windows')

const svc = new Service({
  name: 'LIMS Instrument Gateway',
  description:
    'Receives HL7 analyzer results over MLLP/TCP on the lab network and forwards them to the LIMS app.',
  script: path.join(__dirname, '..', 'index.js'),
  // Restart-on-crash backoff: wait 2s, grow by 0.5x each retry, up to 40 tries.
  wait: 2,
  grow: 0.5,
  maxRestarts: 40,
})

svc.on('install', () => {
  console.log('✓ Service "LIMS Instrument Gateway" installed (starts on boot). Starting now…')
  svc.start()
})

svc.on('alreadyinstalled', () => {
  console.log(
    'The service is already installed. Run "npm run service:uninstall" first if you want to reinstall it.'
  )
})

svc.on('start', () => {
  console.log('✓ Running. It will now start automatically every time this PC boots.')
  console.log('  Manage it any time from services.msc → "LIMS Instrument Gateway".')
})

svc.on('error', (err) => {
  console.error('Service error:', err)
})

console.log('Installing the LIMS Instrument Gateway service…')
console.log('(If this fails with a permissions error, run the command prompt as Administrator.)')
svc.install()
