const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
// Top sahipliği ve koruma sayacı
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
        name: 'Oyuncu' + Math.floor(Math.random() * 100),
        lastDx: 0,
        lastDy: 0
    };

    socket.emit('currentPlayers', players, ball, score);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('move', (data) => {
        if (players[socket.id]) {
            // Oyuncunun son hareket yönünü kaydet (Topu öne koymak için)
            players[socket.id].lastDx = data.x - players[socket.id].x;
            players[socket.id].lastDy = data.y - players[socket.id].y;
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
        }
    });

    socket.on('kick', (data) => {
        if (ball.owner === socket.id) {
            ball.vx = data.vx;
            ball.vy = data.vy;
            ball.vz = data.vz;
            ball.owner = null;
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

setInterval(() => {
    // 1. Top Sahipliği ve Koruma Sayacı
    if (ball.owner !== null) {
        if (ball.protectionTimer > 0) {
            ball.protectionTimer -= 1; 
        }

        if (!players[ball.owner]) {
            ball.owner = null;
        } else {
            let owner = players[ball.owner];
            
            // Topu oyuncunun 30 birim önüne koy (Dibinden ayrılması için)
            let angle = Math.atan2(owner.lastDy, owner.lastDx);
            if (owner.lastDx === 0 && owner.lastDy === 0) angle = 0; // Duruyorsa sağa baksın
            
            ball.x = owner.x + Math.cos(angle) * 30;
            ball.y = owner.y + Math.sin(angle) * 30;
            ball.vx = 0; 
            ball.vy = 0;
            ball.z = 0;
        }
    }

    // 2. Top Fiziği (Sahipsizse)
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

        if (ball.y < 15) { ball.y = 15; ball.vy *= -0.8; }
        if (ball.y > height - 15) { ball.y = height - 15; ball.vy *= -0.8; }
        
        if (ball.x <= 15 && ball.y > 200 && ball.y < 400) {
            score.blue++; resetBall();
        } else if (ball.x >= width - 15 && ball.y > 200 && ball.y < 400) {
            score.red++; resetBall();
        } else {
            if (ball.x < 15) { ball.x = 15; ball.vx *= -0.8; }
            if (ball.x > width - 15) { ball.x = width - 15; ball.vx *= -0.8; }
        }
    }

    // 3. Top Alma / Çalma
    for (let id in players) {
        let p = players[id];
        let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
        
        if (dist < 50) {
            if (ball.owner === null) {
                ball.owner = id;
                ball.protectionTimer = 120; // 2 saniye
                ball.vx = 0; ball.vy = 0; ball.vz = 0;
            } else if (ball.owner !== id) {
                if (ball.protectionTimer <= 0) {
                    ball.owner = id;
                    ball.protectionTimer = 120;
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
