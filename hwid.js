const { execSync } = require('child_process');
const crypto = require('crypto');

function getClientHWID() {
    try {
        const biosUUID = execSync('wmic csproduct get uuid').toString().split('\n')[1].trim();
        const diskSerial = execSync('wmic diskdrive get serialnumber').toString().split('\n')[1].trim();
        
        const rawHWID = `${biosUUID}-${diskSerial}`;
        return crypto.createHash('sha256').update(rawHWID).digest('hex');
    } catch (e) {
        return 'FALLBACK-HWID-ERROR';
    }
}

module.exports = { getClientHWID };