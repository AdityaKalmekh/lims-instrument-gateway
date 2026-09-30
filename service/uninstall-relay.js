/**
 * Remove the "LIMS Analyzer Relay" Windows service.
 *
 * Run from an **Administrator** command prompt:
 *
 *   npm run relay:uninstall
 */

const path = require('path')
const { Service } = require('node-windows')

const svc = new Service({
  name: 'LIMS Analyzer Relay',
  script: path.join(__dirname, '..', 'relay.js'),
})

svc.on('uninstall', () => {
  console.log('✓ Service "LIMS Analyzer Relay" removed.')
})

svc.on('error', (err) => {
  console.error('Service error:', err)
})

console.log('Removing the LIMS Analyzer Relay service…')
console.log('(If this fails with a permissions error, run the command prompt as Administrator.)')
svc.uninstall()
