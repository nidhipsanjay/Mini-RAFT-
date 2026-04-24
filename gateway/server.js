const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const http = require('http');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentLeader = null;
// The hardcoded addresses of your 3 RAFT containers
const clusterNodes = [
    'http://replica1:8081',
    'http://replica2:8082',
    'http://replica3:8083'
];

// We need a lock to prevent spamming the cluster with election checks
let isSearchingForLeader = false;
let leaderSearchPromise = null;
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const axiosInstance = axios.create({ httpAgent });

async function findLeader(force = false) {
    if (isSearchingForLeader && leaderSearchPromise) {
        return leaderSearchPromise;
    }

    leaderSearchPromise = (async () => {
        if (!force && currentLeader) {
            try {
                const check = await axios.get(`${currentLeader}/status`, { timeout: 500 });
                if (check.data && check.data.state === 'LEADER') {
                    return currentLeader;
                }
            } catch {
                // Fall through to full cluster scan.
            }
        }

        for (const node of clusterNodes) {
            try {
                const response = await axios.get(`${node}/status`, { timeout: 500 });
                if (response.data && response.data.state === 'LEADER') {
                    currentLeader = node;
                    return currentLeader;
                }
            } catch {
                // Node may be down.
            }
        }

        currentLeader = null;
        return null;
    })();

    isSearchingForLeader = true;
    try {
        return await leaderSearchPromise;
    } finally {
        isSearchingForLeader = false;
        leaderSearchPromise = null;
    }
}

async function requestViaLeader(requestFn) {
    let leader = currentLeader || await findLeader();

    // THE FIX: If there is no leader, the cluster is probably in the middle of an election!
    // Wait 1 second for them to finish voting, then check again.
    if (!leader) {
        console.log("[Gateway] Cluster is voting! Holding strokes in the waiting room...");
        await new Promise(resolve => setTimeout(resolve, 1000));
        leader = await findLeader(true);
    }

    if (!leader) throw new Error('No active leader found after waiting');

    try {
        return await requestFn(leader);
    } catch (error) {
        console.log(`[Gateway] Leader ${leader} failed. Wiping from memory and retrying...`);
        currentLeader = null; 
        
        leader = await findLeader(true); 
        
        // THE FIX: Wait here too, just in case the old leader JUST died and voting just started!
        if (!leader) {
            console.log("[Gateway] Cluster is voting! Holding strokes in the waiting room...");
            await new Promise(resolve => setTimeout(resolve, 1000));
            leader = await findLeader(true);
        }

        if (!leader) throw new Error('No active leader found after retry');
        
        return requestFn(leader); 
    }
}

// A dedicated background loop to manage the UI state seamlessly
setInterval(async () => {
    const oldLeader = currentLeader;
    await findLeader();
    
    // If the cluster heals and finds a new leader, broadcast the green badge to all users!
    if (currentLeader && currentLeader !== oldLeader) {
        io.emit('leader-status', { status: 'healthy', msg: `Connected to Leader (${currentLeader})` });
    } else if (!currentLeader) {
        io.emit('leader-status', { status: 'chaotic', msg: 'LEADER DOWN! Re-electing...' });
    }
}, 2000);

void findLeader(true);

// --- RAFT WEBHOOK ---
// The Leader will call this endpoint ONLY after a stroke is successfully 
// committed to a majority of the replica logs.
/*app.post('/broadcast', (req, res) => {
    const committedStroke = req.body;
    
    // NOW the Gateway officially tells all connected browsers to draw it
    io.emit('remote-stroke', committedStroke);
    
    res.status(200).send("Broadcast successful");
});*/

// Keep track of which rooms actually exist
// --- UPGRADE: Ghost Room Collision Preventer ---
async function generateUniqueRoomId() {
    let roomId = "";
    let isUnique = false;

    while (!isUnique) {
        // 1. Generate 5 random letters
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        roomId = '';
        for (let i = 0; i < 5; i++) roomId += chars.charAt(Math.floor(Math.random() * chars.length));

        // 2. Ask the RAFT cluster if this room is saved on their hard drives!
        try {
            const response = await requestViaLeader((leader) =>
                axiosInstance.get(`${leader}/canvas/${roomId}`, { timeout: 1000 })
            );
            
            if (!response.data.exists) {
                isUnique = true; // It's safe!
            } else {
                console.log(`[Gateway] Ghost room ${roomId} found on disk! Generating a new one...`);
            }
        } catch (error) {
            // If the cluster is completely down, just use the ID anyway to maintain availability
            isUnique = true;
        }
    }
    return roomId;
}

// Create an API endpoint so your frontend can ask for a safe ID
app.get('/api/generate-room', async (req, res) => {
    const newRoomId = await generateUniqueRoomId();
    res.json({ roomId: newRoomId });
});

