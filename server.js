const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = {};
let ball = { x: 400, y: 250, vx: 0, vy: 0 };
let score = { red: 0, blue: 0 };

io.on('connection', (socket) => {
    players[socket.id] = {
        id: socket.id,
        x: 400,
        y: 250,
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

setInterval(() => {
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.vx *= 0.95;
    ball.vy *= 0.95;

    if (ball.x < 10 || ball.x > 790) { ball.vx *= -1; ball.x = Math.max(10, Math.min(790, ball.x)); }
    if (ball.y < 10 || ball.y > 490) { ball.vy *= -1; ball.y = Math.max(10, Math.min(490, ball.y)); }

    if (ball.x <= 10 && ball.y > 150 && ball.y < 350) {
        score.blue++;
        resetBall();
    } else if (ball.x >= 790 && ball.y > 150 && ball.y < 350) {
        score.red++;
        resetBall();
    }

    io.emit('gameState', players, ball, score);
}, 1000 / 60);

function resetBall() {
    ball.x = 400; ball.y = 250; ball.vx = 0; ball.vy = 0;
    for (let id in players) {
        players[id].x = 400; players[id].y = 250;
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Critiball sunucusu ' + PORT + ' portunda calisiyor.');
});
