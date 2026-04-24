const express = require('express');
const axios = require('axios');
const http = require('http'); // NEW: Required for the keepAlive HTTP Agent
const app = express();
app.use(express.json());


const storage = require('./storage');
const REPLICA_ID = process.env.REPLICA_ID || 1;
const PORT = process.env.PORT || 8081;
const NODE_ID = `replica-${REPLICA_ID}`;

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '150', 10);
const ELECTION_TIMEOUT_MIN_MS = parseInt(process.env.ELECTION_TIMEOUT_MIN_MS || '500', 10);
const ELECTION_TIMEOUT_MAX_MS = parseInt(process.env.ELECTION_TIMEOUT_MAX_MS || '800', 10);

const clusterNodes = [
    'http://replica1:8081',
    'http://replica2:8082',
    'http://replica3:8083'
];

let isNetworkPartitioned = false;

// THE BRICK WALL: Block all incoming traffic if partitioned
app.use((req, res, next) => {
    // We have to let the toggle endpoint through, otherwise we can never plug it back in!
    if (isNetworkPartitioned && req.path !== '/toggle-partition') {
        return res.status(503).json({ success: false, error: "Node is partitioned" });
    }
    next(); // If not partitioned, let the traffic through normally
});

// ==========================================
// ENTERPRISE FIX 1: THE SOCKET POOL
// ==========================================
// Docker limits how many raw TCP sockets can be opened per second.
// This forces Axios to REUSE sockets, completely eliminating the SYN-flood crashes.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const axiosInstance = axios.create({ httpAgent });

const persisted = storage.loadData();
let state = 'FOLLOWER';
let currentTerm = persisted.currentTerm || 0;
let votedFor = persisted.votedFor || null;

let roomLogs = persisted.log || {};
let roomCommitIndices = {};

let electionTimer = null;
let heartbeatTimer = null;

const followers = clusterNodes.filter(url => !url.endsWith(`:${PORT}`));

// ==========================================
// ENTERPRISE FIX 2: THE CIRCUIT BREAKERS
// ==========================================
const deadFollowers = new Set();
const isHeartbeating = {};



function persistState() {
    storage.saveState(currentTerm, roomLogs, votedFor);
}