const activeRooms = new Set();

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    const broadcastUserList = async (roomId) => {
        const sockets = await io.in(roomId).fetchSockets();
        const users = sockets.map(s => ({ id: s.id, name: s.userName }));
        io.to(roomId).emit('room-users-update', users);
    };

    // --- UPGRADE: Tweak 2 (Create vs Join Bouncer with Database Fallback) ---
    socket.on('join-room', async (data, callback) => { 
        const { roomId, userName, isCreating } = data;

        let roomExistsInBackend = false;
        let canvasHistory = [];

        // 1. ALWAYS ask the Leader for the room data first
        try {
            const response = await requestViaLeader((leader) =>
                axios.get(`${leader}/canvas/${roomId}`, { timeout: 1000 })
            );
            roomExistsInBackend = response.data.exists;
            canvasHistory = response.data.log || [];
        } catch (error) {}

        // 2. The Check: If it's not a new room, AND the Gateway forgot it, AND the database forgot it -> Reject!
        if (!isCreating && !activeRooms.has(roomId) && !roomExistsInBackend) {
            return callback({ success: false, message: "Room not found!" });
        }

        // 3. If the database remembered the room but the Gateway forgot it (due to a crash), restore it to RAM!
        activeRooms.add(roomId);

        socket.join(roomId);
        socket.roomId = roomId;
        socket.userName = userName;
        
        // 4. Send the history we fetched in step 1 directly to the user
        socket.emit('canvas-history', canvasHistory);

        await broadcastUserList(roomId);
        callback({ success: true }); 
    });

    // --- UPGRADE: Tweak 3 (Delete Room When Empty) ---
    socket.on('leave-room', async (data) => {
        socket.leave(data.roomId);
        socket.to(data.roomId).emit('cursor-disconnect', socket.id);
        socket.roomId = null;
        await broadcastUserList(data.roomId);
        checkAndCleanUpRoom(data.roomId);
    });

    socket.on('disconnect', async () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('cursor-disconnect', socket.id);
            const tempRoom = socket.roomId;
            socket.leave(socket.roomId);
            await broadcastUserList(tempRoom);
            checkAndCleanUpRoom(tempRoom);
        }
    });

    // Helper to delete the room if the last person leaves
    async function checkAndCleanUpRoom(roomId) {
        // Wait 60 seconds to see if anyone comes back!
        setTimeout(async () => {
            const room = io.sockets.adapter.rooms.get(roomId);
            
            // Check if it's empty AND check if it hasn't already been deleted!
            if ((!room || room.size === 0) && activeRooms.has(roomId)) {
                
                console.log(`Room ${roomId} has been empty for 60s. Deleting...`);
                activeRooms.delete(roomId); // The first timer deletes it from RAM here
                
                try {
                    await requestViaLeader((leader) =>
                        axios.delete(`${leader}/room/${roomId}`, { timeout: 1000 })
                    );
                } catch(e){}
            }
        }, 60000); // 60,000 ms = 1 minute
    }

    socket.on('cursor-move', (data) => { if (socket.roomId) socket.to(socket.roomId).emit('cursor-move', data); });
    // Removed the 'async' keyword here
    socket.on('draw-stroke', (strokeData) => {
        if (socket.roomId) socket.to(socket.roomId).emit('remote-stroke', strokeData); 
        
        // "Fire and Forget". Send it to the RAFT cluster in the 
        // background, but do NOT halt the WebSocket thread to wait for it.
        requestViaLeader((leader) =>
            axiosInstance.post(`${leader}/client-stroke`, strokeData, { timeout: 2000 })
        ).catch(() => {
            // Silently ignore drops. Our background health-checker will handle UI warnings.
        });
    });
    // Tell the Leader to forget the drawings
    socket.on('clear-canvas', async () => { 
        if (socket.roomId) {
            socket.to(socket.roomId).emit('clear-canvas'); 
            
            try { 
                // Hit your brand new Replica endpoint
                await requestViaLeader((leader) =>
                    axiosInstance.delete(`${leader}/canvas/${socket.roomId}`, { timeout: 1000 })
                );
            } catch(error) {}
        }
    });
    // --- UPGRADE: The Undo Feature ---
    socket.on('undo-stroke', async () => {
        if (!socket.roomId || !socket.userName) return;

        try {
            // Tell the Leader to delete the stroke from memory
            await requestViaLeader((leader) =>
                axiosInstance.delete(`${leader}/undo/${socket.roomId}/${socket.id}`, { timeout: 1000 })
            );
            
            // Ask the Leader for the newly updated, fixed array
            const response = await requestViaLeader((leader) =>
                axiosInstance.get(`${leader}/canvas/${socket.roomId}`, { timeout: 1000 })
            );
            
            // Tell EVERYONE in the room to clear their board and redraw the fixed history!
            io.to(socket.roomId).emit('clear-canvas');
            io.to(socket.roomId).emit('canvas-history', response.data.log);
        } catch (error) {
            console.log("Undo failed.");
        }
    });
});

// ===== DASHBOARD CLUSTER STATUS API =====
app.get('/cluster-status', async (req, res) => {
    const nodes = [
        'http://replica1:8081/status',
        'http://replica2:8082/status',
        'http://replica3:8083/status'
    ];

    const results = await Promise.allSettled(
        nodes.map(url =>
            axios.get(url)
        )
    );

    const formatted = results.map(r =>
        r.status === "fulfilled" ? r.value.data : null
    );

    res.json(formatted);
});

// Clean URL for the dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Gateway running on http://localhost:${PORT}`);
});
