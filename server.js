const WebSocket = require('ws');
const PORT = 8080;

const wss = new WebSocket.Server({ port: PORT });

// --- ХРАНИЛИЩЕ ПИКСЕЛЕЙ ---
const pixelMap = new Map();
let updateQueue = new Set();
let broadcastInterval = null;

// Очистка при запуске
console.log('🚀 Сервер запускается...');
pixelMap.clear();
updateQueue.clear();

// Функция для корректного подсчёта АКТИВНЫХ соединений
function getActiveClientsCount() {
    let count = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            count++;
        }
    });
    return count;
}

// Логирование количества игроков
function logPlayersCount() {
    const activeCount = getActiveClientsCount();
    console.log(`👥 Активных игроков: ${activeCount} (Всего соединений: ${wss.clients.size})`);
}

// Рассылка обновлений
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
            
            console.log(`📤 Отправлено ${updates.length} пикселей. Всего в памяти: ${pixelMap.size}`);
            updateQueue.clear();
        }
    }, 50);
}

// Пинг для проверки живых соединений
function heartbeat() {
    this.isAlive = true;
}

const pingInterval = setInterval(() => {
    wss.clients.forEach(client => {
        if (client.isAlive === false) {
            console.log('💀 Удаление мёртвого соединения');
            return client.terminate();
        }
        client.isAlive = false;
        client.ping();
    });
}, 30000); // Каждые 30 секунд

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);
    
    const activeCount = getActiveClientsCount();
    console.log(`✅ Игрок подключился. Активных: ${activeCount}`);
    
    startBroadcast();

    // Отправляем текущее состояние карты
    const allPixels = [];
    for (let [key, color] of pixelMap.entries()) {
        allPixels.push(`${key}:${color}`);
    }
    
    ws.send(JSON.stringify({ 
        type: 'init', 
        data: allPixels,
        playerCount: activeCount 
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
            console.error('❌ Ошибка сообщения:', e.message);
        }
    });

    ws.on('close', (code, reason) => {
        const remainingActive = getActiveClientsCount();
        console.log(`👋 Игрок отключился. Код: ${code}. Активных осталось: ${remainingActive}`);
        
        if (remainingActive === 0) {
            clearInterval(broadcastInterval);
            broadcastInterval = null;
            console.log('⏸️ Нет активных игроков, рассылка остановлена');
        }
    });

    ws.on('error', (error) => {
        console.error('⚠️ Ошибка соединения:', error.message);
    });
});

// Корректное завершение работы сервера
process.on('SIGINT', () => {
    console.log('\n🛑 Получен сигнал остановки...');
    
    clearInterval(pingInterval);
    clearInterval(broadcastInterval);
    
    // Закрываем все соединения
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1000, 'Server shutting down');
        }
    });
    
    wss.close(() => {
        console.log('✅ Сервер корректно остановлен');
        process.exit(0);
    });
});

console.log(`🎮 Pixel Battle сервер запущен на порту ${PORT}`);
console.log(`📊 Статистика: http://localhost:${PORT}/stats (если добавить HTTP сервер)`);