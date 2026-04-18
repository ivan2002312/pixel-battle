const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Хранилище серверов
const servers = new Map();
const publicServers = new Map();
const serversByCode = new Map();

function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

function generateAccessCode() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
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
    
    if (req.url === '/servers') {
        const list = [];
        publicServers.forEach((s) => {
            list.push({
                id: s.info.id,
                name: s.info.name,
                isPrivate: false,
                players: s.info.players,
                maxPlayers: s.info.maxPlayers,
                pixels: s.info.pixels
            });
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
    }
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Pixel Battle Server</h1>');
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
                
                console.log(`🆕 Сервер: ${serverInfo.name} (${serverId})`);
                broadcastServerList();
            }
            
            // Список серверов
            else if (data.type === 'get_servers') {
                const list = [];
                publicServers.forEach((s) => {
                    list.push({
                        id: s.info.id,
                        name: s.info.name,
                        isPrivate: false,
                        players: s.info.players,
                        maxPlayers: s.info.maxPlayers,
                        pixels: s.info.pixels
                    });
                });
                ws.send(JSON.stringify({ type: 'servers_list', servers: list }));
            }
            
            // Подключение к серверу
            else if (data.type === 'join_server') {
                console.log('🔍 Поиск сервера:', data.serverId);
                console.log('Доступные серверы:', Array.from(servers.keys()));
                
                const server = servers.get(data.serverId);
                
                if (!server) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Сервер не найден' }));
                    return;
                }
                
                if (server.info.isPrivate) {
                    if (server.info.accessCode !== data.accessCode) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Неверный код' }));
                        return;
                    }
                }
                
                currentPlayerId = generateId();
                currentPlayerName = data.playerName || 'Гость';
                currentServerId = data.serverId;
                
                server.players.set(currentPlayerId, { ws, name: currentPlayerName });
                server.info.players++;
                
                // Отправляем пиксели
                const pixels = [];
                server.pixels.forEach((value, key) => {
                    const [x, y] = key.split(',');
                    pixels.push({ x: parseInt(x), y: parseInt(y), color: value.color });
                });
                
                // Отправляем список игроков
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
                
                console.log(`👤 ${currentPlayerName} подключился к ${server.info.name}`);
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
                
                // Рассылаем всем игрокам на сервере
                server.players.forEach((p, id) => {
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
            
            // Поиск по коду
            else if (data.type === 'find_server_by_code') {
                const serverId = serversByCode.get(data.code);
                if (serverId && servers.has(serverId)) {
                    const s = servers.get(serverId);
                    ws.send(JSON.stringify({
                        type: 'servers_by_code',
                        code: data.code,
                        servers: [{ 
                            id: s.info.id, 
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
        if (currentServerId) {
            const server = servers.get(currentServerId);
            if (server) {
                // Если это был создатель сервера
                if (server.players.size === 1) {
                    servers.delete(currentServerId);
                    publicServers.delete(currentServerId);
                    console.log(`🛑 Сервер удалён: ${currentServerId}`);
                    broadcastServerList();
                } else {
                    server.players.delete(currentPlayerId);
                    server.info.players--;
                    console.log(`👋 Игрок покинул сервер`);
                }
            }
        }
    });
});

function broadcastServerList() {
    const list = [];
    publicServers.forEach((s) => {
        list.push({
            id: s.info.id,
            name: s.info.name,
            isPrivate: false,
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
    console.log(`🎮 Сервер запущен на порту ${PORT}`);
});
