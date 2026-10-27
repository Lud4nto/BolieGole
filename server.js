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

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (servers[result]) return generateRoomCode();
    return result;
}

process.on('uncaughtException', (err) => {
    console.error('Hata (Çökme engellendi):', err.message);
});

io.on('connection', (socket) => {
    socket.on('get_servers', () => {
        let list = [];
        for (let id in servers) {
            let s = servers[id];
            if (s && s.status === "lobby") {
                list.push({ id: s.id, name: s.name, type: s.type, playerCount: s.players.length });
            }
        }
        socket.emit('server_list', list);
    });

    socket.on('create_server', (data) => {
        if (!data) return;
        const code = generateRoomCode();
        const hostPlayer = {
            id: socket.id,
            name: data.playerName || "Kurucu",
            team: "spectator",
            lastDx: 0, lastDy: 0,
            x: 600, y: 300
        };

        servers[code] = {
            id: code,
            name: data.name || "Oda",
            type: data.type || "private", 
            password: data.password || "",
            hostId: socket.id,
            players: [hostPlayer], 
            status: "lobby",
            ball: { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0 },
            score: { red: 0, blue: 0 },
            isKickoff: false,
            concedingTeam: null, // Gol yiyen takım
            gameInterval: null,
            emptyTimer: null
        };

        socket.join(code); 
        socket.roomId = code; 

        socket.emit('server_created', servers[code]);
        io.to(code).emit('update_lobby', servers[code]); 
    });

    socket.on('join_server', (data) => {
        if (!data) return;
        let s = servers[data.id];
        if (!s) {
            socket.emit('join_error', 'Oda bulunamadı.');
            return;
        }

        if (s.type === 'private' && data.password !== s.id) {
            socket.emit('join_error', 'Hatalı Oda Kodu!');
            return;
        } else if (s.type === 'community' && s.password !== "" && data.password !== s.password) {
            socket.emit('join_error', 'Hatalı Şifre!');
            return;
        }
        
        if (s.emptyTimer) clearTimeout(s.emptyTimer);

        let newPlayer = {
            id: socket.id,
            name: data.playerName || "Oyuncu",
            team: "spectator",
            lastDx: 0, lastDy: 0,
            x: 600, y: 300
        };
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
            p.team = team || "spectator";
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
            socket.emit('start_error', 'Takımlar eşit sayıda olmalıdır!');
            return;
        }

        s.status = "playing";
        s.score = { red: 0, blue: 0 };
        s.isKickoff = false;
        resetBall(s, null); 

        io.to(s.id).emit('game_started');
        s.gameInterval = setInterval(() => { updateGame(s); }, 1000 / 60);
    });

    socket.on('stop_game', () => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.hostId !== socket.id) return;

        if (s.gameInterval) { clearInterval(s.gameInterval); s.gameInterval = null; }
        s.status = "lobby";
        s.score = { red: 0, blue: 0 };
        resetBall(s, null);
        io.to(s.id).emit('game_ended', s);
    });

    socket.on('move', (data) => {
        if (!data || !socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.status !== "playing") return;
        
        let p = s.players.find(pl => pl.id === socket.id);
        if (p && p.team !== 'spectator') {
            // Bariyer Kontrolü
            if (s.isKickoff) {
                if (p.team !== s.concedingTeam) {
                    // Gol atan takım orta sahayı geçemez
                    if (s.concedingTeam === 'blue' && p.x > 600) p.x = 600;
                    if (s.concedingTeam === 'red' && p.x < 600) p.x = 600;
                }
            }

            p.lastDx = data.x - p.x;
            p.lastDy = data.y - p.y;
            p.x = data.x;
            p.y = data.y;
        }
    });

    socket.on('tackle', () => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.status !== "playing") return;
        
        let p = s.players.find(pl => pl.id === socket.id);
        if (!p || p.team === 'spectator') return;

        if (s.ball.owner && s.ball.owner !== socket.id) {
            let owner = s.players.find(pl => pl.id === s.ball.owner);
            if (owner) {
                let dist = Math.hypot(p.x - owner.x, p.y - owner.y);
                if (dist < 60) {
                    s.ball.owner = socket.id;
                    s.ball.possessionTimer = 150; 
                    checkKickoff(s); // Top çalındığında santra bitti mi kontrol et
                }
            }
        }
    });

    socket.on('kick', (data) => {
        if (!data || !socket.roomId) return;
        let s = servers[socket.roomId];
        if (!s || s.status !== "playing") return;
        
        if (s.ball && s.ball.owner === socket.id) {
            s.ball.vx = data.vx || 0;
            s.ball.vy = data.vy || 0;
            s.ball.vz = data.vz || 0;
            s.ball.owner = null;
            s.ball.possessionTimer = 0;
            s.ball.pickupCooldown = 20;
            s.ball.shotPower = data.shotPower || 0;
            
            let p = s.players.find(pl => pl.id === socket.id);
            s.ball.lastKickX = p ? p.x : 0;
            s.ball.x += s.ball.vx * 3; 
            s.ball.y += s.ball.vy * 3;
            
            checkKickoff(s); // Vurulduğunda santra bitti mi kontrol et
        }
    });

    socket.on('disconnect', () => {
        if (!socket.roomId) return;
        let s = servers[socket.roomId];
        if (s) {
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

function checkKickoff(s) {
    if (!s.isKickoff) return;
    // Eğer topa dokunan kişi gol yiyen takımdansa bariyer kalkar
    if (s.ball.owner) {
        let owner = s.players.find(p => p.id === s.ball.owner);
        if (owner && owner.team === s.concedingTeam) {
            s.isKickoff = false;
            s.concedingTeam = null;
        }
    } else if (s.ball.vx !== 0 || s.ball.vy !== 0) {
        // Eğer topu gol yiyen takımdan biri vurduysa (kick)
        let lastKicker = s.players.find(p => p.x === s.ball.lastKickX); // Basit kontrol
        // Daha kesin kontrol için son vuran kişiyi de tutabiliriz ama saha içinde zaten top sahibi vuruyor.
        // Eğer top hareketliyse ve sahibi yoksa, muhtemelen gol yiyen takım vurmuştur.
        s.isKickoff = false;
        s.concedingTeam = null;
    }
}

function updateGame(s) {
    try {
        let ball = s.ball;
        if (!ball) return;
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
                    // GOL OLDU!
                    if (hitRightGoal) { s.score.red++; resetBall(s, 'blue'); } // Kırmızı attı, Mavi yedi
                    else { s.score.blue++; resetBall(s, 'red'); } // Mavi attı, Kırmızı yedi
                }
            } else {
                if (ball.x < 20) { ball.x = 20; ball.vx *= -0.8; }
                if (ball.x > width - 20) { ball.x = width - 20; ball.vx *= -0.8; }
            }
        }

        // Otomatik alma (Sadece top boştaysa)
        for (let p of s.players) {
            if (p.team === 'spectator') continue;
            let dist = Math.hypot(p.x - ball.x, p.y - ball.y);
            
            if (dist < 50 && ball.pickupCooldown <= 0 && ball.owner === null) {
                ball.owner = p.id;
                ball.possessionTimer = 150;
                ball.vx = 0; ball.vy = 0; ball.vz = 0;
                ball.shotPower = 0;
                checkKickoff(s);
            }
        }

        io.to(s.id).emit('game_state', s);
    } catch (e) {
        console.log("Hata:", e.message);
    }
}

function resetBall(s, concededBy = null) {
    s.ball = { x: 600, y: 300, z: 0, vx: 0, vy: 0, vz: 0, owner: null, possessionTimer: 0, pickupCooldown: 0, shotPower: 0, lastKickX: 0 };
    
    if (concededBy) {
        s.isKickoff = true;
        s.concedingTeam = concededBy;
        
        for (let p of s.players) {
            if (p.team === 'spectator') continue;
            
            if (p.team === concededBy) {
                // Gol yiyen takım ortaya (topun başına) geçer
                p.x = concededBy === 'red' ? 500 : 700;
                p.y = 300;
            } else {
                // Gol atan takım kendi sahasına çekilir
                p.x = p.team === 'red' ? 200 : 1000;
                p.y = 300;
            }
        }
    } else {
        // Maç başlangıcı
        s.isKickoff = false;
        s.concedingTeam = null;
        for (let p of s.players) {
            if (p.team === 'red') { p.x = 450; p.y = 300; }
            if (p.team === 'blue') { p.x = 750; p.y = 300; }
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log('Sunucu Çalışıyor'); });
