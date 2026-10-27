const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
// Top başlangıç pozisyonu ve hızı
let ball = { x: 600, y: 300, vx: 0, vy: 0 };
let score = { red: 0, blue: 0 };

const width = 1200;
const height = 600;

io.on('connection', (socket) => {
    players[socket.id] = {
        id: socket.id,
        x: 600,
        y: 300,
        team: Object.keys(players).length % 2 === 0 ? 'red' : 'blue',
        name: 'Oyuncu' + Math.floor(Math.random() * 100)
    };

    socket.emit('currentPlayers', players, ball, score);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
        }
    });

    socket.on('kick', (data) => {
        ball.vx = data.vx;
        ball.vy = data.vy;
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// TOP FİZİĞİ (Saniyede 60 kez çalışır - 60 FPS)
setInterval(() => {
    // Topun hareketi
    ball.x += ball.vx;
    ball.y += ball.vy;
    
    // Sürtünme (Top daha uzun süre yuvarlansın diye 0.98 yaptık)
    ball.vx *= 0.98; 
    ball.vy *= 0.98;

    // Durma eşiği
    if(Math.abs(ball.vx) < 0.1) ball.vx = 0;
    if(Math.abs(ball.vy) < 0.1) ball.vy = 0;

    // Duvarlara çarpma (Üst ve Alt)
    if (ball.y < 15) { ball.y = 15; ball.vy *= -0.8; }
    if (ball.y > height - 15) { ball.y = height - 15; ball.vy *= -0.8; }

    // Gol Kontrolü (Sol ve Sağ Kale)
    if (ball.x <= 15 && ball.y > 200 && ball.y < 400) {
        score.blue++; // Sol kaleye gol
        resetBall();
    } else if (ball.x >= width - 15 && ball.y > 200 && ball.y < 400) {
        score.red++; // Sağ kaleye gol
        resetBall();
    } else {
        // Kale dışındaki duvarlara çarpma
        if (ball.x < 15) { ball.x = 15; ball.vx *= -0.8; }
        if (ball.x > width - 15) { ball.x = width - 15; ball.vx *= -0.8; }
    }

    // Oyuncu - Top Çarpışması (Dribbling ve Hafif İtme)
    for (let id in players) {
        let p = players[id];
        let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
        
        // Oyuncu topa yaklaştığında
        if (dist < 45) {
            // Topu oyuncunun merkezinden dışarı doğru it
            let angle = Math.atan2(ball.y - p.y, ball.x - p.x);
            
            // Top oyuncunun çok içindeyse dışarı fırlat
            if (dist < 30) {
                ball.x = p.x + Math.cos(angle) * 30;
                ball.y = p.y + Math.sin(angle) * 30;
                ball.vx += Math.cos(angle) * 0.5;
                ball.vy += Math.sin(angle) * 0.5;
            } else {
                // Hafifçe önüne doğru kaydır
                ball.vx += Math.cos(angle) * 0.15;
                ball.vy += Math.sin(angle) * 0.15;
            }
        }
    }

    io.emit('gameState', players, ball, score);
}, 1000 / 60);

function resetBall() {
    ball.x = 600; ball.y = 300; ball.vx = 0; ball.vy = 0;
    // Oyuncuları kendi yarı sahalarına ışınla
    for (let id in players) {
        players[id].x = 600 + (players[id].team === 'red' ? -150 : 150);
        players[id].y = 300;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Critiball sunucusu ' + PORT + ' portunda calisiyor.');
});
