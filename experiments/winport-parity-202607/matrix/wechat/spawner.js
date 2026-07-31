const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const child = spawn(process.execPath, [path.join(__dirname, 'sleeper.js')], { stdio: 'ignore' });
fs.writeFileSync(path.join(__dirname, 'grandchild.pid'), String(child.pid));
fs.writeFileSync(path.join(__dirname, 'self.pid'), String(process.pid));
setInterval(() => {}, 60000);
