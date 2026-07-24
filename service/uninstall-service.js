/**
 * Remove the "LIMS Instrument Gateway" Windows service.
 *
 * Run from an **Administrator** command prompt:
 *
 *   npm run service:uninstall
 */

const path = require('path')
const { Service } = require('node-windows')

const svc = new Service({
  name: 'LIMS Instrument Gateway',
  script: path.join(__dirname, '..', 'index.js'),
})

svc.on('uninstall', () => {
  console.log('✓ Service "LIMS Instrument Gateway" removed.')
})

svc.on('error', (err) => {
  console.error('Service error:', err)
})

console.log('Removing the LIMS Instrument Gateway service…')
console.log('(If this fails with a permissions error, run the command prompt as Administrator.)')
svc.uninstall()
