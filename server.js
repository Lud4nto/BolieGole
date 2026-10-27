const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let servers = {};
const width = 1200;
const height = 600;

// --- YENİ SABİTLER (güvenlik/fizik) ---
const BALL_MAX_SPEED = 35;   // tick başına max birim (hızlı şut tünelleme fix)
const BALL_MAX_Z_SPEED = 15;
const GOAL_TOP_Z = 80;       // üst direk eşiği
const PLAYER_MIN_X = 25, PLAYER_MAX_X = width - 25;
const PLAYER_MIN_Y = 25, PLAYER_MAX_Y = height - 25;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (servers[result]) return generateRoomCode();
    return result;
}

process.on('uncaughtException', (err) => { console.error('Hata:', err.message); });

io.on('connection', (socket) => {
    socket.on('get_servers', () => {
        let list = [];
        for (let id in servers) {
            let s = servers[id];
            if (s && s.status === "lobby") {
                list.push({
                    id: s.id,
                    name: s.name,
                    type: s.type,
                    playerCount: s.players.length,
                    hasPassword: s.password !== ""   // 🔧 FIX: şifreli oda tespiti
                });
            }
        }
        socket.emit('server_list', list);
    });

    socket.on('create_server', (data) => {
        if (!data) return;
        const code = generateRoomCode();
        const hostPlayer = { id: socket.id, name: (data.playerName || "Kurucu").substring(0, 20), team: "spectator", lastDx: 0, lastDy: 0, x: 600, y: 300 };

        servers[code] = {
            id: code, name: (data.name || "Oda").substring(0, 30), type: data.type || "private", password: data.password || "",
            hostId: socket.id, players: [hostPlayer], status: "lobby",
            ball: { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0, shotPower: 0, lastKickX: 0 },
            score: { red: 0, blue: 0 }, matchTime: 0, half: 1, isKickoff: false, concedingTeam: null,
            gameInterval: null, emptyTimer: null, breakTimer: 0, replayTimer: 0
        };

        socket.join(code);
        socket.roomId = code;
        socket.emit('server_created', servers[code]);
        io.to(code).emit('update_lobby', servers[code]);
    });

    socket.on('join_server', (data) => {
        if (!data) return;
        let s = servers[data.id];
        if (!s) { socket.emit('join_error', 'Oda bulunamadı.'); return; }
        if (s.type === 'private' && data.password !== s.id) { socket.emit('join_error', 'Hatalı Oda Kodu!'); return; }
        if (s.type === 'community' && s.password !== "" && data.password !== s.password) { socket.emit('join_error', 'Hatalı Şifre!'); return; }

        if (s.players.length >= 10) { socket.emit('join_error', 'Oda dolu (maks. 10 kişi).'); return; }

        if (s.emptyTimer) clearTimeout(s.emptyTimer);
        let newPlayer = { id: socket.id, name: (data.playerName || "Oyuncu").substring(0, 20), team: "spectator", lastDx: 0, lastDy: 0, x: 600, y: 300 };
        s.players.push(newPlayer);
        socket.join(data.id);
        socket.roomId = data.id;
        socket.emit('joined_successfully', s);
        io.to(data.id).emit('update_lobby', s);
    });

    socket.on('change_team', (team) => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.status !== "lobby") return;
        let p = s.players.find(pl => pl.id === socket.id);
        if (p) {
            let target = team || "spectator";
            if (target !== 'spectator') {
                let count = s.players.filter(pl => pl.team === target).length;
                if (count >= 5) { socket.emit('start_error', 'Bu takım dolu (maks. 5).'); return; }
            }
            p.team = target;
            io.to(s.id).emit('update_lobby', s);
        }
    });

    socket.on('start_game', () => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.hostId !== socket.id || s.status !== "lobby") return;

        let redCount = s.players.filter(p => p.team === 'red').length;
        let blueCount = s.players.filter(p => p.team === 'blue').length;
        if (redCount === 0 || blueCount === 0 || redCount !== blueCount) {
            socket.emit('start_error', 'Takımlar eşit sayıda olmalıdır!'); return;
        }

        s.status = "playing";
        s.score = { red: 0, blue: 0 };
        s.matchTime = 0; s.half = 1;
        resetBall(s, null, false);

        io.to(s.id).emit('game_started');
        io.to(s.id).emit('play_whistle');
        if (s.gameInterval) clearInterval(s.gameInterval);
        s.gameInterval = setInterval(() => { updateGame(s); }, 1000 / 60);
    });

    socket.on('stop_game', () => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.hostId !== socket.id) return;
        if (s.gameInterval) { clearInterval(s.gameInterval); s.gameInterval = null; }
        s.status = "lobby"; s.score = { red: 0, blue: 0 }; resetBall(s, null, false);
        io.to(s.id).emit('game_ended', s);
    });

    socket.on('move', (data) => {
        if (!data || !socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.status !== "playing") return;

        let p = s.players.find(pl => pl.id === socket.id);
        if (!p || p.team === 'spectator') return;

        // 🔧 FIX: NaN / undefined / sonsuz sayı engeli
        if (!isFiniteNum(data.x) || !isFiniteNum(data.y)) return;

        // 🔧 FIX: sunucu tarafı clamp (hile engeli)
        let nx = clamp(data.x, PLAYER_MIN_X, PLAYER_MAX_X);
        let ny = clamp(data.y, PLAYER_MIN_Y, PLAYER_MAX_Y);

        if (s.isKickoff && p.team !== s.concedingTeam) {
            if (s.concedingTeam === 'blue' && nx > 595) nx = 595;
            if (s.concedingTeam === 'red' && nx < 605) nx = 605;
        }

        p.lastDx = nx - p.x;
        p.lastDy = ny - p.y;
        p.x = nx;
        p.y = ny;
    });

    socket.on('tackle', () => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.status !== "playing") return;
        let p = s.players.find(pl => pl.id === socket.id);
        if (!p || p.team === 'spectator') return;

        if (s.ball.owner && s.ball.owner !== socket.id) {
            if (s.isKickoff && p.team !== s.concedingTeam) return;

            let owner = s.players.find(pl => pl.id === s.ball.owner);
            if (owner && Math.hypot(p.x - owner.x, p.y - owner.y) < 60) {
                s.ball.owner = socket.id;
                s.ball.possessionTimer = 150;
                if (s.isKickoff) { s.isKickoff = false; s.concedingTeam = null; }
            }
        }
    });

    socket.on('kick', (data) => {
        if (!data || !socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.status !== "playing") return;

        if (s.ball && s.ball.owner === socket.id) {
            // 🔧 FIX: input validation + clamp
            let vx = isFiniteNum(data.vx) ? data.vx : 0;
            let vy = isFiniteNum(data.vy) ? data.vy : 0;
            let vz = isFiniteNum(data.vz) ? data.vz : 0;
            let sp = isFiniteNum(data.shotPower) ? data.shotPower : 0;
            sp = clamp(sp, 0, 100);

            let speed = Math.hypot(vx, vy);
            if (speed > BALL_MAX_SPEED) {
                vx = (vx / speed) * BALL_MAX_SPEED;
                vy = (vy / speed) * BALL_MAX_SPEED;
            }
            vz = clamp(vz, -BALL_MAX_Z_SPEED, BALL_MAX_Z_SPEED);

            s.ball.vx = vx; s.ball.vy = vy; s.ball.vz = vz;
            s.ball.owner = null; s.ball.possessionTimer = 0; s.ball.pickupCooldown = 20; s.ball.shotPower = sp;

            let p = s.players.find(pl => pl.id === socket.id);
            s.ball.lastKickX = p ? p.x : 0;
            s.ball.x += s.ball.vx * 3;
            s.ball.y += s.ball.vy * 3;

            if (s.isKickoff && p && p.team === s.concedingTeam) { s.isKickoff = false; s.concedingTeam = null; }
        }
    });

    socket.on('disconnect', () => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (s) {
            // 🔧 FIX: top sahibi ayrıldıysa topu serbest bırak
            if (s.ball && s.ball.owner === socket.id) {
                s.ball.owner = null;
                s.ball.possessionTimer = 0;
            }
            s.players = s.players.filter(p => p.id !== socket.id);
            io.to(s.id).emit('update_lobby', s);
            if (s.players.length === 0) {
                s.emptyTimer = setTimeout(() => {
                    if (servers[s.id] && servers[s.id].players.length === 0) {
                        if (servers[s.id].gameInterval) clearInterval(servers[s.id].gameInterval);
                        delete servers[s.id];
                    }
                }, 5 * 60 * 1000);
            }
        }
    });
});

