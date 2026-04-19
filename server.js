const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Хранилище серверов
const servers = new Map();
const publicServers = new Map();
const serversByCode = new Map();

function generateId() {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

function generateAccessCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// HTTP сервер
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
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
        const list = [];
        publicServers.forEach((s, id) => {
            list.push({
                id: id,
                name: s.info.name,
                isPrivate: s.info.isPrivate || false,
                players: s.info.players,
                maxPlayers: s.info.maxPlayers,
                pixels: s.info.pixels
            });
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        console.log('📤 /servers вернул', list.length, 'серверов');
        return;
    }
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Pixel Battle Master Server</h1><p>WebSocket: wss://' + req.headers.host + '</p>');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('📡 Новое подключение');
    let currentServerId = null;
    let currentPlayerId = null;
    let currentPlayerName = 'Гость';

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨', data.type);
            
            // Создание сервера
            if (data.type === 'create_server') {
                const serverId = generateId();
                const accessCode = data.isPrivate ? generateAccessCode() : null;
                
                const serverInfo = {
                    id: serverId,
                    name: data.name || 'Pixel Battle',
                    isPrivate: data.isPrivate || false,
                    accessCode: accessCode,
                    maxPlayers: data.maxPlayers || 20,
                    players: 0,
                    pixels: 0
                };
                
                const newServer = {
                    info: serverInfo,
                    players: new Map(),
                    pixels: new Map()
                };
                
                servers.set(serverId, newServer);
                
                if (!serverInfo.isPrivate) {
                    publicServers.set(serverId, newServer);
                }
                if (accessCode) {
                    serversByCode.set(accessCode, serverId);
                }
                
                currentServerId = serverId;
                
                ws.send(JSON.stringify({
                    type: 'server_created',
                    serverId: serverId,
                    accessCode: accessCode,
                    serverInfo: serverInfo
                }));
                
                broadcastServerList();
                console.log('✅ Сервер создан:', serverInfo.name);
            }
            
            // Список серверов
            else if (data.type === 'get_servers') {
                const list = [];
                publicServers.forEach((s, id) => {
                    list.push({
                        id: id,
                        name: s.info.name,
                        isPrivate: s.info.isPrivate,
                        players: s.info.players,
                        maxPlayers: s.info.maxPlayers,
                        pixels: s.info.pixels
                    });
                });
                ws.send(JSON.stringify({ type: 'servers_list', servers: list }));
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
                
                currentPlayerId = generateId();
                currentPlayerName = data.playerName || 'Гость';
                currentServerId = data.serverId;
                
                server.players.set(currentPlayerId, { ws, name: currentPlayerName });
                server.info.players = server.players.size;
                
                const pixels = [];
                server.pixels.forEach((value, key) => {
                    const [x, y] = key.split(',');
                    pixels.push({ x: parseInt(x), y: parseInt(y), color: value.color });
                });
                
                const playerList = [];
                server.players.forEach((p, id) => playerList.push({ id, name: p.name }));
                
                ws.send(JSON.stringify({
                    type: 'joined_server',
                    serverId: data.serverId,
                    playerId: currentPlayerId,
                    serverInfo: server.info,
                    pixels: pixels,
                    players: playerList
                }));
                
                server.players.forEach((p, id) => {
                    if (id !== currentPlayerId && p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({
                            type: 'player_joined',
                            playerId: currentPlayerId,
                            playerName: currentPlayerName,
                            playerCount: server.info.players,
                            players: playerList
                        }));
                    }
                });
                
                broadcastServerList();
            }
            
            // Выход из сервера
            else if (data.type === 'leave_server') {
                if (currentServerId && currentPlayerId) {
                    const server = servers.get(currentServerId);
                    if (server) {
                        server.players.delete(currentPlayerId);
                        server.info.players = server.players.size;
                        
                        const playerList = [];
                        server.players.forEach((p, id) => playerList.push({ id, name: p.name }));
                        
                        server.players.forEach((p) => {
                            if (p.ws.readyState === WebSocket.OPEN) {
                                p.ws.send(JSON.stringify({
                                    type: 'player_left',
                                    playerId: currentPlayerId,
                                    playerName: currentPlayerName,
                                    playerCount: server.info.players,
                                    players: playerList
                                }));
                            }
                        });
                        
                        if (server.players.size === 0) {
                            if (server.info.accessCode) serversByCode.delete(server.info.accessCode);
                            servers.delete(currentServerId);
                            publicServers.delete(currentServerId);
                        }
                        broadcastServerList();
                    }
                }
                currentServerId = null;
                currentPlayerId = null;
            }
            
            // Установка пикселя
            else if (data.type === 'place_pixel' && currentServerId) {
                const server = servers.get(currentServerId);
                if (!server) return;
                
                const x = parseInt(data.x);
                const y = parseInt(data.y);
                const key = `${x},${y}`;
                
                if (data.color === null) {
                    server.pixels.delete(key);
                } else {
                    server.pixels.set(key, { color: data.color, author: currentPlayerName });
                }
                
                server.info.pixels = server.pixels.size;
                
                server.players.forEach((p) => {
                    if (p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({
                            type: 'pixel_update',
                            x: x,
                            y: y,
                            color: data.color,
                            author: currentPlayerName
                        }));
                    }
                });
            }
            
            // Смена ника
            else if (data.type === 'change_name' && currentServerId) {
                const server = servers.get(currentServerId);
                if (!server) return;
                
                const oldName = currentPlayerName;
                currentPlayerName = data.name || 'Гость';
                
                const playerData = server.players.get(currentPlayerId);
                if (playerData) playerData.name = currentPlayerName;
                
                const playerList = [];
                server.players.forEach((p, id) => playerList.push({ id, name: p.name }));
                
                server.players.forEach((p) => {
                    if (p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({
                            type: 'player_name_changed',
                            playerId: currentPlayerId,
                            oldName: oldName,
                            newName: currentPlayerName,
                            players: playerList
                        }));
                    }
                });
            }
            
            // Поиск по коду
            else if (data.type === 'find_server_by_code') {
                const serverId = serversByCode.get(data.code);
                if (serverId && servers.has(serverId)) {
                    const s = servers.get(serverId);
                    ws.send(JSON.stringify({
                        type: 'servers_by_code',
                        code: data.code,
                        servers: [{ 
                            id: serverId, 
                            name: s.info.name, 
                            players: s.info.players, 
                            maxPlayers: s.info.maxPlayers 
                        }]
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'servers_by_code', code: data.code, servers: [] }));
                }
            }
            
        } catch (e) {
            console.error('Ошибка:', e.message);
        }
    });
    
    ws.on('close', () => {
        if (currentServerId && currentPlayerId) {
            const server = servers.get(currentServerId);
            if (server) {
                server.players.delete(currentPlayerId);
                server.info.players = server.players.size;
                
                const playerList = [];
                server.players.forEach((p, id) => playerList.push({ id, name: p.name }));
                
                server.players.forEach((p) => {
                    if (p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({
                            type: 'player_left',
                            playerId: currentPlayerId,
                            playerName: currentPlayerName,
                            playerCount: server.info.players,
                            players: playerList
                        }));
                    }
                });
                
                if (server.players.size === 0) {
                    if (server.info.accessCode) serversByCode.delete(server.info.accessCode);
                    servers.delete(currentServerId);
                    publicServers.delete(currentServerId);
                    broadcastServerList();
                }
            }
        }
    });
});

function broadcastServerList() {
    const list = [];
    publicServers.forEach((s, id) => {
        list.push({
            id: id,
            name: s.info.name,
            isPrivate: s.info.isPrivate,
            players: s.info.players,
            maxPlayers: s.info.maxPlayers,
            pixels: s.info.pixels
        });
    });
    
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'servers_list', servers: list }));
        }
    });
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('🎮 Сервер запущен на порту', PORT);
});
