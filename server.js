const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
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
        name: 'Oyuncu' + Math.floor(Math.random() * 100),
        lastDx: 0,
        lastDy: 0
    };

    socket.emit('currentPlayers', players, ball, score);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].lastDx = data.x - players[socket.id].x;
            players[socket.id].lastDy = data.y - players[socket.id].y;
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
        }
    });

    socket.on('kick', (data) => {
        // Sadece şut çekildiğinde (Space) kuvvet uygula
        ball.vx = data.vx;
        ball.vy = data.vy;
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

// TOP FİZİĞİ (Sunucu Taraflı Hesaplama)
setInterval(() => {
    ball.x += ball.vx;
    ball.y += ball.vy;
    
    // Sürtünme (Top yavaşlasın)
    ball.vx *= 0.90; 
    ball.vy *= 0.90;

    // Durma Eşiği
    if (Math.abs(ball.vx) < 0.1) ball.vx = 0;
    if (Math.abs(ball.vy) < 0.1) ball.vy = 0;

    // Duvarlara Çarpma
    if (ball.y < 15) { ball.y = 15; ball.vy *= -0.8; }
    if (ball.y > height - 15) { ball.y = height - 15; ball.vy *= -0.8; }
    
    // Kale Çizgileri ve Gol
    if (ball.x <= 15 && ball.y > 200 && ball.y < 400) {
        score.blue++; resetBall();
    } else if (ball.x >= width - 15 && ball.y > 200 && ball.y < 400) {
        score.red++; resetBall();
    } else {
        if (ball.x < 15) { ball.x = 15; ball.vx *= -0.8; }
        if (ball.x > width - 15) { ball.x = width - 15; ball.vx *= -0.8; }
    }

    // Oyuncu - Top Çarpışması (Dribbling)
    for (let id in players) {
        let p = players[id];
        let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
        
        if (dist < 40) {
            // Top oyuncunun hareket yönüne doğru itilir
            let angle = Math.atan2(p.lastDy, p.lastDx);
            if (p.lastDx === 0 && p.lastDy === 0) angle = Math.random() * Math.PI * 2; // Duruyorsa hafif sek
            
            ball.vx += Math.cos(angle) * 1.5;
            ball.vy += Math.sin(angle) * 1.5;
        }
    }

    io.emit('gameState', players, ball, score);
}, 1000 / 60);

function resetBall() {
    ball.x = 600; ball.y = 300; ball.vx = 0; ball.vy = 0;
    for (let id in players) {
        players[id].x = 600 + (players[id].team === 'red' ? -100 : 100);
        players[id].y = 300;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Critiball sunucusu ' + PORT + ' portunda calisiyor.');
});
