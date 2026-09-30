/**
 * Install the analyzer relay as an auto-starting Windows service.
 *
 * Run ONCE on the lab PC, from an **Administrator** command prompt, after
 * creating relay.env (copy relay.env.example -> relay.env and edit):
 *
 *   npm run relay:install
 *
 * Registers a service named "LIMS Analyzer Relay" that starts on every boot,
 * runs with no window, and restarts if it crashes. To change settings later:
 * edit relay.env, then restart the service in services.msc.
 *
 * To remove it: npm run relay:uninstall (also as Administrator).
 */

const path = require('path')
const { Service } = require('node-windows')

const svc = new Service({
  name: 'LIMS Analyzer Relay',
  description:
    'Connects a lab analyzer that waits for the LIS (e.g. Mindray BC-5150) to the central LIMS instrument gateway.',
  script: path.join(__dirname, '..', 'relay.js'),
  wait: 2,
  grow: 0.5,
  maxRestarts: 40,
})

svc.on('install', () => {
  console.log('✓ Service "LIMS Analyzer Relay" installed (starts on boot). Starting now…')
  svc.start()
})

svc.on('alreadyinstalled', () => {
  console.log(
    'The service is already installed. Run "npm run relay:uninstall" first if you want to reinstall it.'
  )
})

svc.on('start', () => {
  console.log('✓ Running. It will now start automatically every time this PC boots.')
  console.log('  Manage it any time from services.msc -> "LIMS Analyzer Relay".')
})

svc.on('error', (err) => {
  console.error('Service error:', err)
})

console.log('Installing the LIMS Analyzer Relay service…')
console.log('(If this fails with a permissions error, run the command prompt as Administrator.)')
svc.install()
