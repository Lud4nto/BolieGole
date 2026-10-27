const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
// Top artık sahibini (owner) ve koruma süresini (protectionTimer) tutuyor.
let ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, protectionTimer: 0 };
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
        // Sadece topun sahibi şut çekebilir!
        if (ball.owner === socket.id) {
            ball.vx = data.vx;
            ball.vy = data.vy;
            ball.vz = data.vz;
            ball.owner = null; // Şut çekildi, top serbest kaldı
            ball.protectionTimer = 0;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        if (ball.owner === socket.id) {
            ball.owner = null;
        }
        io.emit('playerDisconnected', socket.id);
    });
});

// OYUN DÖNGÜSÜ (Saniyede 60 kez)
setInterval(() => {
    // 1. Top sahipliği ve koruma süresi güncellemesi
    if (ball.owner !== null) {
        if (ball.protectionTimer > 0) {
            ball.protectionTimer -= 1; // 2 saniye (120 kare) boyunca korumalı
        }

        // Eğer top sahibi oyundan düştüyse topu serbest bırak
        if (!players[ball.owner]) {
            ball.owner = null;
        } else {
            // Topu sahibinin ayağının önüne yerleştir (Dribbling)
            let owner = players[ball.owner];
            // Topun sahibine yapışmasını engellemek için hafif önde tut
            ball.x = owner.x; 
            ball.y = owner.y;
            ball.vx = 0; 
            ball.vy = 0;
            ball.z = 0;
        }
    }

    // 2. Topun hareketi (Eğer boştaysa fizik işler)
    if (ball.owner === null) {
        ball.x += ball.vx;
        ball.y += ball.vy;
        ball.z += ball.vz;
        
        ball.vx *= 0.98;
        ball.vy *= 0.98;
        ball.vz -= 0.8; 

        if (ball.z <= 0) {
            ball.z = 0;
            ball.vz *= -0.6;
            if (Math.abs(ball.vz) < 1) ball.vz = 0; 
        }

        if(Math.abs(ball.vx) < 0.1) ball.vx = 0;
        if(Math.abs(ball.vy) < 0.1) ball.vy = 0;

        // Duvarlar
        if (ball.y < 15) { ball.y = 15; ball.vy *= -0.8; }
        if (ball.y > height - 15) { ball.y = height - 15; ball.vy *= -0.8; }
        
        // Gol Kontrolü
        if (ball.x <= 15 && ball.y > 200 && ball.y < 400) {
            score.blue++; resetBall();
        } else if (ball.x >= width - 15 && ball.y > 200 && ball.y < 400) {
            score.red++; resetBall();
        } else {
            if (ball.x < 15) { ball.x = 15; ball.vx *= -0.8; }
            if (ball.x > width - 15) { ball.x = width - 15; ball.vx *= -0.8; }
        }
    }

    // 3. Oyuncu - Top Etkileşimi (Top Çalma ve Alma)
    for (let id in players) {
        let p = players[id];
        let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
        
        if (dist < 50) {
            // Eğer top boştaysa, bu oyuncu topu alır
            if (ball.owner === null) {
                ball.owner = id;
                ball.protectionTimer = 120; // 2 saniye (60 FPS * 2) koruma başlasın
                ball.vx = 0; ball.vy = 0; ball.vz = 0;
            } 
            // Eğer topun başka bir sahibi varsa, top çalma kontrolü
            else if (ball.owner !== id) {
                // Sadece koruma süresi bittiyse (2 saniye geçtiyse) topu çalabilir
                if (ball.protectionTimer <= 0) {
                    ball.owner = id; // Top el değiştirdi
                    ball.protectionTimer = 120; // Çalan oyuncuya 2 saniye koruma
                    ball.vx = 0; ball.vy = 0; ball.vz = 0;
                }
            }
        }
    }

    io.emit('gameState', players, ball, score);
}, 1000 / 60);

function resetBall() {
    ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, protectionTimer: 0 };
    for (let id in players) {
        players[id].x = 600 + (players[id].team === 'red' ? -150 : 150);
        players[id].y = 300;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log('Critiball Server Çalışıyor'); });
