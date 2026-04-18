const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const servers = new Map();
const publicServers = new Map();
const serversByCode = new Map();

function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

function generateAccessCode() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
    }
    
    if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            totalServers: servers.size,
            publicServers: publicServers.size,
            totalPlayers: Array.from(servers.values()).reduce((acc, s) => acc + s.info.players, 0)
        }));
        return;
    }
    
    if (req.url === '/servers') {
        const publicList = Array.from(publicServers.values()).map(s => ({
            id: s.info.id,
            name: s.info.name,
            isPrivate: s.info.isPrivate,
            players: s.info.players,
            maxPlayers: s.info.maxPlayers,
            pixels: s.info.pixels
        }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(publicList));
        return;
    }
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Pixel Battle Master Server</h1>');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('📡 Новое подключение');
    let currentServerId = null;
    let currentPlayerId = null;
    let currentPlayerName = 'Гость';
    let isServerOwner = false;

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
                    pixels: 0
                };
                
                servers.set(serverId, {
                    info: serverInfo,
                    players: new Map(),
                    pixels: new Map()
                });
                
                if (!serverInfo.isPrivate) {
                    publicServers.set(serverId, servers.get(serverId));
                } else if (accessCode) {
                    serversByCode.set(accessCode, serverId);
                }
                
                isServerOwner = true;
                currentServerId = serverId;
                
                ws.send(JSON.stringify({
                    type: 'server_created',
                    serverId: serverId,
                    accessCode: accessCode,
                    serverInfo: serverInfo
                }));
                
                console.log(`🆕 Сервер: ${serverInfo.name} ${accessCode ? '🔒 ' + accessCode : '🌍'}`);
                broadcastServerList();
            }
            
            // Список серверов
            else if (data.type === 'get_servers') {
                const publicList = Array.from(publicServers.values()).map(s => ({
                    id: s.info.id,
                    name: s.info.name,
                    isPrivate: s.info.isPrivate,
                    players: s.info.players,
                    maxPlayers: s.info.maxPlayers,
                    pixels: s.info.pixels
                }));
                ws.send(JSON.stringify({ type: 'servers_list', servers: publicList }));
            }
            
            // Поиск по коду
            else if (data.type === 'find_server_by_code') {
                const serverId = serversByCode.get(data.code);
                if (serverId && servers.has(serverId)) {
                    const s = servers.get(serverId);
                    ws.send(JSON.stringify({
                        type: 'servers_by_code',
                        code: data.code,
                        servers: [{ id: s.info.id, name: s.info.name, isPrivate: true, players: s.info.players, maxPlayers: s.info.maxPlayers }]
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'servers_by_code', code: data.code, servers: [] }));
                }
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
                currentPlayerName = data.playerName || 'Гость';
                currentServerId = data.serverId;
                
                server.players.set(currentPlayerId, { ws, name: currentPlayerName });
                server.info.players++;
                
                const allPixels = [];
                for (let [key, value] of server.pixels.entries()) {
                    allPixels.push({ x: value.x, y: value.y, color: value.color, author: value.author });
                }
                
                const playerList = [];
                server.players.forEach((p, id) => playerList.push({ id, name: p.name }));
                
                ws.send(JSON.stringify({
                    type: 'joined_server',
                    serverId: data.serverId,
                    playerId: currentPlayerId,
                    serverInfo: server.info,
                    pixels: allPixels,
                    players: playerList
                }));
                
                broadcastToServer(data.serverId, {
                    type: 'player_joined',
                    playerId: currentPlayerId,
                    playerName: currentPlayerName,
                    playerCount: server.info.players,
                    players: playerList
                }, currentPlayerId);
                
                broadcastServerList();
                console.log(`👤 ${currentPlayerName} подключился к ${server.info.name}`);
            }
            
            // Установка пикселя
            else if (data.type === 'place_pixel' && currentServerId) {
                const server = servers.get(currentServerId);
                if (!server) return;
                
                const { x, y, color } = data;
                const key = `${x}:${y}`;
                
                if (color === null) {
                    server.pixels.delete(key);
                } else {
                    server.pixels.set(key, {
                        x: parseInt(x),
                        y: parseInt(y),
                        color: color,
                        author: currentPlayerName
                    });
                }
                
                server.info.pixels = server.pixels.size;
                
                broadcastToServer(currentServerId, {
                    type: 'pixel_update',
                    x: parseInt(x),
                    y: parseInt(y),
                    color: color,
                    author: currentPlayerName
                });
            }
            
            // Смена ника
            else if (data.type === 'change_name' && currentServerId && currentPlayerId) {
                const server = servers.get(currentServerId);
                if (!server) return;
                
                const oldName = currentPlayerName;
                currentPlayerName = data.name || 'Гость';
                
                const playerData = server.players.get(currentPlayerId);
                if (playerData) playerData.name = currentPlayerName;
                
                const playerList = [];
                server.players.forEach((p, id) => playerList.push({ id, name: p.name }));
                
                broadcastToServer(currentServerId, {
                    type: 'player_name_changed',
                    playerId: currentPlayerId,
                    oldName: oldName,
                    newName: currentPlayerName,
                    players: playerList
                });
            }
            
        } catch (e) {
            console.error('Ошибка:', e.message);
        }
    });
    
    ws.on('close', () => {
        if (isServerOwner && currentServerId) {
            const server = servers.get(currentServerId);
            if (server) {
                if (server.info.accessCode) serversByCode.delete(server.info.accessCode);
                servers.delete(currentServerId);
                publicServers.delete(currentServerId);
                broadcastServerList();
                console.log(`🛑 Сервер удалён: ${currentServerId}`);
            }
        } else if (currentServerId && currentPlayerId) {
            const server = servers.get(currentServerId);
            if (server) {
                server.players.delete(currentPlayerId);
                server.info.players--;
                
                const playerList = [];
                server.players.forEach((p, id) => playerList.push({ id, name: p.name }));
                
                broadcastToServer(currentServerId, {
                    type: 'player_left',
                    playerId: currentPlayerId,
                    playerName: currentPlayerName,
                    playerCount: server.info.players,
                    players: playerList
                });
                
                broadcastServerList();
                console.log(`👋 ${currentPlayerName} покинул сервер`);
            }
        }
    });
});

function broadcastToServer(serverId, message, excludeId = null) {
    const server = servers.get(serverId);
    if (!server) return;
    
    server.players.forEach((p, id) => {
        if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify(message));
        }
    });
}

function broadcastServerList() {
    const publicList = Array.from(publicServers.values()).map(s => ({
        id: s.info.id,
        name: s.info.name,
        isPrivate: s.info.isPrivate,
        players: s.info.players,
        maxPlayers: s.info.maxPlayers,
        pixels: s.info.pixels
    }));
    
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'servers_list', servers: publicList }));
        }
    });
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Мастер-сервер на порту ${PORT}`);
});