function updateGame(s) {
    try {
        if (s.status === 'halftime_break') {
            s.breakTimer -= 1/60;
            if (s.breakTimer <= 0) {
                s.status = 'playing';
                s.half = 2;
                s.matchTime = 0;
                resetBall(s, null, true);
                io.to(s.id).emit('play_whistle');
                io.to(s.id).emit('game_state', s);
            }
            return;
        }

        if (s.status === 'goal_replay') {
            s.replayTimer -= 1/60;
            if (s.replayTimer <= 0) {
                s.status = 'playing';
                io.to(s.id).emit('play_whistle');
                io.to(s.id).emit('game_state', s);
            }
            return;
        }

        if (s.status !== 'playing') return;

        s.matchTime += 1/60;
        if (s.half === 1 && s.matchTime >= 300) {
            s.status = 'halftime_break';
            s.breakTimer = 15;
            s.matchTime = 300;
            io.to(s.id).emit('game_state', s);
            return;
        } else if (s.half === 2 && s.matchTime >= 300) {
            s.status = 'game_ended';
            if (s.gameInterval) clearInterval(s.gameInterval);
            s.gameInterval = null;
            io.to(s.id).emit('game_ended', s);
            return;
        }

        let ball = s.ball;
        if (ball.pickupCooldown > 0) ball.pickupCooldown--;

        if (ball.owner !== null) {
            if (ball.possessionTimer > 0) ball.possessionTimer--;
            let owner = s.players.find(p => p.id === ball.owner);
            if (!owner) {
                ball.owner = null;
            } else {
                let angle = Math.atan2(owner.lastDy, owner.lastDx);
                if (owner.lastDx === 0 && owner.lastDy === 0) angle = 0;
                ball.x = owner.x + Math.cos(angle) * 35;
                ball.y = owner.y + Math.sin(angle) * 35;
                ball.vx = 0; ball.vy = 0; ball.z = 0;

                if (ball.possessionTimer <= 0) {
                    ball.owner = null; ball.vx = Math.cos(angle) * 7; ball.vy = Math.sin(angle) * 7; ball.pickupCooldown = 30;
                }
            }
        }

        if (ball.owner === null) {
            ball.x += ball.vx; ball.y += ball.vy; ball.z += ball.vz;
            ball.vx *= 0.98; ball.vy *= 0.98; ball.vz -= 0.8;

            if (ball.z <= 0) { ball.z = 0; ball.vz *= -0.6; if (Math.abs(ball.vz) < 1) ball.vz = 0; }
            if (Math.abs(ball.vx) < 0.1) ball.vx = 0;
            if (Math.abs(ball.vy) < 0.1) ball.vy = 0;

            if (ball.y < 20) { ball.y = 20; ball.vy *= -0.8; }
            if (ball.y > height - 20) { ball.y = height - 20; ball.vy *= -0.8; }

            let hitLeftGoal = ball.x <= 25 && ball.y > 200 && ball.y < 400;
            let hitRightGoal = ball.x >= width - 25 && ball.y > 200 && ball.y < 400;

            if (hitLeftGoal || hitRightGoal) {
                // 🔧 YENİ: ÜST DİREKTEN SEKME
                if (ball.z > GOAL_TOP_Z) {
                    ball.x = hitRightGoal ? width - 30 : 30;
                    ball.vx = -ball.vx * 0.7;
                    ball.vy = (Math.random() - 0.5) * 15;
                    ball.vz = -Math.abs(ball.vz) * 0.5 - 3;
                    ball.shotPower = 0;
                } else {
                    let shouldBounce = false;
                    if (ball.shotPower === 100) {
                        let isOwnHalf = false, isClose = false;
                        if (hitRightGoal) { if (ball.lastKickX < 600) isOwnHalf = true; if (ball.lastKickX > 900) isClose = true; }
                        else if (hitLeftGoal) { if (ball.lastKickX > 600) isOwnHalf = true; if (ball.lastKickX < 300) isClose = true; }
                        if (!isOwnHalf && !isClose) shouldBounce = true;
                    }

                    if (shouldBounce) {
                        ball.x = hitRightGoal ? width - 30 : 30; ball.vx = -ball.vx * 0.7; ball.vy = (Math.random() - 0.5) * 25; ball.vz = 8; ball.shotPower = 0;
                    } else {
                        if (hitRightGoal) { s.score.red++; s.concedingTeam = 'blue'; }
                        else { s.score.blue++; s.concedingTeam = 'red'; }

                        s.status = 'goal_replay';
                        s.replayTimer = 10;
                        s.isKickoff = true;

                        for (let p of s.players) {
                            if (p.team === 'spectator') continue;
                            if (p.team === s.concedingTeam) { p.x = s.concedingTeam === 'red' ? 500 : 700; p.y = 300; }
                            else { p.x = p.team === 'red' ? 200 : 1000; p.y = 300; }
                        }
                        s.ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0, shotPower: 0, lastKickX: 0 };

                        io.to(s.id).emit('force_positions', s.players);
                        io.to(s.id).emit('goal_scored', s);
                        io.to(s.id).emit('game_state', s);
                        return;
                    }
                }
            } else {
                if (ball.x < 20) { ball.x = 20; ball.vx *= -0.8; }
                if (ball.x > width - 20) { ball.x = width - 20; ball.vx *= -0.8; }
            }
        }

        for (let p of s.players) {
            if (p.team === 'spectator') continue;
            let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
            if (dist < 50 && ball.pickupCooldown <= 0 && ball.owner === null) {
                if (s.isKickoff && p.team !== s.concedingTeam) continue;

                ball.owner = p.id; ball.possessionTimer = 150; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.shotPower = 0;
                if (s.isKickoff) { s.isKickoff = false; s.concedingTeam = null; }
            }
        }

        io.to(s.id).emit('game_state', s);
    } catch (e) { console.log("Hata:", e.message); }
}

function resetBall(s, concededBy = null, isHalftime = false) {
    s.ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0, shotPower: 0, lastKickX: 0 };
    if (concededBy) {
        s.isKickoff = true; s.concedingTeam = concededBy;
        for (let p of s.players) {
            if (p.team === 'spectator') continue;
            if (p.team === concededBy) { p.x = concededBy === 'red' ? 500 : 700; p.y = 300; }
            else { p.x = p.team === 'red' ? 200 : 1000; p.y = 300; }
        }
    } else {
        s.isKickoff = false; s.concedingTeam = null;
        if (isHalftime) {
            for (let p of s.players) {
                if (p.team === 'red') { p.x = 750; p.y = 300; }
                if (p.team === 'blue') { p.x = 450; p.y = 300; }
            }
        } else {
            for (let p of s.players) {
                if (p.team === 'red') { p.x = 450; p.y = 300; }
                if (p.team === 'blue') { p.x = 750; p.y = 300; }
            }
        }
    }
    io.to(s.id).emit('force_positions', s.players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log('Sunucu Çalışıyor'); });
