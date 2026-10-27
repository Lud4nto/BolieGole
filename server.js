const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
let ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0, shotPower: 0, lastKickX: 0 };
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
            
            // Top havadayken çalınabilsin diye dokunulmazlık süresini kısa tuttuk (0.3 sn)
            ball.pickupCooldown = 20; 
            ball.shotPower = data.shotPower;
            ball.lastKickX = players[socket.id].x; 
            
            ball.x += data.vx * 3; 
            ball.y += data.vy * 3;
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

    if (ball.owner !== null) {
        if (ball.possessionTimer > 0) ball.possessionTimer -= 1; 

        if (!players[ball.owner]) {
            ball.owner = null;
        } else {
            let owner = players[ball.owner];
            let angle = Math.atan2(owner.lastDy, owner.lastDx);
            if (owner.lastDx === 0 && owner.lastDy === 0) angle = 0; 
            
            ball.x = owner.x + Math.cos(angle) * 35;
            ball.y = owner.y + Math.sin(angle) * 35;
            ball.vx = 0; ball.vy = 0; ball.z = 0;

            if (ball.possessionTimer <= 0) {
                ball.owner = null;
                ball.vx = Math.cos(angle) * 7; 
                ball.vy = Math.sin(angle) * 7;
                ball.pickupCooldown = 30; 
            }
        }
    }

    if (ball.owner === null) {
        ball.x += ball.vx;
        ball.y += ball.vy;
        ball.z += ball.vz;
        
        ball.vx *= 0.98; ball.vy *= 0.98;
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
        
        let hitLeftGoal = ball.x <= 25 && ball.y > 200 && ball.y < 400;
        let hitRightGoal = ball.x >= width - 25 && ball.y > 200 && ball.y < 400;

        if (hitLeftGoal || hitRightGoal) {
            let shouldBounce = false;
            if (ball.shotPower === 100) {
                let isOwnHalf = false;
                let isClose = false;
                if (hitRightGoal) {
                    if (ball.lastKickX < 600) isOwnHalf = true;
                    if (ball.lastKickX > 900) isClose = true;
                } else if (hitLeftGoal) {
                    if (ball.lastKickX > 600) isOwnHalf = true;
                    if (ball.lastKickX < 300) isClose = true;
                }
                if (!isOwnHalf && !isClose) shouldBounce = true;
            }

            if (shouldBounce) {
                ball.x = hitRightGoal ? width - 30 : 30;
                ball.vx = -ball.vx * 0.7; 
                ball.vy = (Math.random() - 0.5) * 25; 
                ball.vz = 8; 
                ball.shotPower = 0; 
            } else {
                if (hitRightGoal) score.red++; else score.blue++;
                resetBall();
            }
        } else {
            if (ball.x < 20) { ball.x = 20; ball.vx *= -0.8; }
            if (ball.x > width - 20) { ball.x = width - 20; ball.vx *= -0.8; }
        }
    }

    // --- HAVADAKİ TOPU ÇALMA MANTIĞI ---
    for (let id in players) {
        let p = players[id];
        // 2D düzlemde mesafe 50'den yakınsa (z ekseni fark etmez)
        let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
        
        if (dist < 50 && ball.pickupCooldown <= 0) {
            if (ball.owner === null) {
                ball.owner = id;
                ball.possessionTimer = 150; // 2.5 saniye
                ball.vx = 0; ball.vy = 0; ball.vz = 0;
                ball.shotPower = 0;
            } else if (ball.owner !== id) {
                ball.owner = id;
                ball.possessionTimer = 150;
                ball.vx = 0; ball.vy = 0; ball.vz = 0;
                ball.shotPower = 0;
            }
        }
    }

    io.emit('gameState', players, ball, score);
}, 1000 / 60);

function resetBall() {
    ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0, shotPower: 0, lastKickX: 0 };
    for (let id in players) {
        players[id].x = 600 + (players[id].team === 'red' ? -150 : 150);
        players[id].y = 300;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log('Critiball Server Çalışıyor'); });
