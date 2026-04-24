const fs = require('fs');
const path = require('path');

const replicaId = process.env.REPLICA_ID || '1';
const filePath = path.join(__dirname, `data-${replicaId}.json`);

function loadData() {
    try {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
    } catch {
        return { currentTerm: 0, votedFor: null, log: {} };
    }
}

function saveData(data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function saveState(currentTerm, roomLogs, votedFor = null) {
    const data = {
        currentTerm,
        votedFor,
        log: roomLogs
    };
    saveData(data);
}

module.exports = {
    loadData,
    saveState
};
