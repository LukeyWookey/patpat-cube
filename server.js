const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');

// Configuration Socket.io (Max buffer 10Mo pour les images)
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e7 
});

app.use(express.static(path.join(__dirname, 'public')));

let players = {};
let currentBackground = null; // Stocke l'image de fond

io.on('connection', (socket) => {
    console.log('Nouveau joueur : ' + socket.id);

    // Création du joueur avec une couleur aléatoire au départ
    players[socket.id] = {
        x: Math.floor(Math.random() * 500) + 50,
        y: Math.floor(Math.random() * 400) + 50,
        color: '#' + Math.floor(Math.random()*16777215).toString(16)
    };

    // Envoyer la liste des joueurs actuels au nouvel arrivant
    socket.emit('currentPlayers', players);
    
    // Si un fond existe déjà, on l'envoie
    if (currentBackground) {
        socket.emit('updateBackground', currentBackground);
    }

    // Prévenir les autres qu'un nouveau joueur est là
    socket.broadcast.emit('newPlayer', { 
        playerId: socket.id, 
        playerInfo: players[socket.id] 
    });

    // --- GESTION DES MOUVEMENTS ---
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

    // --- GESTION DU FOND D'ÉCRAN ---
    socket.on('changeBackground', (imageData) => {
        currentBackground = imageData;
        io.emit('updateBackground', imageData);
    });

    // --- GESTION DE LA COULEUR (NOUVEAU) ---
    socket.on('changeColor', (newColor) => {
        if (players[socket.id]) {
            players[socket.id].color = newColor; // Mise à jour côté serveur
            // On envoie l'info à tout le monde (y compris celui qui a changé)
            io.emit('updatePlayerColor', { 
                id: socket.id, 
                color: newColor 
            });
        }
    });

    // --- DÉCONNEXION ---
    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
        console.log('Joueur déconnecté : ' + socket.id);
    });
});

http.listen(2220, '0.0.0.0', () => {
    console.log('Serveur lancé sur le port 2220');
});