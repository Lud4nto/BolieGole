const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
let ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0 };
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
        ball.vz = data.vz;
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

setInterval(() => {
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

    for (let id in players) {
        let p = players[id];
        let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
        
        if (dist < 45) {
            let angle = Math.atan2(ball.y - p.y, ball.x - p.x);
            ball.x = p.x + Math.cos(angle) * 45;
            ball.y = p.y + Math.sin(angle) * 45;
            ball.vx += Math.cos(angle) * 1.5;
            ball.vy += Math.sin(angle) * 1.5;
        }
    }

    io.emit('gameState', players, ball, score);
}, 1000 / 60);

function resetBall() {
    ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0 };
    for (let id in players) {
        players[id].x = 600 + (players[id].team === 'red' ? -150 : 150);
        players[id].y = 300;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log('Critiball Server Çalışıyor'); });
