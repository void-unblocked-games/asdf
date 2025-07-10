const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const aiQueryCounts = new Map(); // Maps userId to query count
const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const DOMPurify = require('dompurify');

const window = new JSDOM('').window;
const purify = DOMPurify(window);

const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code == 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocket.Server({ server });

const clients = new Map(); // Maps userId to WebSocket
const userVanities = new Map(); // Maps userId to userVanity
const usersTyping = new Map(); // Maps userId to a Set of recipients they are typing to

function generateUserId(ip) {
    const hash = crypto.createHash('sha256');
    hash.update(ip + Date.now());
    return `user-${hash.digest('hex').substring(0, 8)}`;
}

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    let currentUserId; // Use a local variable for the current connection's userId

    // Assign a userId immediately upon connection
    // This userId will be used until a reconnect or setVanity message updates it
    // currentUserId will be determined by the first message from the client (reconnect or setVanity)

    ws.on('message', (message) => {
        const parsedMessage = JSON.parse(message);

        if (parsedMessage.type === 'reconnect' && parsedMessage.id && parsedMessage.vanity) {
            const existingWs = [...clients.entries()].find(([clientWs, id]) => id === parsedMessage.id)?.[0];
            if (existingWs && existingWs !== ws) {
                console.log(`Closing old connection for user ${parsedMessage.id} to allow new one to take over.`);
                existingWs.close(1000, 'New connection established');
            }
            currentUserId = parsedMessage.id;
            clients.set(ws, currentUserId); // Update client map with reconnected ID
            userVanities.set(currentUserId, parsedMessage.vanity);
            ws.send(JSON.stringify({ type: 'userId', id: currentUserId, vanity: parsedMessage.vanity })); // Confirm ID to client
            console.log(`Client reconnected with ID: ${currentUserId} (Vanity: ${parsedMessage.vanity})`);
            broadcastUserList(); // Broadcast updated user list after reconnect
        } else if (parsedMessage.type === 'setVanity' && parsedMessage.vanity) {
            if (!currentUserId) { // If this is a new connection setting vanity for the first time
                currentUserId = generateUserId(ip);
                clients.set(ws, currentUserId);
                ws.send(JSON.stringify({ type: 'userId', id: currentUserId })); // Send newly generated ID to client
            }
            userVanities.set(currentUserId, parsedMessage.vanity);
            console.log(`Client ${currentUserId} set vanity to: ${parsedMessage.vanity}`);
            broadcastUserList(); // Broadcast updated user list after vanity is set
        }

        // Now that currentUserId and userVanities are (hopefully) set, process the message
        // Ensure currentUserId is set before proceeding
        if (!currentUserId) {
            currentUserId = generateUserId(ip);
            clients.set(ws, currentUserId);
            userVanities.set(currentUserId, `user-${currentUserId.substring(5, 13)}`); // Assign a default vanity
            ws.send(JSON.stringify({ type: 'userId', id: currentUserId, vanity: userVanities.get(currentUserId) }));
            console.log(`Assigned new ID and default vanity to client: ${currentUserId}`);
            broadcastUserList();
        }

        parsedMessage.sender = currentUserId;
        parsedMessage.senderVanity = userVanities.get(currentUserId);

        if (parsedMessage.type === 'typing') {
            if (!usersTyping.has(currentUserId)) {
                usersTyping.set(currentUserId, new Set());
            }
            if (parsedMessage.recipient) {
                usersTyping.get(currentUserId).add(parsedMessage.recipient);
                const recipientSocket = [...clients.entries()].find(([_, id]) => id === parsedMessage.recipient)?.[0];
                if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                    recipientSocket.send(JSON.stringify(parsedMessage));
                }
            } else {
                usersTyping.get(currentUserId).add('public');
                broadcast(parsedMessage, ws);
            }
        } else if (parsedMessage.type === 'stoppedTyping') {
            if (usersTyping.has(currentUserId)) {
                if (parsedMessage.recipient) {
                    usersTyping.get(currentUserId).delete(parsedMessage.recipient);
                    const recipientSocket = [...clients.entries()].find(([_, id]) => id === parsedMessage.recipient)?.[0];
                    if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                        recipientSocket.send(JSON.stringify(parsedMessage));
                    }
                } else {
                    usersTyping.get(currentUserId).delete('public');
                    broadcast(parsedMessage, ws);
                }
                if (usersTyping.get(currentUserId).size === 0) {
                    usersTyping.delete(currentUserId);
                }
            }
        } else if (parsedMessage.type === 'dm') {
            const sanitizedContent = purify.sanitize(parsedMessage.content);
            parsedMessage.content = sanitizedContent;
            const recipientSocket = [...clients.entries()].find(([_, id]) => id === parsedMessage.recipient)?.[0];
            if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                recipientSocket.send(JSON.stringify(parsedMessage));
            }
        } else if (parsedMessage.type === 'chat') {
            const sanitizedContent = purify.sanitize(parsedMessage.content);
            parsedMessage.content = sanitizedContent;
            broadcast(parsedMessage, ws);
        } else if (parsedMessage.type === 'aiQuery') {
            const userId = parsedMessage.sender;
            const currentCount = aiQueryCounts.get(userId) || 0;

            if (currentCount >= 4) {
                ws.send(JSON.stringify({
                    type: 'chat',
                    sender: 'Gemini AI',
                    senderVanity: 'Gemini AI',
                    content: 'You have reached your query limit (4 queries per session).'
                }));
                return;
            }

            aiQueryCounts.set(userId, currentCount + 1);

            const userQuery = parsedMessage.content;
            async function run() {
                try {
                    const result = await model.generateContent({
                        contents: [{ role: "user", parts: [{ text: userQuery }] }],
                        generationConfig: { maxOutputTokens: 1000 },
                    });
                    const response = await result.response;
                    const text = response.text();
                    broadcast({
                        type: 'chat',
                        sender: parsedMessage.sender,
                        senderVanity: parsedMessage.senderVanity,
                        content: `<b>@ai</b> ${purify.sanitize(userQuery)}`
                    });
                    broadcast({
                        type: 'chat',
                        sender: 'Gemini AI',
                        senderVanity: 'Gemini AI',
                        content: text
                    });
                } catch (error) {
                    console.error('Gemini API Error:', error);
                    ws.send(JSON.stringify({
                        type: 'chat',
                        sender: 'Gemini AI',
                        senderVanity: 'Gemini AI',
                        content: 'Error processing your request. Please try again later.'
                    }));
                }
            }
            run();
        }
    });

    ws.on('close', () => {
        if (currentUserId) {
            // Only delete if this WebSocket is still the one associated with currentUserId
            if (clients.get(ws) === currentUserId) {
                clients.delete(ws);
            }
            // Do NOT delete userVanities[currentUserId] here, as the ID should persist
            usersTyping.delete(currentUserId);
            broadcastUserList();
        }
    });
});

function broadcast(message, senderWs = null) {
    wss.clients.forEach((client) => {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastUserList() {
    const userList = [];
    for (let [ws, id] of clients.entries()) {
        userList.push({ id: id, vanity: userVanities.get(id) });
    }
    broadcast({ type: 'userList', users: userList });
}

const os = require('os');

const interfaces = os.networkInterfaces();
const addresses = [];
for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
        const address = interfaces[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
            addresses.push(address.address);
        }
    }
}

server.listen(3000, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:3000/ and on your network at http://${addresses[0]}:3000/`);
});
