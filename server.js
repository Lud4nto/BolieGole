const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
// 150 tick = 2.5 saniye. pickupCooldown top düştükten sonra kimsenin hemen alamamasını sağlar.
let ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0 };
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
        if (ball.owner === socket.id) {
            ball.vx = data.vx;
            ball.vy = data.vy;
            ball.vz = data.vz;
            ball.owner = null; 
            ball.possessionTimer = 0;
            ball.pickupCooldown = 15; // Şut çekildikten sonra 0.25 sn kimse alamaz
            
            ball.x += data.vx * 1.5; 
            ball.y += data.vy * 1.5;
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
    if (ball.pickupCooldown > 0) ball.pickupCooldown--;

    // 1. Top Sahipliği Mantığı
    if (ball.owner !== null) {
        if (ball.possessionTimer > 0) {
            ball.possessionTimer -= 1; 
        }

        if (!players[ball.owner]) {
            ball.owner = null;
        } else {
            let owner = players[ball.owner];
            let angle = Math.atan2(owner.lastDy, owner.lastDx);
            if (owner.lastDx === 0 && owner.lastDy === 0) angle = 0; 
            
            // Topu oyuncunun önünde tut
            ball.x = owner.x + Math.cos(angle) * 35;
            ball.y = owner.y + Math.sin(angle) * 35;
            ball.vx = 0; 
            ball.vy = 0;
            ball.z = 0;

            // SÜRE BİTTİYSE: Topu bırak!
            if (ball.possessionTimer <= 0) {
                ball.owner = null;
                // Topu baktığı yöne doğru fırlat ki ayağından kopsun
                ball.vx = Math.cos(angle) * 6;
                ball.vy = Math.sin(angle) * 6;
                ball.pickupCooldown = 30; // 0.5 saniye boyunca yerden alınamaz
            }
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

        if (ball.y < 20) { ball.y = 20; ball.vy *= -0.8; }
        if (ball.y > height - 20) { ball.y = height - 20; ball.vy *= -0.8; }
        
        if (ball.x <= 20 && ball.y > 200 && ball.y < 400) {
            score.blue++; resetBall();
        } else if (ball.x >= width - 20 && ball.y > 200 && ball.y < 400) {
            score.red++; resetBall();
        } else {
            if (ball.x < 20) { ball.x = 20; ball.vx *= -0.8; }
            if (ball.x > width - 20) { ball.x = width - 20; ball.vx *= -0.8; }
        }
    }

    // 3. Top Alma / Çalma (Her zaman)
    for (let id in players) {
        let p = players[id];
        let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
        
        // Topa 45 birimden yakınsa VE yerden alma yasağı bittiyse alabilir
        if (dist < 45 && ball.pickupCooldown <= 0) {
            if (ball.owner === null) {
                ball.owner = id;
                ball.possessionTimer = 150; // 2.5 saniye
                ball.vx = 0; ball.vy = 0; ball.vz = 0;
            } else if (ball.owner !== id) {
                ball.owner = id;
                ball.possessionTimer = 150; // 2.5 saniye
                ball.vx = 0; ball.vy = 0; ball.vz = 0;
            }
        }
    }

    io.emit('gameState', players, ball, score);
}, 1000 / 60);

function resetBall() {
    ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0 };
    for (let id in players) {
        players[id].x = 600 + (players[id].team === 'red' ? -150 : 150);
        players[id].y = 300;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log('Critiball Server Çalışıyor'); });
