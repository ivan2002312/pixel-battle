const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Хранилище серверов
const servers = new Map();
const publicServers = new Map();

function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

function generateAccessCode() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// HTTP сервер
const server = http.createServer((req, res) => {
    if (req.url === '/servers') {
        const publicList = Array.from(publicServers.values()).map(s => ({
            id: s.info.id,
            name: s.info.name,
            players: s.info.players,
            maxPlayers: s.info.maxPlayers,
            pixels: s.info.pixels,
            createdAt: s.info.createdAt
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(publicList));
    } else if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            totalServers: servers.size,
            publicServers: publicServers.size,
            totalPlayers: Array.from(servers.values()).reduce((acc, s) => acc + s.info.players, 0)
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>🎮 Pixel Battle Master Server</h1><p>WebSocket: wss://' + req.headers.host + '</p>');
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('📡 Новое подключение');
    let currentServerId = null;
    let isServer = false;
    let currentPlayerId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Создание сервера
            if (data.type === 'create_server') {
                const serverId = generateId();
                const accessCode = data.isPrivate ? generateAccessCode() : null;
                
                const serverInfo = {
                    id: serverId,
                    name: data.name || 'Pixel Battle',
                    isPrivate: data.isPrivate || false,
                    accessCode: accessCode,
                    maxPlayers: data.maxPlayers || 50,
                    players: 0,
                    pixels: 0,
                    createdAt: Date.now()
                };
                
                servers.set(serverId, {
                    info: serverInfo,
                    players: new Map(),
                    pixels: new Map()
                });
                
                if (!serverInfo.isPrivate) {
                    publicServers.set(serverId, servers.get(serverId));
                }
                
                isServer = true;
                currentServerId = serverId;
                
                ws.send(JSON.stringify({
                    type: 'server_created',
                    serverId: serverId,
                    accessCode: accessCode,
                    serverInfo: serverInfo
                }));
                
                console.log(`🆕 Сервер: ${serverInfo.name} (${serverId})`);
                broadcastServerList();
            }
            
            // Список серверов
            else if (data.type === 'get_servers') {
                const publicList = Array.from(publicServers.values()).map(s => ({
                    id: s.info.id,
                    name: s.info.name,
                    players: s.info.players,
                    maxPlayers: s.info.maxPlayers,
                    pixels: s.info.pixels
                }));
                ws.send(JSON.stringify({
                    type: 'servers_list',
                    servers: publicList
                }));
            }
            
            // Подключение к серверу
            else if (data.type === 'join_server') {
                const server = servers.get(data.serverId);
                
                if (!server) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Сервер не найден' }));
                    return;
                }
                
                if (server.info.isPrivate && server.info.accessCode !== data.accessCode) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверный код' }));
                    return;
                }
                
                if (server.info.players >= server.info.maxPlayers) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Сервер заполнен' }));
                    return;
                }
                
                currentPlayerId = generateId();
                server.players.set(currentPlayerId, ws);
                server.info.players++;
                currentServerId = data.serverId;
                
                const allPixels = [];
                for (let [key, color] of server.pixels.entries()) {
                    allPixels.push(`${key}:${color}`);
                }
                
                ws.send(JSON.stringify({
                    type: 'joined_server',
                    serverId: data.serverId,
                    playerId: currentPlayerId,
                    serverInfo: server.info,
                    pixels: allPixels
                }));
                
                broadcastToServer(data.serverId, {
                    type: 'player_joined',
                    playerCount: server.info.players
                }, currentPlayerId);
                
                broadcastServerList();
            }
            
            // Размещение пикселя
            else if (data.type === 'place_pixel' && currentServerId) {
                const server = servers.get(currentServerId);
                if (!server) return;
                
                const { x, y, color } = data;
                const key = `${x}:${y}`;
                
                if (color === null) {
                    server.pixels.delete(key);
                } else {
                    server.pixels.set(key, color);
                }
                
                server.info.pixels = server.pixels.size;
                
                broadcastToServer(currentServerId, {
                    type: 'pixel_update',
                    x: x,
                    y: y,
                    color: color
                });
            }
            
            // Покинуть сервер
            else if (data.type === 'leave_server' && currentServerId) {
                leaveServer(currentServerId, currentPlayerId);
                currentServerId = null;
                currentPlayerId = null;
            }
            
        } catch (e) {
            console.error('Ошибка:', e);
        }
    });
    
    ws.on('close', () => {
        if (isServer && currentServerId) {
            const server = servers.get(currentServerId);
            if (server) {
                server.players.forEach((playerWs) => {
                    playerWs.send(JSON.stringify({ type: 'server_closed' }));
                });
                servers.delete(currentServerId);
                publicServers.delete(currentServerId);
                broadcastServerList();
                console.log(`🛑 Сервер удалён: ${currentServerId}`);
            }
        } else if (currentServerId && currentPlayerId) {
            leaveServer(currentServerId, currentPlayerId);
        }
    });
});

function leaveServer(serverId, playerId) {
    const server = servers.get(serverId);
    if (!server) return;
    
    server.players.delete(playerId);
    server.info.players--;
    
    broadcastToServer(serverId, {
        type: 'player_left',
        playerCount: server.info.players
    });
    
    broadcastServerList();
}

function broadcastToServer(serverId, message, excludePlayerId = null) {
    const server = servers.get(serverId);
    if (!server) return;
    
    server.players.forEach((playerWs, playerId) => {
        if (playerId !== excludePlayerId && playerWs.readyState === WebSocket.OPEN) {
            playerWs.send(JSON.stringify(message));
        }
    });
}

function broadcastServerList() {
    const publicList = Array.from(publicServers.values()).map(s => ({
        id: s.info.id,
        name: s.info.name,
        players: s.info.players,
        maxPlayers: s.info.maxPlayers,
        pixels: s.info.pixels
    }));
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'servers_list',
                servers: publicList
            }));
        }
    });
}

server.listen(PORT, () => {
    console.log(`🎮 Мастер-сервер на порту ${PORT}`);
});