function randomElectionTimeoutMs() {
    const min = Math.min(ELECTION_TIMEOUT_MIN_MS, ELECTION_TIMEOUT_MAX_MS);
    const max = Math.max(ELECTION_TIMEOUT_MIN_MS, ELECTION_TIMEOUT_MAX_MS);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function stopHeartbeatLoop() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function resetElectionTimer() {
    if (electionTimer) {
        clearTimeout(electionTimer);
        electionTimer = null;
    }
    if (state === 'LEADER') return;

    electionTimer = setTimeout(() => {
        startElection().catch((error) => {
            console.log(`[Replica ${REPLICA_ID}] Election error: ${error.message}`);
            resetElectionTimer();
        });
    }, randomElectionTimeoutMs());
}

function stepDown(nextTerm) {
    console.log(`\n[Replica ${REPLICA_ID}] 📉 STEPPING DOWN. My term: ${currentTerm}, Incoming term: ${nextTerm}`);
    
    if (nextTerm > currentTerm) {
        console.log(`[Replica ${REPLICA_ID}] 🔄 Term updated to ${nextTerm}. Clearing votedFor.`);
        currentTerm = nextTerm;
        votedFor = null;
        persistState();
    }

    if (state !== 'FOLLOWER') {
        console.log(`[Replica ${REPLICA_ID}] 🛑 State changed from ${state} to FOLLOWER. Stopping heartbeats.`);
        state = 'FOLLOWER';
        stopHeartbeatLoop();
    }

    resetElectionTimer();
}

async function sendHeartbeats() {
    if (isNetworkPartitioned) return;
    if (state !== 'LEADER') return;
    const payload = { term: currentTerm, leaderId: NODE_ID };

    followers.forEach(async (followerUrl) => {
        // LOCK: Do not fire a 2nd heartbeat if the 1st is still hanging
        if (isHeartbeating[followerUrl]) return;
        isHeartbeating[followerUrl] = true;

        try {
            const response = await axiosInstance.post(`${followerUrl}/heartbeat`, payload, { timeout: 1000 });
            deadFollowers.delete(followerUrl); // Node is alive!
            
            if (response.data && response.data.term > currentTerm) {
                stepDown(response.data.term);
            }
        } catch {
            deadFollowers.add(followerUrl); // Node is dead! Quarantine it.
        } finally {
            isHeartbeating[followerUrl] = false;
        }
    });
}

function startHeartbeatLoop() {
    stopHeartbeatLoop();
    void sendHeartbeats(); 
    heartbeatTimer = setInterval(() => void sendHeartbeats(), HEARTBEAT_INTERVAL_MS);
}

async function startElection() {
    if (isNetworkPartitioned) return;
    if (state === 'LEADER') return;

    state = 'CANDIDATE';
    currentTerm += 1;
    votedFor = NODE_ID;
    persistState();

    console.log(`\n=========================================`);
    console.log(`[Replica ${REPLICA_ID}] 🚀 STARTING ELECTION FOR TERM ${currentTerm}`);
    console.log(`=========================================`);

    let votes = 1;
    const termAtStart = currentTerm;
    const majority = Math.floor(clusterNodes.length / 2) + 1;

    let finished = false;

    // EARLY RESOLUTION PROMISE
    await new Promise((resolve) => {
        let completedRequests = 0;

        followers.forEach(async (followerUrl) => {
            try {
                console.log(`[Replica ${REPLICA_ID}] 📨 Asking ${followerUrl} for a vote...`);
                const response = await axiosInstance.post(`${followerUrl}/request-vote`, {
                    term: termAtStart, candidateId: NODE_ID
                }, { timeout: 500 });
                
                deadFollowers.delete(followerUrl); // They answered, they are alive!

                const data = response.data || {};
                
                if (data.term > currentTerm) {
                    console.log(`[Replica ${REPLICA_ID}] ❌ ${followerUrl} has a higher term (${data.term}). Aborting election.`);
                    stepDown(data.term);
                } else if (state === 'CANDIDATE' && currentTerm === termAtStart && data.voteGranted) {
                    console.log(`[Replica ${REPLICA_ID}] ✅ Vote GRANTED by ${followerUrl}!`);
                    votes += 1;
                } else if (state === 'LEADER' && data.voteGranted) {
                    // THE FIX: Catch the late "Yes" votes so they don't print as "Denied"
                    console.log(`[Replica ${REPLICA_ID}] 📩 Late vote GRANTED by ${followerUrl}, but I already won!`);
                } else {
                    console.log(`[Replica ${REPLICA_ID}] 🚫 Vote DENIED by ${followerUrl}.`);
                }
            } catch (e) {
                console.log(`[Replica ${REPLICA_ID}] ⚠️ Cannot reach ${followerUrl} for election.`);
                deadFollowers.add(followerUrl); // Immediately quarantine dead node
            } finally {
                completedRequests++;
                // Resolve the instant we hit majority, do not wait!
                if (votes >= majority || completedRequests === followers.length) {
                    if (!finished) { finished = true; resolve(); }
                }
            }
        });
        
        // FAILSAFE TIMER: Prevents Node.js from freezing infinitely
        setTimeout(() => { if (!finished) { finished = true; resolve(); } }, 1000);
    });

    if (state !== 'CANDIDATE' || currentTerm !== termAtStart) {
        console.log(`[Replica ${REPLICA_ID}] 🛑 Election interrupted. No longer candidate for term ${termAtStart}.`);
        if (state !== 'LEADER') resetElectionTimer();
        return;
    }

    console.log(`[Replica ${REPLICA_ID}] 📊 ELECTION TALLY: ${votes}/${clusterNodes.length} votes.`);

    if (votes >= majority) {
        state = 'LEADER';
        if (electionTimer) {
            clearTimeout(electionTimer);
            electionTimer = null;
        }
        console.log(`\n👑 [Replica ${REPLICA_ID}] BECAME LEADER FOR TERM ${currentTerm} 👑\n`);
        startHeartbeatLoop();
        return;
    }

    console.log(`[Replica ${REPLICA_ID}] ❌ Failed to secure majority. Returning to FOLLOWER.`);
    state = 'FOLLOWER';
    resetElectionTimer();
}

// THE BRICK WALL: Block all incoming traffic if partitioned
app.use((req, res, next) => {
    // We have to let the toggle endpoint through, otherwise we can never plug it back in!
    if (isNetworkPartitioned && req.path !== '/toggle-partition') {
        return res.status(503).json({ success: false, error: "Node is partitioned" });
    }
    next(); // If not partitioned, let the traffic through normally
});

app.post('/client-stroke', async (req, res) => {
    if (state !== 'LEADER') return res.status(400).json({ success: false, message: "I am not the leader." });

    const newStroke = req.body;
    const roomId = newStroke.roomId;

    if (!roomLogs[roomId]) { roomLogs[roomId] = []; roomCommitIndices[roomId] = 0; }
    if (roomLogs[roomId].length > 10000) roomLogs[roomId].shift();

    roomLogs[roomId].push(newStroke);
    persistState();
    const prevLogIndex = roomLogs[roomId].length - 2;

    console.log(`[Replica ${REPLICA_ID}] Leader received stroke. Log size for ${roomId}: ${roomLogs[roomId].length}`);

    const payload = {
        term: currentTerm, leaderId: NODE_ID, roomId: roomId,
        prevLogIndex: prevLogIndex, entries: [newStroke], leaderCommitIndex: roomCommitIndices[roomId]
    };

    let successCount = 1;
    let finished = false;

    await new Promise((resolve) => {
        let completedRequests = 0;

        followers.forEach(async (followerUrl) => {
            // CIRCUIT BREAKER: Skip known dead nodes instantly
            if (deadFollowers.has(followerUrl)) {
                completedRequests++;
                if (successCount >= 2 || completedRequests === followers.length) {
                    if (!finished) { finished = true; resolve(); }
                }
                return;
            }

            let nodeReplied = false;

            // THE FIX: The RAFT Retry Loop! Try up to 2 times to get the stroke through.
            for (let attempt = 1; attempt <= 2 && !nodeReplied; attempt++) {
                try {
                    const response = await axiosInstance.post(`${followerUrl}/append-entries`, payload, { timeout: 2500 });
                    deadFollowers.delete(followerUrl);
                    nodeReplied = true; // It worked! Stop retrying.

                    if (response.data.success) {
                        successCount++;
                    } else if (response.data.missingData) {
                        const missingStrokes = roomLogs[roomId].slice(response.data.followerLogLength);
                        try {
                            await axiosInstance.post(`${followerUrl}/append-entries`, {
                                term: currentTerm, leaderId: NODE_ID, roomId: roomId,
                                prevLogIndex: response.data.followerLogLength - 1, entries: missingStrokes,
                                leaderCommitIndex: roomCommitIndices[roomId]
                            }, { timeout: 2500 });
                            successCount++;
                        } catch (e) { }
                    } else if (response.data.term && response.data.term > currentTerm) {
                        stepDown(response.data.term);
                    }
                } catch (error) {
                    if (attempt === 2) {
                        // Only log the error if both attempts failed
                        console.log(`[Replica ${REPLICA_ID}] ⚠️ Cannot reach ${followerUrl} after 2 attempts`);
                    }
                }
            }

            // Move to the next node / resolve the Promise
            completedRequests++;
            if (successCount >= 2 || completedRequests === followers.length) {
                if (!finished) { finished = true; resolve(); }
            }
        });
        
        setTimeout(() => { if (!finished) { finished = true; resolve(); } }, 3000);
    });

    if (successCount >= 2) {
        roomCommitIndices[roomId] = roomLogs[roomId].length - 1;
        console.log(`[Replica ${REPLICA_ID}] MAJORITY REACHED. Stroke committed at index ${roomCommitIndices[roomId]}.`);
        res.json({ success: true, message: "Stroke committed to cluster" });
    } else {
        console.log(`[Replica ${REPLICA_ID}] MAJORITY FAILED. Stroke discarded.`);
        const failedIndex = roomLogs[roomId].indexOf(newStroke);
        if (failedIndex > -1) {
            roomLogs[roomId].splice(failedIndex, 1);
            persistState();
        }
        res.status(500).json({ success: false, message: "Cluster failed to reach consensus" });
    }
});

app.post('/append-entries', (req, res) => {
    if (isNetworkPartitioned) return res.status(503).json({ error: "Network unreachable" });
    const { term, roomId, prevLogIndex, entries, leaderCommitIndex } = req.body;

    if (term < currentTerm) return res.json({ success: false, term: currentTerm });

    if (term > currentTerm) {
        currentTerm = term;
        votedFor = null;
        persistState();
    }

    if (state !== 'FOLLOWER') {
        state = 'FOLLOWER';
        stopHeartbeatLoop();
    }
    resetElectionTimer();

    if (!roomLogs[roomId]) { roomLogs[roomId] = []; roomCommitIndices[roomId] = 0; }

    if (prevLogIndex >= 0 && !roomLogs[roomId][prevLogIndex]) {
        console.log(`[Replica ${REPLICA_ID}] WAIT! I am missing older strokes. Rejecting!`);
        return res.json({ success: false, missingData: true, followerLogLength: roomLogs[roomId].length });
    }

    if (entries && entries.length > 0) {
        roomLogs[roomId].splice(prevLogIndex + 1);
        roomLogs[roomId].push(...entries);
        persistState();
        console.log(`[Replica ${REPLICA_ID}] Follower saved stroke! Log size: ${roomLogs[roomId].length}`);
    }

    if (leaderCommitIndex > roomCommitIndices[roomId]) {
        roomCommitIndices[roomId] = Math.min(leaderCommitIndex, roomLogs[roomId].length - 1);
    }
    res.json({ success: true });
});

app.post('/heartbeat', (req, res) => {
    if (isNetworkPartitioned) return res.status(503).json({ error: "Network unreachable" });
    const { term } = req.body;

    if (term < currentTerm) return res.json({ success: false, term: currentTerm });

    if (term > currentTerm) {
        currentTerm = term;
        votedFor = null;
        persistState();
    }
    
    if (state !== 'FOLLOWER') {
        state = 'FOLLOWER';
        stopHeartbeatLoop();
    }
    
    resetElectionTimer();
    res.json({ success: true, term: currentTerm });
});

app.post('/request-vote', (req, res) => {
    if (isNetworkPartitioned) return res.status(503).json({ error: "Network unreachable" });
    const { term, candidateId } = req.body;

    console.log(`\n[Replica ${REPLICA_ID}] 📥 Received vote request from ${candidateId} for Term ${term}. (My Term: ${currentTerm}, My VotedFor: ${votedFor})`);

    if (typeof term !== 'number' || !candidateId) {
        console.log(`[Replica ${REPLICA_ID}] 🚫 Rejecting: Malformed request.`);
        return res.status(400).json({ voteGranted: false, term: currentTerm });
    }

    if (term < currentTerm) {
        console.log(`[Replica ${REPLICA_ID}] 🚫 Rejecting: Candidate term (${term}) is older than mine (${currentTerm}).`);
        return res.json({ voteGranted: false, term: currentTerm });
    }

    if (term > currentTerm) {
        console.log(`[Replica ${REPLICA_ID}] 📈 Candidate term (${term}) is newer. Updating my term and clearing votedFor.`);
        currentTerm = term;
        votedFor = null;
        if (state !== 'FOLLOWER') { 
            state = 'FOLLOWER'; 
            stopHeartbeatLoop(); 
        }
        persistState();
    }

    if (votedFor !== null && votedFor !== candidateId) {
        console.log(`[Replica ${REPLICA_ID}] 🚫 Rejecting: I already voted for ${votedFor} in this term.`);
        // ==========================================
        // ENTERPRISE FIX 3: THE SPLIT-VOTE BUG
        // ==========================================
        // Previously, we called resetElectionTimer() here. That was a fatal RAFT violation!
        // A node MUST NOT reset its timer when it rejects a candidate. 
        // Doing so forces nodes into an infinite loop of simultaneous split votes.
        return res.json({ voteGranted: false, term: currentTerm });
    }

    console.log(`[Replica ${REPLICA_ID}] ✅ Granting vote to ${candidateId} for Term ${currentTerm}.`);
    votedFor = candidateId;
    persistState();
    resetElectionTimer(); // We ONLY reset the timer if we actually grant a vote
    res.json({ voteGranted: true, term: currentTerm });
});

app.delete('/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    delete roomLogs[roomId]; delete roomCommitIndices[roomId]; persistState();
    if (state === 'LEADER') {
        followers.forEach(followerUrl => axiosInstance.delete(`${followerUrl}/room/${roomId}`).catch(() => {}));
    }
    console.log(`[Replica ${REPLICA_ID}] Room ${roomId} deleted from memory.`);
    res.json({ success: true });
});

