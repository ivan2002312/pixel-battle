const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Хранилище пикселей
const pixelMap = new Map();
let updateQueue = new Set();
let broadcastInterval = null;

// HTTP сервер для статистики и health-check
const server = http.createServer((req, res) => {
    if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            pixels: pixelMap.size,
            connections: wss.clients.size,
            uptime: process.uptime()
        }));
    } else if (req.url === '/health') {
        res.writeHead(200);
        res.end('OK');
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>🎮 Pixel Battle Server</h1><p>WebSocket server is running.</p>');
    }
});

const wss = new WebSocket.Server({ server });

console.log('🚀 Сервер запускается...');

function startBroadcast() {
    if (broadcastInterval) return;
    broadcastInterval = setInterval(() => {
        if (updateQueue.size > 0) {
            const updates = Array.from(updateQueue);
            const message = JSON.stringify({ type: 'bulk_update', data: updates });
            
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
            
            console.log(`📤 Отправлено ${updates.length} пикселей`);
            updateQueue.clear();
        }
    }, 50);
}

wss.on('connection', (ws) => {
    console.log(`✅ Игрок подключился. Всего: ${wss.clients.size}`);
    startBroadcast();

    const allPixels = [];
    for (let [key, color] of pixelMap.entries()) {
        allPixels.push(`${key}:${color}`);
    }
    
    ws.send(JSON.stringify({ 
        type: 'init', 
        data: allPixels, 
        playerCount: wss.clients.size 
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'place_pixel') {
                const { x, y, color } = data;
                if (x < 0 || x >= 1000000 || y < 0 || y >= 1000000) return;
                
                const key = `${x}:${y}`;
                pixelMap.set(key, color);
                updateQueue.add(`${x}:${y}:${color}`);
            }
        } catch (e) {
            console.error('Ошибка:', e);
        }
    });

    ws.on('close', () => {
        console.log(`👋 Игрок отключился. Осталось: ${wss.clients.size}`);
        if (wss.clients.size === 0) {
            clearInterval(broadcastInterval);
            broadcastInterval = null;
        }
    });
});

server.listen(PORT, () => {
    console.log(`🎮 Сервер на порту ${PORT}`);
});
