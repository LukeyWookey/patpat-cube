const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');

// Configuration Socket.io
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8
});

app.use(express.static(path.join(__dirname, 'public')));

let players = {};
let currentBackground = null; 
let wolfId = null; 

// Gestion du Cooldown
let lastTagTime = 0;
const TAG_COOLDOWN = 1000; 

io.on('connection', (socket) => {
    console.log('Nouveau joueur : ' + socket.id);

    players[socket.id] = {
        x: Math.floor(Math.random() * 500) + 50,
        y: Math.floor(Math.random() * 400) + 50,
        color: '#' + Math.floor(Math.random()*16777215).toString(16)
    };

    if (!wolfId) {
        wolfId = socket.id;
    }

    socket.emit('currentPlayers', players);
    socket.emit('updateWolf', wolfId);

    if (currentBackground) {
        socket.emit('updateBackground', currentBackground);
    }

    socket.broadcast.emit('newPlayer', { 
        playerId: socket.id, 
        playerInfo: players[socket.id] 
    });

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            socket.broadcast.emit('playerMoved', { 
                playerId: socket.id, 
                x: players[socket.id].x, 
                y: players[socket.id].y 
            });
        }
    });

    // --- GESTION DU LOUP ET DES PARTICULES ---
    socket.on('tagPlayer', (targetId) => {
        if (socket.id === wolfId && players[targetId]) {
            
            const now = Date.now();
            const wolf = players[socket.id];
            const target = players[targetId];
            
            const CUBE_SIZE = 50; 
            const TOLERANCE = 40; 

            const dx = Math.abs(wolf.x - target.x);
            const dy = Math.abs(wolf.y - target.y);

            const isCloseEnough = dx < (CUBE_SIZE + TOLERANCE) && dy < (CUBE_SIZE + TOLERANCE);

            if (isCloseEnough) {
                if (now - lastTagTime > TAG_COOLDOWN) {
                    wolfId = targetId;
                    lastTagTime = now;
                    
                    io.emit('updateWolf', wolfId);

                    // [NOUVEAU] On dit à tout le monde de faire des particules !
                    // On vise le centre du cube cible (x + taille/2)
                    io.emit('playerTagged', {
                        x: target.x + (CUBE_SIZE / 2),
                        y: target.y + (CUBE_SIZE / 2),
                        color: target.color
                    });
                }
            }
        }
    });

    socket.on('changeBackground', (imageData) => {
        currentBackground = imageData;
        io.emit('updateBackground', imageData);
    });

    socket.on('changeColor', (newColor) => {
        if (players[socket.id]) {
            players[socket.id].color = newColor; 
            io.emit('updatePlayerColor', { 
                id: socket.id, 
                color: newColor 
            });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
        
        if (socket.id === wolfId) {
            const ids = Object.keys(players);
            if (ids.length > 0) {
                wolfId = ids[Math.floor(Math.random() * ids.length)];
                io.emit('updateWolf', wolfId);
                lastTagTime = Date.now(); 
            } else {
                wolfId = null;
            }
        }
        console.log('Joueur déconnecté : ' + socket.id);
    });
});

http.listen(2220, '0.0.0.0', () => {
    console.log('Serveur lancé sur le port 2220');
});