app.get('/canvas/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    res.json({ exists: roomLogs.hasOwnProperty(roomId), log: roomLogs[roomId] || [] });
});

app.delete('/canvas/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    if (roomLogs[roomId]) {
        roomLogs[roomId] = []; persistState();
        if (state === 'LEADER') {
            followers.forEach(followerUrl => axiosInstance.delete(`${followerUrl}/canvas/${roomId}`).catch(() => {}));
        }
        console.log(`[Replica ${REPLICA_ID}] Cleared history for room ${roomId}`);
    }
    res.json({ success: true });
});

app.delete('/undo/:roomId/:userId', (req, res) => {
    const { roomId, userId } = req.params;
    if (!roomLogs[roomId] || roomLogs[roomId].length === 0) return res.json({ success: false });

    let targetStrokeId = null;
    for (let i = roomLogs[roomId].length - 1; i >= 0; i--) {
        // Search by userId instead of userName!
        if (roomLogs[roomId][i].userId === userId) { 
            targetStrokeId = roomLogs[roomId][i].strokeId; 
            break; 
        }
    }
    
    if (!targetStrokeId) return res.json({ success: false });

    roomLogs[roomId] = roomLogs[roomId].filter(stroke => stroke.strokeId !== targetStrokeId);
    persistState();

    if (state === 'LEADER') {
        followers.forEach(followerUrl => axiosInstance.delete(`${followerUrl}/undo/${roomId}/${userId}`).catch(() => {}));
    }
    console.log(`[Replica ${REPLICA_ID}] Undid full stroke batch for user ID ${userId}`);
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    res.json({ replicaId: REPLICA_ID, state, currentTerm, votedFor, activeRooms: Object.keys(roomLogs).length, totalLogs: Object.values(roomLogs).reduce((acc, logs) => acc + logs.length, 0) });
});

app.post('/toggle-partition', (req, res) => {
    isNetworkPartitioned = !isNetworkPartitioned;
    console.log(`[Replica ${REPLICA_ID}] Network Partition: ${isNetworkPartitioned ? 'ACTIVE (Cut off)' : 'RESOLVED (Reconnected)'}`);
    res.json({ partitioned: isNetworkPartitioned });
});

app.listen(PORT, () => {
    console.log(`Replica ${REPLICA_ID} running on port ${PORT} as ${state}`);
    resetElectionTimer();
});